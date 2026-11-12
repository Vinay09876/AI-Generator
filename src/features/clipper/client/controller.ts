/**
 * Clipper client controller (Batch 5, extended in Batch 6): framework-agnostic state machine.
 * The React hook (components/video-clipper/use-clipper.ts) binds to it; no React here.
 *
 *   idle → uploading → verifying → submitting → processing → completed | failed | cancelled
 *                                     ↘ expired (unconfirmed request too old to replay)
 *
 * Safety rules:
 *   - The idempotency key is created exactly once per submission and persisted BEFORE the POST.
 *   - Ambiguous POST outcomes (network error / 5xx) are retried with the SAME key, never a new one.
 *   - recover() replays only within CLIP_REPLAY_WINDOW_MS and never auto-starts a new submission.
 *   - resume(jobId) only polls an existing job: it never POSTs and never creates a key.
 *   - A definitively rejected submission releases its upload reservation (best effort).
 *   - Batch 6 (Fix A): the upload reservation key is persisted the moment it is granted and is
 *     released on every cancellation/failure path before a job exists; an interrupted upload found
 *     on the next page load is released too, unless another tab is still using it.
 */

import { CLIPPER_UPLOAD_ID_RELEASE_DELAY_MS } from "../config";
import {
  cancelClipJob as apiCancelClipJob,
  releasePendingUploads as apiReleasePendingUploads,
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
  clearReservation,
  CLIP_REPLAY_WINDOW_MS,
  newIdempotencyKey,
  newUploadId,
  readPending,
  readReservation,
  reservationKey,
  writePending,
  writeReservation,
  type PendingClipRequest,
  type StorageLike,
  type UploadReservationRecord,
} from "./pending";
import type { UploadTabLock } from "./tab-lock";
import type { ClipJobView } from "../job-view";

export type ClipperClientState =
  | { phase: "idle" }
  | { phase: "uploading"; progress: number }
  | { phase: "verifying" }
  | { phase: "submitting"; attempt: number }
  | { phase: "processing"; job: ClipJobView | null }
  | { phase: "completed"; job: ClipJobView }
  | { phase: "failed"; error: { code: string; message: string }; job?: ClipJobView }
  | { phase: "cancelled"; job: ClipJobView }
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
    cancelClipJob?: typeof apiCancelClipJob;
    releasePendingUploads?: typeof apiReleasePendingUploads;
  };
  upload?: typeof defaultUpload;
  /** Cross-tab upload lock (Web Locks in the browser); null = single-tab assumption. */
  uploadLock?: UploadTabLock | null;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  newKey?: () => string;
  /** Batch 7: browser-chosen upload id generator (tests inject a fixed one). */
  newUploadId?: () => string;
}

export const CLIPPER_CLIENT_POLLING = {
  backoffMs: [3_000, 6_000, 12_000, 30_000] as readonly number[],
  defaultMs: 5_000,
  maxDurationMs: 30 * 60_000,
  maxSubmitAttempts: 4,
} as const;

/** Server answers that are definitive even though they are 5xx (retrying cannot change them). */
const DEFINITIVE_5XX = new Set(["CLIPPER_UNAVAILABLE"]);
const AMBIGUOUS = (e: ClipperApiError) =>
  !DEFINITIVE_5XX.has(e.code) && (e.code === "NETWORK_ERROR" || e.status === null || e.status >= 500);
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
/** Discard answers after which the reservation can never be released by us again. */
const RESERVATION_GONE = new Set(["UPLOAD_NOT_FOUND", "UPLOAD_IN_USE", "INVALID_INPUT", "NOT_FOUND"]);
const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export type CancelQueuedResult = { ok: true } | { ok: false; code: string; message: string };
export type ReleasePendingResult = { ok: true; released: number } | { ok: false; code: string; message: string };

/** Ambiguous reservation requests are retried this many times with the SAME upload id. */
const INTENT_ATTEMPTS = 3;
/** Background releases are never aborted by cancel(); only the delay is awaited. */
const NEVER = new AbortController().signal;

