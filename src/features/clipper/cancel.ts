/**
 * User cancellation of a queued clip job (Batch 6).
 *
 * 1. Database (atomic, owner-checked, lease-aware): cancelQueuedClipperJobForUser — PENDING only,
 *    never claimed; refund through the idempotent ledger in the same transaction.
 * 2. Only when THIS call won the transition: best-effort deletion of the user's own ephemeral
 *    upload so the one-pending-upload slot is freed immediately. The outcome is recorded on the job;
 *    a failed or unrecorded deletion stays in pendingCleanups (set at job creation) and is retried
 *    by the maintenance cron. A loser of the race deletes nothing.
 */

import { CLIPPER_STORAGE_OP_TIMEOUT_MS } from "./config";
import type { CancelQueuedClipperJobResult, ClipperCleanupResult } from "./lifecycle";
import { withStorageTimeout } from "./storage/adapter";
import { isEphemeralUploadKeyOwnedBy, SEGMENT_REGEX } from "./storage/keys";
import type { ClipperJobSettings } from "./types";

export interface CancelQueuedClipJobDeps {
  cancelInDb(params: { jobId: string; userId: string }): Promise<CancelQueuedClipperJobResult>;
  storage: { delete(key: string): Promise<void> };
  recordCleanup(params: { jobId: string; results: ClipperCleanupResult[] }): Promise<unknown>;
  storageTimeoutMs?: number;
  log?: { error(message: string, data?: Record<string, unknown>): void };
}

export type CancelQueuedClipJobOutcome =
  | { outcome: "cancelled"; refunded: boolean; sourceCleanup: "deleted" | "pending_retry" | "not_applicable" }
  | { outcome: "not_found" }
  | { outcome: "not_cancellable"; status: string };

export async function cancelQueuedClipJob(
  deps: CancelQueuedClipJobDeps,
  params: { userId: string; jobId: string },
): Promise<CancelQueuedClipJobOutcome> {
  const { userId, jobId } = params;
  if (!SEGMENT_REGEX.test(jobId)) return { outcome: "not_found" };

  const result = await deps.cancelInDb({ jobId, userId });
  if (!result.settled) {
    return result.currentStatus === null ? { outcome: "not_found" } : { outcome: "not_cancellable", status: result.currentStatus };
  }

  const refunded = Boolean(result.refund && (result.refund as { refunded?: boolean }).refunded);
  const settings = (result.settings ?? {}) as Partial<ClipperJobSettings>;
  const key = settings.sourceKey;
  if (settings.sourceType !== "upload" || typeof key !== "string" || !isEphemeralUploadKeyOwnedBy(key, userId)) {
    return { outcome: "cancelled", refunded, sourceCleanup: "not_applicable" };
  }

  let cleanup: ClipperCleanupResult;
  try {
    await withStorageTimeout("delete", deps.storageTimeoutMs ?? CLIPPER_STORAGE_OP_TIMEOUT_MS, deps.storage.delete(key));
    cleanup = { key, success: true };
  } catch (error) {
    cleanup = { key, success: false, error: (error as { name?: string } | null)?.name ?? "DELETE_FAILED" };
  }
  try {
    await deps.recordCleanup({ jobId, results: [cleanup] });
  } catch {
    deps.log?.error("cancel: failed to record source cleanup", { jobId });
  }
  return { outcome: "cancelled", refunded, sourceCleanup: cleanup.success ? "deleted" : "pending_retry" };
}
