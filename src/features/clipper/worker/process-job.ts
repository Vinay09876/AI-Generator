/**
 * Clipper worker orchestration (Stage 9 Batch 4).
 *
 *   claim lease ─► materialize source ONCE ─► probe ─► plan clips
 *     └─► per clip: fence (renew) ─► render ─► validate ─► thumbnail ─► fence ─► stream upload
 *   ─► fence ─► complete job + register assets (DB-fenced by token & expiry)
 *   ─► source cleanup (ephemeral uploads only) ─► record cleanup outcomes
 *
 * Failure rules:
 *   - Before completion: delete every object this worker uploaded, then settle FAILED via the
 *     lease-fenced failClipperJobFenced (refund). Source cleanup only if THIS worker settled.
 *   - Lease lost: never settle, refund or delete the source. Still delete own uploaded objects
 *     (their keys are unique to this attempt and never registered).
 *   - Ambiguous completion error: re-read the job; if our assets are registered, it completed.
 *     If the state cannot be read, delete NOTHING (the objects may be registered assets).
 *   - Every failed deletion is recorded in settings.pendingCleanups for retry. Cleanup recording
 *     happens after settlement and can never change status, credits or the ledger.
 *   - Rendered video is only ever streamed from disk; engines returning buffers are rejected.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { GenerationStatus } from "@/generated/prisma/client";
import {
  getClipperMaxClipsPerJob,
  MAX_STORED_CLIP_BYTES,
  MAX_STORED_CLIP_THUMBNAIL_BYTES,
} from "../config";
import {
  CLIPPER_INGESTION_LEASE_MS,
  JobNotCompletableError,
  type ClaimClipperLeaseResult,
  type ClipperCleanupResult,
  type CompletedClipAssetInput,
} from "../lifecycle";
import { createLocalFileSource, type MaterializeOptions, type VideoSource } from "../source";
import {
  assertSafeIdentifier,
  buildClipStorageKey,
  buildClipThumbnailKey,
  isClipKeyOwnedBy,
  isClipThumbnailKeyOwnedBy,
  isEphemeralUploadKeyOwnedBy,
  parseClipStorageKey,
} from "../storage/keys";
import type {
  CandidateHighlight,
  ClipperJobSettings,
  ClipRenderResult,
  VideoClipperEngine,
  VideoMetadata,
} from "../types";
import { LeaseKeeper, LeaseLostError } from "./lease";

// ---------------------------------------------------------------------------
// Dependency contracts (injected; production wiring lives in ./wiring.ts)
// ---------------------------------------------------------------------------
export interface ClipperJobCleanupState {
  id: string;
  userId: string;
  status: GenerationStatus | string;
  settings: Partial<ClipperJobSettings>;
  assetKeys: string[];
}

export interface ClipperWorkerLifecycle {
  markStarted(p: { jobId: string; engine: string }): Promise<boolean>;
  claimLease(p: { jobId: string; leaseDurationMs: number }): Promise<ClaimClipperLeaseResult>;
  renewLease(p: { jobId: string; token: string; extensionMs: number }): Promise<boolean>;
  complete(p: {
    jobId: string;
    ingestionToken: string;
    clips: CompletedClipAssetInput[];
    highlights?: CandidateHighlight[];
  }): Promise<{ jobId: string; assetIds: string[] }>;
  failFenced(p: { jobId: string; ingestionToken: string; reason: string }): Promise<{ settled: boolean }>;
  recordCleanup(p: {
    jobId: string;
    results: ClipperCleanupResult[];
    abandonKeys?: { key: string; reason: string }[];
    finalize?: boolean;
  }): Promise<boolean>;
  getCleanupState(jobId: string): Promise<ClipperJobCleanupState | null>;
}

export interface ClipperWorkerStorage {
  putStream(
    key: string,
    stream: NodeJS.ReadableStream,
    options: { contentType: string; maxBytes: number; contentLength: number },
  ): Promise<{ sizeBytes: number }>;
  delete(key: string): Promise<void>;
}

export interface ClipPlanContext {
  source: VideoSource;
  metadata: VideoMetadata;
  engine: VideoClipperEngine;
  signal: AbortSignal;
}

export interface ProcessClipperJobInput {
  job: { id: string; userId: string; settings: ClipperJobSettings };
  /** The job's source. Materialized exactly once by the worker. */
  source: VideoSource;
  /** Pre-selected clips (clip-relative word timings), or use planClips. */
  highlights?: CandidateHighlight[];
  /** Selects clips from the materialized local source (analysis runs under the lease). */
  planClips?: (ctx: ClipPlanContext) => Promise<CandidateHighlight[]>;
}