export function createClipperController(deps: ClipperControllerDeps) {
  const api = deps.api ?? {
    requestUploadIntent: apiRequestUploadIntent,
    completeUpload: apiCompleteUpload,
    discardUpload: apiDiscardUpload,
    postClipJob: apiPostClipJob,
    getClipJob: apiGetClipJob,
    cancelClipJob: apiCancelClipJob,
    releasePendingUploads: apiReleasePendingUploads,
  };
  const upload = deps.upload ?? defaultUpload;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const lock = deps.uploadLock ?? null;

  let state: ClipperClientState = { phase: "idle" };
  const listeners = new Set<(s: ClipperClientState) => void>();
  let run = new AbortController();

  const set = (next: ClipperClientState) => {
    state = next;
    for (const l of listeners) l(state);
  };
  const fail = (code: string, message: string, job?: ClipJobView) => set({ phase: "failed", error: { code, message }, ...(job ? { job } : {}) });
  const busy = () => !["idle", "completed", "failed", "cancelled", "expired"].includes(state.phase);

  const settleTerminal = (job: ClipJobView) => {
    if (job.status === "COMPLETED") return set({ phase: "completed", job });
    if (job.status === "CANCELLED") return set({ phase: "cancelled", job });
    return fail(job.error?.code ?? "FAILED", job.error?.message ?? "Video clipping failed.", job);
  };

  /** Releases an upload reservation; clears the local record once it can no longer matter. */
  async function releaseReservation(uploadKey: string): Promise<boolean> {
    const res = await api.discardUpload(uploadKey);
    if (res.ok || RESERVATION_GONE.has(res.error.code)) {
      clearReservation(deps.storage, deps.userId, uploadKey);
      return true;
    }
    return false; // keep the record; the next page load retries
  }

  /**
   * Batch 7: release a reservation whose key the browser never received. Waits until
   * CLIPPER_UPLOAD_ID_RELEASE_DELAY_MS after the request was sent: the server never writes a
   * reservation later than its intent deadline, so this release cannot precede a late write.
   * Skipped while another tab holds the upload lock.
   */
  async function releaseUnconfirmed(rec: UploadReservationRecord): Promise<boolean> {
    if (!rec.uploadId || !rec.mimeType) return false;
    const wait = rec.createdAt + CLIPPER_UPLOAD_ID_RELEASE_DELAY_MS - now();
    if (wait > 0) await sleep(wait, NEVER);
    if (lock && (await lock.isHeld())) return false;
    const res = await api.discardUpload({ uploadId: rec.uploadId, mimeType: rec.mimeType });
    if (res.ok || RESERVATION_GONE.has(res.error.code)) {
      clearReservation(deps.storage, deps.userId, rec.uploadId);
      return true;
    }
    return false;
  }

  async function poll(jobId: string, signal: AbortSignal, record?: PendingClipRequest) {
    const started = now();
    let failures = 0;
    // Only a poll that owns the local pending record may clear it.
    const clearOwned = () => {
      if (record) clearPending(deps.storage, deps.userId);
    };
    while (!signal.aborted) {
      const res = await api.getClipJob(jobId, { signal });
      if (signal.aborted) return;
      if (res.ok) {
        failures = 0;
        const job = res.data.job;
        if (TERMINAL.has(job.status)) {
          clearOwned();
          return settleTerminal(job);
        }
        set({ phase: "processing", job });
      } else if (res.error.status === 404 || res.error.status === 401) {
        clearOwned();
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
  }

  async function submit(record: PendingClipRequest, signal: AbortSignal) {
    const uploadKey = record.source.type === "upload" ? record.source.uploadKey : null;
    for (let attempt = 1; attempt <= CLIPPER_CLIENT_POLLING.maxSubmitAttempts && !signal.aborted; attempt++) {
      if (now() - record.createdAt > CLIP_REPLAY_WINDOW_MS) {
        clearPending(deps.storage, deps.userId);
        // Safe either way: the server refuses to discard an upload that an ACTIVE job uses.
        if (uploadKey) void releaseReservation(uploadKey);
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
        // The upload now belongs to the job (the job's own cleanup deletes it).
        if (uploadKey) clearReservation(deps.storage, deps.userId, uploadKey);
        set({ phase: "processing", job: res.data.job });
        if (TERMINAL.has(res.data.job.status)) {
          clearPending(deps.storage, deps.userId);
          return settleTerminal(res.data.job);
        }
        return poll(res.data.job.id, signal, confirmed);
      }
      if (!AMBIGUOUS(res.error)) {
        // Definitive rejection: no job exists for this key. Release the upload reservation.
        clearPending(deps.storage, deps.userId);
        if (uploadKey) void releaseReservation(uploadKey);
        return fail(res.error.code, res.error.message);
      }
      // Ambiguous: retry with the SAME idempotency key.
      await sleep(CLIPPER_CLIENT_POLLING.backoffMs[Math.min(attempt, CLIPPER_CLIENT_POLLING.backoffMs.length) - 1], signal);
    }
    if (!signal.aborted) {
      // Keep the pending record (and reservation): a reload within the replay window resolves it.
      fail("STATUS_UNKNOWN", "We couldn't confirm your request. Refresh to check its status.");
    }
  }

  async function uploadFlow(input: {
    file: Blob & { type: string; size: number };
    hints: { durationSeconds: number; width?: number; height?: number };
    options: ClipJobOptions;
  }, signal: AbortSignal) {

    // Batch 7: the upload id is chosen here and persisted BEFORE the request, so a reservation
    // granted by the server can always be named again even if its response is lost.
    const uploadId = deps.newUploadId?.() ?? newUploadId();
    const mimeType = input.file.type;
    let sentAt = now();
    let intent: Awaited<ReturnType<typeof api.requestUploadIntent>> | null = null;
    for (let attempt = 1; attempt <= INTENT_ATTEMPTS; attempt++) {
      sentAt = now();
      writeReservation(deps.storage, deps.userId, { v: 1, uploadId, mimeType, createdAt: sentAt });
      intent = await api.requestUploadIntent({ mimeType, sizeBytes: input.file.size, uploadId }, { signal });
      if (intent.ok || signal.aborted || !AMBIGUOUS(intent.error)) break;
      // Ambiguous: retry with the SAME id — the server re-grants the same reservation, never a second.
      if (attempt < INTENT_ATTEMPTS) await sleep(CLIPPER_CLIENT_POLLING.backoffMs[attempt - 1], signal);
    }
    if (!intent || !intent.ok) {
      const error = intent && !intent.ok ? intent.error : { code: "ABORTED", message: "Cancelled.", status: null, retryAfterSeconds: null };
      if (signal.aborted || AMBIGUOUS(error)) {
        // The server may hold a reservation we never heard about: release it by id (delayed).
        void releaseUnconfirmed({ v: 1, uploadId, mimeType, createdAt: sentAt });
      } else {
        clearReservation(deps.storage, deps.userId, uploadId); // definitive rejection: nothing reserved
      }
      if (signal.aborted) return;
      return fail(error.code, error.message);
    }
    const { uploadKey, signedUrl, contentType } = intent.data.upload;
    writeReservation(deps.storage, deps.userId, { v: 1, uploadKey, uploadId, mimeType, createdAt: now() });
    if (signal.aborted) {
      await releaseReservation(uploadKey);
      return;
    }

    const outcome: UploadOutcome = await upload({
      signedUrl,
      file: input.file,
      contentType,
      signal,
      onProgress: (p) => set({ phase: "uploading", progress: p }),
    });
    if (!outcome.ok) {
      await releaseReservation(uploadKey);
      if (signal.aborted) return;
      return fail(outcome.code, "The upload did not complete. Please try again.");
    }

    set({ phase: "verifying" });
    const verified = await api.completeUpload(uploadKey, { signal });
    if (signal.aborted) {
      await releaseReservation(uploadKey);
      return;
    }
    if (!verified.ok) {
      await releaseReservation(uploadKey);
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
      set({ phase: "uploading", progress: 0 }); // busy immediately (double-submit guard)
      if (lock) await lock.run(() => uploadFlow(input, signal));
      else await uploadFlow(input, signal);
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

    /**
     * Resume after reload. Never creates a new idempotency key. Also releases an upload
     * reservation left behind by an interrupted upload (Fix A), unless another tab holds it.
     */
    async recover() {
      if (busy()) return;
      const pending = readPending(deps.storage, deps.userId, now());
      const reservation = readReservation(deps.storage, deps.userId);
      if (reservation && !reservation.uploadKey) {
        // Batch 7: the reservation response never arrived. Release by id once it is safe (background).
        void releaseUnconfirmed(reservation);
      } else if (reservation?.uploadKey) {
        const key = reservation.uploadKey;
        const sameUpload = pending?.source.type === "upload" && pending.source.uploadKey === key;
        if (sameUpload && pending?.jobId) {
          clearReservation(deps.storage, deps.userId, key); // owned by the job
        } else if (!sameUpload && !(lock && (await lock.isHeld()))) {
          await releaseReservation(key);
        }
        // sameUpload without a jobId: the replay below decides (and releases on rejection).
      }
      if (!pending) return;
      if (busy()) return;
      run = new AbortController();
      if (pending.jobId) {
        set({ phase: "processing", job: null });
        return poll(pending.jobId, run.signal, pending);
      }
      if (now() - pending.createdAt > CLIP_REPLAY_WINDOW_MS) {
        clearPending(deps.storage, deps.userId);
        if (pending.source.type === "upload") void releaseReservation(pending.source.uploadKey);
        return set({ phase: "expired" });
      }
      return submit(pending, run.signal);
    },

    /**
     * Follow a job the server reported as active (e.g. created on another device) when there is no
     * local pending record. Read-only: never POSTs, never creates an idempotency key.
     */
    async resume(jobId: string) {
      if (busy() || !JOB_ID_RE.test(jobId)) return;
      run = new AbortController();
      set({ phase: "processing", job: null });
      return poll(jobId, run.signal);
    },

    /**
     * Cancel + refund the current job while it is still QUEUED (Batch 6). If a worker already
     * picked it up, the server answers 409 and polling simply continues.
     */
    async cancelQueued(): Promise<CancelQueuedResult> {
      const job = state.phase === "processing" ? state.job : null;
      if (!job || job.status !== "PENDING") {
        return { ok: false, code: "NOT_CANCELLABLE", message: "Only a queued job can be cancelled." };
      }
      if (!api.cancelClipJob) return { ok: false, code: "NOT_SUPPORTED", message: "Cancelling is not available." };
      const res = await api.cancelClipJob(job.id);
      if (!res.ok) return { ok: false, code: res.error.code, message: res.error.message };
      const next = res.data.job;
      if (TERMINAL.has(next.status)) {
        run.abort();
        clearPending(deps.storage, deps.userId);
        settleTerminal(next);
      }
      return { ok: true };
    },

    /**
     * Batch 7: user-initiated release of every pending upload of this account (another device,
     * cleared browser data). Never touches an upload that an active job uses.
     */
    async releasePending(): Promise<ReleasePendingResult> {
      if (busy()) return { ok: false, code: "BUSY", message: "Wait for the current upload to finish." };
      if (!api.releasePendingUploads) return { ok: false, code: "NOT_SUPPORTED", message: "Not available." };
      const res = await api.releasePendingUploads();
      if (!res.ok) return { ok: false, code: res.error.code, message: res.error.message };
      try {
        deps.storage?.removeItem(reservationKey(deps.userId));
      } catch {
        // ignore
      }
      return { ok: true, released: res.data.released };
    },

    /**
     * Stops local work (upload / submit retries / polling) and returns to idle. A submitted job
     * keeps running on the server; its pending record is kept, so recover() resumes it later.
     * An upload that had not become a job is released by the upload flow itself.
     */
    cancel() {
      run.abort();
      if (busy()) set({ phase: "idle" });
    },

    reset() {
      if (busy()) return;
      set({ phase: "idle" });
    },
  };
}

export type ClipperController = ReturnType<typeof createClipperController>;
