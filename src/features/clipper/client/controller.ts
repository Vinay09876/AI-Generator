/**
 * Clipper client controller (Batch 5): framework-agnostic state machine. The Batch 6 UI binds
 * to it; no React here.
 *
 *   idle → uploading → verifying → submitting → processing → completed | failed
 *                                     ↘ expired (unconfirmed request too old to replay)
 *
 * Safety rules:
 *   - The idempotency key is created exactly once per submission and persisted BEFORE the POST.
 *   - Ambiguous POST outcomes (network error / 5xx) are retried with the SAME key, never a new one.
 *   - recover() replays only within CLIP_REPLAY_WINDOW_MS and never auto-starts a new submission.
 *   - A definitively rejected submission releases its upload reservation (best effort).
 */

import {
  completeUpload as apiCompleteUpload,
  discardUpload as apiDiscardUpload,
  getClipJob as apiGetClipJob,
  postClipJob as apiPostClipJob,
  requestUploadIntent as apiRequestUploadIntent,
  type ClipJobOptions,
  type ClipperApiError,
} from "./api";
import { uploadToSignedUrl as defaultUpload, type UploadOutcome } from "./upload";
import {
  clearPending,
  CLIP_REPLAY_WINDOW_MS,
  newIdempotencyKey,
  readPending,
  writePending,
  type PendingClipRequest,
  type StorageLike,
} from "./pending";
import type { ClipJobView } from "../job-view";

export type ClipperClientState =
  | { phase: "idle" }
  | { phase: "uploading"; progress: number }
  | { phase: "verifying" }
  | { phase: "submitting"; attempt: number }
  | { phase: "processing"; job: ClipJobView | null }
  | { phase: "completed"; job: ClipJobView }
  | { phase: "failed"; error: { code: string; message: string }; job?: ClipJobView }
  | { phase: "expired" };

export interface ClipperControllerDeps {
  userId: string;
  storage: StorageLike | null;
  api?: {
    requestUploadIntent: typeof apiRequestUploadIntent;
    completeUpload: typeof apiCompleteUpload;
    discardUpload: typeof apiDiscardUpload;
    postClipJob: typeof apiPostClipJob;
    getClipJob: typeof apiGetClipJob;
  };
  upload?: typeof defaultUpload;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  newKey?: () => string;
}

export const CLIPPER_CLIENT_POLLING = {
  backoffMs: [3_000, 6_000, 12_000, 30_000] as readonly number[],
  defaultMs: 5_000,
  maxDurationMs: 30 * 60_000,
  maxSubmitAttempts: 4,
} as const;

