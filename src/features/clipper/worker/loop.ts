/**
 * Clipper worker loop (Batch 5): pickup → processClipperJob, one job at a time.
 *
 * - Picks up only PENDING VIDEO_CLIP jobs (oldest first). PROCESSING jobs with an expired lease
 *   are NOT resumed; reconciliation fails + refunds them (simpler, no partial re-entry).
 * - Exclusivity comes from processClipperJob's atomic markStarted + lease claim: when two
 *   workers race for one job exactly one obtains the lease, the other returns "not_claimed".
 * - stopSignal (first SIGINT/SIGTERM): finish the current job, then exit.
 *   abortSignal (second signal): kill FFmpeg; the job is settled FAILED (WORKER_SHUTDOWN) with a
 *   refund while the lease is still valid.
 * - Sources are streamed from storage into a bounded scratch file exactly once per job.
 */

import { getClipperMaxUploadBytes } from "../config";
import type { ClipperStorage } from "../storage/adapter";
import { createStorageReferenceSource } from "../source";
import { assertSafeIdentifier } from "../storage/keys";
import type { ClipperJobSettings } from "../types";
import { planScenePacingClips } from "./plan-clips";
import { processClipperJob, type ClipperWorkerOutcome, type ProcessClipperJobDeps } from "./process-job";

export interface PendingClipJob {
  id: string;
  userId: string;
  settings: ClipperJobSettings;
}

export interface ClipperWorkerLoopDeps {
  findPendingJobs(limit: number): Promise<PendingClipJob[]>;
  processDeps: Omit<ProcessClipperJobDeps, "abortSignal" | "materializeOptions">;
  storage: Pick<ClipperStorage, "openDownloadStream">;
  /** Optional per-iteration housekeeping (e.g. stale-job reconciliation). Errors are logged. */
  housekeeping?: () => Promise<unknown>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: Pick<Console, "info" | "warn" | "error">;
}

export interface ClipperWorkerLoopOptions {
  once?: boolean;
  idleMs?: number;
  batchSize?: number;
  stopSignal?: AbortSignal;
  abortSignal?: AbortSignal;
}

export interface ClipperWorkerLoopResult {
  iterations: number;
  outcomes: Array<{ jobId: string; status: ClipperWorkerOutcome["status"] | "invalid_settings" | "error" }>;
}

export function isProcessableSettings(s: unknown): s is ClipperJobSettings {
  const v = s as Partial<ClipperJobSettings> | null;
  return Boolean(
    v &&
      typeof v.sourceKey === "string" &&
      (v.sourceType === "upload" || v.sourceType === "platform_asset") &&
      typeof v.requestedClipsCount === "number" &&
      typeof v.targetAspectRatio === "string" &&
      typeof v.targetFraming === "string",
  );
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export async function runClipperWorkerLoop(
  deps: ClipperWorkerLoopDeps,
  options: ClipperWorkerLoopOptions = {},
): Promise<ClipperWorkerLoopResult> {
  const log = deps.log ?? console;
  const sleep = deps.sleep ?? defaultSleep;
  const idleMs = options.idleMs ?? 5_000;
  const result: ClipperWorkerLoopResult = { iterations: 0, outcomes: [] };
  const stopped = () => Boolean(options.stopSignal?.aborted || options.abortSignal?.aborted);

  while (!stopped()) {
    result.iterations++;
    if (deps.housekeeping) {
      try {
        await deps.housekeeping();
      } catch (err) {
        log.error("[clipper-worker] housekeeping failed", { name: (err as Error)?.name });
      }
    }

    let jobs: PendingClipJob[] = [];
    try {
      jobs = await deps.findPendingJobs(options.batchSize ?? 5);
    } catch (err) {
      log.error("[clipper-worker] job pickup query failed", { name: (err as Error)?.name });
    }

    let worked = false;
    for (const job of jobs) {
      if (stopped()) break;
      try {
        assertSafeIdentifier("jobId", job.id);
        assertSafeIdentifier("userId", job.userId);
      } catch {
        result.outcomes.push({ jobId: String(job.id), status: "invalid_settings" });
        continue;
      }
      if (!isProcessableSettings(job.settings)) {
        // Left PENDING; reconciliation fails + refunds it after the queue-wait threshold.
        log.warn("[clipper-worker] skipping job with unprocessable settings", { jobId: job.id });
        result.outcomes.push({ jobId: job.id, status: "invalid_settings" });
        continue;
      }
      const settings = job.settings;
      const maxBytes = getClipperMaxUploadBytes();
      try {
        const outcome = await processClipperJob(
          {
            job: { id: job.id, userId: job.userId, settings },
            source: createStorageReferenceSource(settings.sourceKey, { fileSizeBytes: settings.sourceSizeBytes }),
            planClips: (ctx) => planScenePacingClips(ctx, settings),
          },
          {
            ...deps.processDeps,
            abortSignal: options.abortSignal,
            materializeOptions: {
              maxBytes,
              downloadStreamProvider: (key) => deps.storage.openDownloadStream(key, maxBytes),
            },
          },
        );
        result.outcomes.push({ jobId: job.id, status: outcome.status });
        if (outcome.status !== "not_claimed") {
          worked = true;
          log.info("[clipper-worker] job finished", { jobId: job.id, status: outcome.status });
        }
      } catch (err) {
        // processClipperJob only throws before claiming (e.g. DB unavailable at claim time).
        log.error("[clipper-worker] job errored before claim", { jobId: job.id, name: (err as Error)?.name });
        result.outcomes.push({ jobId: job.id, status: "error" });
      }
      if (worked) break; // re-query after each processed job (fresh ordering, housekeeping)
    }

    if (options.once) break;
    if (!worked) await sleep(idleMs, options.stopSignal);
  }
  return result;
}