export interface ProcessClipperJobDeps {
  engine: VideoClipperEngine;
  lifecycle: ClipperWorkerLifecycle;
  storage: ClipperWorkerStorage;
  scratchDir?: string;
  materializeOptions?: MaterializeOptions;
  leaseMs?: number;
  heartbeatMs?: number;
  logger?: Pick<Console, "warn" | "error">;
  /** Hard worker shutdown: aborts FFmpeg; the job is settled FAILED (WORKER_SHUTDOWN) under the lease. */
  abortSignal?: AbortSignal;
}

export type SourceCleanupStatus = "deleted" | "retained_platform_asset" | "pending_retry" | "skipped";

export type ClipperWorkerOutcome =
  | { status: "not_claimed"; reason?: string }
  | { status: "completed"; assetIds: string[]; sourceCleanup: SourceCleanupStatus; pendingCleanupKeys: string[] }
  | { status: "failed"; code: string; sourceCleanup: SourceCleanupStatus; pendingCleanupKeys: string[] }
  | { status: "lease_lost"; code: string; pendingCleanupKeys: string[] }
  | { status: "settlement_unknown"; code: string; uploadedKeys: string[] };

export class ClipperWorkerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ClipperWorkerError";
  }
}

const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Fenced-out completion. Name check guards against duplicated module instances across bundles. */
function isJobNotCompletable(err: unknown): boolean {
  return err instanceof JobNotCompletableError || (err as { name?: unknown })?.name === "JobNotCompletableError";
}

export function toFailureCode(err: unknown): string {
  if (err instanceof LeaseLostError) return "LEASE_LOST";
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && CODE_RE.test(code) ? code : "INTERNAL_ERROR";
}