const AMBIGUOUS = (e: ClipperApiError) => e.code === "NETWORK_ERROR" || e.status === null || e.status >= 500;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export function createClipperController(deps: ClipperControllerDeps) {
  const api = deps.api ?? {
    requestUploadIntent: apiRequestUploadIntent,
    completeUpload: apiCompleteUpload,
    discardUpload: apiDiscardUpload,
    postClipJob: apiPostClipJob,
    getClipJob: apiGetClipJob,
  };
  const upload = deps.upload ?? defaultUpload;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  let state: ClipperClientState = { phase: "idle" };
  const listeners = new Set<(s: ClipperClientState) => void>();
  let run = new AbortController();

  const set = (next: ClipperClientState) => {
    state = next;
    for (const l of listeners) l(state);
  };
  const fail = (code: string, message: string, job?: ClipJobView) => set({ phase: "failed", error: { code, message }, ...(job ? { job } : {}) });
  const busy = () => !["idle", "completed", "failed", "expired"].includes(state.phase);

  async function poll(jobId: string, signal: AbortSignal, record: PendingClipRequest) {
    const started = now();
    let failures = 0;
    while (!signal.aborted) {
      const res = await api.getClipJob(jobId, { signal });
      if (signal.aborted) return;
      if (res.ok) {
        failures = 0;
        const job = res.data.job;
        if (TERMINAL.has(job.status)) {
          clearPending(deps.storage, deps.userId);
          if (job.status === "COMPLETED") set({ phase: "completed", job });
          else fail(job.error?.code ?? "FAILED", job.error?.message ?? "Video clipping failed.", job);
          return;
        }
        set({ phase: "processing", job });
      } else if (res.error.status === 404 || res.error.status === 401) {
        clearPending(deps.storage, deps.userId);
        return fail(res.error.code, res.error.message);
      } else {
        failures++;
      }
      if (now() - started > CLIPPER_CLIENT_POLLING.maxDurationMs) {
        // Keep the pending record so a later reload can resume polling.
        return fail("STATUS_UNKNOWN", "Still processing. Refresh later to check the result.");
      }
      const backoff = CLIPPER_CLIENT_POLLING.backoffMs[Math.min(failures, CLIPPER_CLIENT_POLLING.backoffMs.length) - 1];
      const retryAfter = res.ok ? null : res.error.retryAfterSeconds;
      await sleep(failures > 0 ? Math.max(backoff, (retryAfter ?? 0) * 1000) : CLIPPER_CLIENT_POLLING.defaultMs, signal);
    }
    void record;
  }

  async function submit(record: PendingClipRequest, signal: AbortSignal) {
    for (let attempt = 1; attempt <= CLIPPER_CLIENT_POLLING.maxSubmitAttempts && !signal.aborted; attempt++) {
      if (now() - record.createdAt > CLIP_REPLAY_WINDOW_MS) {
        clearPending(deps.storage, deps.userId);
        return set({ phase: "expired" });
      }
      set({ phase: "submitting", attempt });
      const res = await api.postClipJob(
        { idempotencyKey: record.idempotencyKey, source: record.source, options: record.options, hints: record.hints },
        { signal },
      );
      if (signal.aborted) return;
      if (res.ok) {
        const confirmed: PendingClipRequest = { ...record, jobId: res.data.job.id };
        writePending(deps.storage, deps.userId, confirmed);
        set({ phase: "processing", job: res.data.job });
        if (TERMINAL.has(res.data.job.status)) {
          clearPending(deps.storage, deps.userId);
          return res.data.job.status === "COMPLETED"
            ? set({ phase: "completed", job: res.data.job })
            : fail(res.data.job.error?.code ?? "FAILED", res.data.job.error?.message ?? "Video clipping failed.", res.data.job);
        }
        return poll(res.data.job.id, signal, confirmed);
      }
      if (!AMBIGUOUS(res.error)) {
        // Definitive rejection: no job exists for this key. Release the upload reservation.
        clearPending(deps.storage, deps.userId);
        if (record.source.type === "upload") void api.discardUpload(record.source.uploadKey);
        return fail(res.error.code, res.error.message);
      }
      // Ambiguous: retry with the SAME idempotency key.
      await sleep(CLIPPER_CLIENT_POLLING.backoffMs[Math.min(attempt, CLIPPER_CLIENT_POLLING.backoffMs.length) - 1], signal);
    }
    if (!signal.aborted) {
      // Keep the pending record: a reload within the replay window resolves it safely.
      fail("STATUS_UNKNOWN", "We couldn't confirm your request. Refresh to check its status.");
    }
  }

  return {
    getState: () => state,
    subscribe(listener: (s: ClipperClientState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Upload a local file, verify it, then submit exactly one clip job. */
    async startUpload(input: {
      file: Blob & { type: string; size: number };
      hints: { durationSeconds: number; width?: number; height?: number };
      options: ClipJobOptions;
    }) {
      if (busy()) return;
      run = new AbortController();
      const signal = run.signal;
      set({ phase: "uploading", progress: 0 });

      const intent = await api.requestUploadIntent({ mimeType: input.file.type, sizeBytes: input.file.size }, { signal });
      if (signal.aborted) return;
      if (!intent.ok) return fail(intent.error.code, intent.error.message);
      const { uploadKey, signedUrl, contentType } = intent.data.upload;

      const outcome: UploadOutcome = await upload({
        signedUrl,
        file: input.file,
        contentType,
        signal,
        onProgress: (p) => set({ phase: "uploading", progress: p }),
      });
      if (!outcome.ok) {
        void api.discardUpload(uploadKey);
        if (signal.aborted) return set({ phase: "idle" });
        return fail(outcome.code, "The upload did not complete. Please try again.");
      }

      set({ phase: "verifying" });
      const verified = await api.completeUpload(uploadKey, { signal });
      if (signal.aborted) return;
      if (!verified.ok) {
        void api.discardUpload(uploadKey);
        return fail(verified.error.code, verified.error.message);
      }

      const record: PendingClipRequest = {
        v: 1,
        idempotencyKey: deps.newKey?.() ?? newIdempotencyKey(),
        source: { type: "upload", uploadKey },
        options: input.options,
        hints: input.hints,
        createdAt: now(),
      };
      writePending(deps.storage, deps.userId, record); // persisted BEFORE the POST
      await submit(record, signal);
    },

    /** Clip one of the user's own generated videos (no upload). */
    async startFromAsset(input: { assetId: string; options: ClipJobOptions }) {
      if (busy()) return;
      run = new AbortController();
      const record: PendingClipRequest = {
        v: 1,
        idempotencyKey: deps.newKey?.() ?? newIdempotencyKey(),
        source: { type: "platform_asset", assetId: input.assetId },
        options: input.options,
        createdAt: now(),
      };
      writePending(deps.storage, deps.userId, record);
      await submit(record, run.signal);
    },

    /** Resume after reload. Never creates a new idempotency key. */
    async recover() {
      if (busy()) return;
      const pending = readPending(deps.storage, deps.userId, now());
      if (!pending) return;
      run = new AbortController();
      if (pending.jobId) {
        set({ phase: "processing", job: null });
        return poll(pending.jobId, run.signal, pending);
      }
      if (now() - pending.createdAt > CLIP_REPLAY_WINDOW_MS) {
        clearPending(deps.storage, deps.userId);
        return set({ phase: "expired" });
      }
      return submit(pending, run.signal);
    },

    /** Stops local work (upload / polling). A submitted job keeps running on the server. */
    cancel() {
      run.abort();
      if (state.phase === "uploading" || state.phase === "verifying") set({ phase: "idle" });
    },

    reset() {
      if (busy()) return;
      set({ phase: "idle" });
    },
  };
}

export type ClipperController = ReturnType<typeof createClipperController>;