/** User-visible failure reason. Never includes paths, stderr or provider details. */
export function publicFailureReason(code: string): string {
  return `Video clipping failed (${code}).`;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
async function uploadFromFile(
  storage: ClipperWorkerStorage,
  key: string,
  filePath: string,
  contentType: string,
  maxBytes: number,
  uploaded: string[],
): Promise<number> {
  const stats = await fsp.stat(filePath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
    throw new ClipperWorkerError("UPLOAD_SIZE_INVALID", `Upload size ${stats.size} outside 1..${maxBytes}.`);
  }
  // Track BEFORE the upload starts: a failed/partial upload may still have created the object.
  uploaded.push(key);
  await storage.putStream(key, fs.createReadStream(filePath), {
    contentType,
    maxBytes,
    contentLength: stats.size,
  });
  return stats.size;
}

export async function deleteStorageKeys(
  storage: Pick<ClipperWorkerStorage, "delete">,
  keys: string[],
): Promise<ClipperCleanupResult[]> {
  const results: ClipperCleanupResult[] = [];
  for (const key of keys) {
    try {
      await storage.delete(key);
      results.push({ key, success: true });
    } catch (err) {
      results.push({ key, success: false, error: toFailureCode(err) });
    }
  }
  return results;
}

/** Only an ephemeral upload owned by the job owner may ever be deleted as a "source". */
export function isDeletableSourceKey(settings: Partial<ClipperJobSettings>, userId: string): boolean {
  return (
    settings.sourceType === "upload" &&
    typeof settings.sourceKey === "string" &&
    isEphemeralUploadKeyOwnedBy(settings.sourceKey, userId)
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
export async function processClipperJob(
  input: ProcessClipperJobInput,
  deps: ProcessClipperJobDeps,
): Promise<ClipperWorkerOutcome> {
  const { job } = input;
  assertSafeIdentifier("jobId", job.id);
  assertSafeIdentifier("userId", job.userId);
  const log = deps.logger ?? console;
  const leaseMs = deps.leaseMs ?? CLIPPER_INGESTION_LEASE_MS;

  await deps.lifecycle.markStarted({ jobId: job.id, engine: deps.engine.name });
  const claim = await deps.lifecycle.claimLease({ jobId: job.id, leaseDurationMs: leaseMs });
  if (!claim.claimed || !claim.token) return { status: "not_claimed", reason: claim.reason };
  const token = claim.token;

  const lease = new LeaseKeeper({
    leaseMs,
    intervalMs: deps.heartbeatMs,
    renew: () => deps.lifecycle.renewLease({ jobId: job.id, token, extensionMs: leaseMs }),
    externalSignal: deps.abortSignal,
  });
  lease.start();

  const uploaded: string[] = [];
  const scratchDir = deps.scratchDir ?? os.tmpdir();
  let materialized: Awaited<ReturnType<VideoSource["materialize"]>> | null = null;

  /** Best-effort recording; never alters settlement. */
  const record = async (results: ClipperCleanupResult[]) => {
    if (results.length === 0) return;
    try {
      await deps.lifecycle.recordCleanup({ jobId: job.id, results });
    } catch {
      log.error("[clipper-worker] failed to record cleanup results", { jobId: job.id, keys: results.filter((r) => !r.success).length });
    }
  };

  const cleanupSource = async (): Promise<{ status: SourceCleanupStatus; failed: string[] }> => {
    if (job.settings.sourceType === "platform_asset") return { status: "retained_platform_asset", failed: [] };
    if (!isDeletableSourceKey(job.settings, job.userId)) return { status: "skipped", failed: [] };
    const results = await deleteStorageKeys(deps.storage, [job.settings.sourceKey]);
    await record(results);
    const failed = results.filter((r) => !r.success).map((r) => r.key);
    return { status: failed.length ? "pending_retry" : "deleted", failed };
  };

  const deleteUploaded = async (): Promise<string[]> => {
    const results = await deleteStorageKeys(deps.storage, [...uploaded]);
    await record(results);
    return results.filter((r) => !r.success).map((r) => r.key);
  };

  try {
    // ---- Render phase ------------------------------------------------------
    let completedClips: CompletedClipAssetInput[];
    let highlights: CandidateHighlight[];
    try {
      materialized = await input.source.materialize({ scratchDir, ...deps.materializeOptions });
      const local = createLocalFileSource(materialized.localPath, { fileSizeBytes: input.source.fileSizeBytes });

      lease.assertHeld();
      lease.assertRunning();
      const metadata = await deps.engine.extractMetadata(local);

      const planned = input.highlights ?? (input.planClips
        ? await input.planClips({ source: local, metadata, engine: deps.engine, signal: lease.signal })
        : []);
      const required = Math.min(job.settings.requestedClipsCount, getClipperMaxClipsPerJob());
      // Credits were debited for exactly `required` clips; partial delivery is not supported.
      if (planned.length < required) {
        throw new ClipperWorkerError("INSUFFICIENT_HIGHLIGHTS", `Planned ${planned.length} of ${required} clips.`);
      }
      highlights = planned.slice(0, required);

      const burnSubtitles = job.settings.burnSubtitles && !job.settings.isVisualOnly && metadata.hasAudio;
      completedClips = [];

      for (let i = 0; i < highlights.length; i++) {
        const h = highlights[i];
        lease.assertRunning();
        await lease.renewNow(); // fence before each clip

        const result: ClipRenderResult = await deps.engine.renderClip({
          jobId: job.id,
          userId: job.userId,
          clipIndex: i,
          source: local,
          sourceMetadata: metadata,
          startTime: h.startTime,
          endTime: h.endTime,
          aspectRatio: job.settings.targetAspectRatio,
          framing: job.settings.targetFraming,
          burnSubtitles,
          words: h.words,
          title: h.title,
          signal: lease.signal,
          scratchDir,
        });

        try {
          if (!result.videoFilePath || result.videoBuffer || result.thumbnailBuffer) {
            throw new ClipperWorkerError("ENGINE_OUTPUT_NOT_FILE", "Engine must return file paths, not buffers.");
          }
          if (result.isMockOutput) {
            throw new ClipperWorkerError("MOCK_OUTPUT_REFUSED", "Mock engine output cannot be stored as a user asset.");
          }
          assertSafeIdentifier("clipId", result.clipId);

          const storageKey = buildClipStorageKey({ userId: job.userId, jobId: job.id, clipId: result.clipId });
          const thumbnailKey = result.thumbnailFilePath
            ? buildClipThumbnailKey({ userId: job.userId, jobId: job.id, clipId: result.clipId })
            : null;

          await lease.renewNow(); // fence before writing to storage
          const sizeBytes = await uploadFromFile(deps.storage, storageKey, result.videoFilePath, "video/mp4", MAX_STORED_CLIP_BYTES, uploaded);
          if (thumbnailKey && result.thumbnailFilePath) {
            await uploadFromFile(deps.storage, thumbnailKey, result.thumbnailFilePath, "image/webp", MAX_STORED_CLIP_THUMBNAIL_BYTES, uploaded);
          }

          completedClips.push({
            clipId: result.clipId,
            assetId: crypto.randomUUID(),
            userId: job.userId,
            storageKey,
            thumbnailKey,
            mimeType: "video/mp4",
            width: result.width,
            height: result.height,
            durationSeconds: result.durationSeconds,
            sizeBytes,
            aspectRatio: job.settings.targetAspectRatio,
            title: h.title,
          });
        } finally {
          await result.cleanup?.();
        }
      }

      await lease.renewNow(); // final fence before settlement
      lease.stop();
    } catch (err) {
      lease.stop();
      const code = lease.lost ? "LEASE_LOST" : lease.shuttingDown ? "WORKER_SHUTDOWN" : toFailureCode(err);
      const pendingUploads = await deleteUploaded();

      if (lease.lost) {
        return { status: "lease_lost", code, pendingCleanupKeys: pendingUploads };
      }

      let settled: boolean;
      try {
        ({ settled } = await deps.lifecycle.failFenced({ jobId: job.id, ingestionToken: token, reason: publicFailureReason(code) }));
      } catch {
        log.error("[clipper-worker] fenced failure settlement errored", { jobId: job.id, code });
        return { status: "settlement_unknown", code, uploadedKeys: [] };
      }
      if (!settled) {
        // Lease was taken over or expired between the last fence and settlement.
        return { status: "lease_lost", code, pendingCleanupKeys: pendingUploads };
      }
      const source = await cleanupSource();
      return { status: "failed", code, sourceCleanup: source.status, pendingCleanupKeys: [...pendingUploads, ...source.failed] };
    }

    // ---- Settlement phase --------------------------------------------------
    let assetIds: string[];
    try {
      ({ assetIds } = await deps.lifecycle.complete({
        jobId: job.id,
        ingestionToken: token,
        clips: completedClips,
        highlights,
      }));
    } catch (err) {
      if (isJobNotCompletable(err)) {
        // Fenced out: another holder / expiry / already settled. Our objects were never registered.
        const pendingUploads = await deleteUploaded();
        return { status: "lease_lost", code: "LEASE_LOST", pendingCleanupKeys: pendingUploads };
      }

      // Ambiguous (e.g. connection dropped around COMMIT). Determine the truth before deleting.
      let state: ClipperJobCleanupState | null = null;
      try {
        state = await deps.lifecycle.getCleanupState(job.id);
      } catch {
        state = null;
      }
      if (!state) {
        log.error("[clipper-worker] completion outcome unknown; retaining uploaded objects", { jobId: job.id });
        return { status: "settlement_unknown", code: "COMPLETION_AMBIGUOUS", uploadedKeys: [...uploaded] };
      }
      const registered = new Set(state.assetKeys);
      const ours = completedClips.map((c) => c.storageKey);
      if (state.status === GenerationStatus.COMPLETED && ours.every((k) => registered.has(k))) {
        const source = await cleanupSource();
        return {
          status: "completed",
          assetIds: completedClips.map((c) => c.assetId!),
          sourceCleanup: source.status,
          pendingCleanupKeys: source.failed,
        };
      }

      // Rolled back: none of our objects are registered.
      const pendingUploads = await deleteUploaded();
      if (state.status !== GenerationStatus.PROCESSING) {
        return { status: "lease_lost", code: "COMPLETION_FAILED", pendingCleanupKeys: pendingUploads };
      }
      let settled = false;
      try {
        ({ settled } = await deps.lifecycle.failFenced({
          jobId: job.id,
          ingestionToken: token,
          reason: publicFailureReason("COMPLETION_FAILED"),
        }));
      } catch {
        return { status: "settlement_unknown", code: "COMPLETION_FAILED", uploadedKeys: [] };
      }
      if (!settled) return { status: "lease_lost", code: "COMPLETION_FAILED", pendingCleanupKeys: pendingUploads };
      const source = await cleanupSource();
      return {
        status: "failed",
        code: "COMPLETION_FAILED",
        sourceCleanup: source.status,
        pendingCleanupKeys: [...pendingUploads, ...source.failed],
      };
    }

    // Completed: the source is no longer needed.
    const source = await cleanupSource();
    return { status: "completed", assetIds, sourceCleanup: source.status, pendingCleanupKeys: source.failed };
  } finally {
    lease.stop();
    if (materialized) {
      try {
        await materialized.cleanup();
      } catch {
        log.warn("[clipper-worker] local source scratch cleanup failed", { jobId: job.id });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Retry sweep for recorded pending cleanups
// ---------------------------------------------------------------------------
const TERMINAL = new Set<string>([GenerationStatus.COMPLETED, GenerationStatus.FAILED, GenerationStatus.CANCELLED]);

/**
 * Retries deletions recorded in settings.pendingCleanups for ONE terminal job.
 * Deletes only keys that are (a) this job's ephemeral source upload, or (b) clip/thumbnail keys
 * under this job's namespace that are NOT registered GeneratedAssets. Anything else is left alone.
 */
/** Failed automatic deletion attempts per key before it is handed to manual review. */
export const MAX_CLEANUP_ATTEMPTS_PER_KEY = 10;

export async function retryClipperPendingCleanups(
  jobId: string,
  deps: { lifecycle: Pick<ClipperWorkerLifecycle, "getCleanupState" | "recordCleanup">; storage: Pick<ClipperWorkerStorage, "delete"> },
): Promise<{ attempted: number; deleted: number; skipped: string[]; abandoned: string[] }> {
  const state = await deps.lifecycle.getCleanupState(jobId);
  if (!state || !TERMINAL.has(String(state.status))) return { attempted: 0, deleted: 0, skipped: [], abandoned: [] };

  const pendingKeys = state.settings.pendingCleanups ?? [];
  if (pendingKeys.length === 0) {
    // Stale "pending"/"failed" status with nothing left: settle the status so the sweep moves on.
    await deps.lifecycle.recordCleanup({ jobId, results: [], finalize: true });
    return { attempted: 0, deleted: 0, skipped: [], abandoned: [] };
  }

  const failures = new Map<string, number>();
  for (const a of state.settings.cleanupAudit ?? []) {
    if (!a.success) failures.set(a.key, (failures.get(a.key) ?? 0) + 1);
  }

  const registered = new Set(state.assetKeys);
  const eligible: string[] = [];
  const skipped: string[] = [];
  const abandonKeys: { key: string; reason: string }[] = [];
  for (const key of pendingKeys) {
    const isSource = key === state.settings.sourceKey && isDeletableSourceKey(state.settings, state.userId);
    const parsed = parseClipStorageKey(key);
    const isOwnOutput =
      parsed !== null &&
      parsed.jobId === state.id &&
      (isClipKeyOwnedBy(key, state.userId) || isClipThumbnailKeyOwnedBy(key, state.userId)) &&
      !registered.has(key);
    if (!isSource && !isOwnOutput) {
      skipped.push(key);
      abandonKeys.push({ key, reason: "INELIGIBLE" });
    } else if ((failures.get(key) ?? 0) >= MAX_CLEANUP_ATTEMPTS_PER_KEY) {
      abandonKeys.push({ key, reason: "ATTEMPT_CAP" });
    } else {
      eligible.push(key);
    }
  }

  const results = await deleteStorageKeys(deps.storage, eligible);
  if (results.length || abandonKeys.length) await deps.lifecycle.recordCleanup({ jobId, results, abandonKeys });
  return {
    attempted: results.length,
    deleted: results.filter((r) => r.success).length,
    skipped,
    abandoned: abandonKeys.map((a) => a.key),
  };
}
