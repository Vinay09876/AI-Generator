/**
 * Clipper maintenance (Batch 5), driven by GET /api/cron/clipper and by the worker loop.
 *
 *   1. Stale-job reconciliation: unclaimed PENDING jobs older than the queue-wait threshold and
 *      PROCESSING jobs whose lease expired are failed + refunded (existing lifecycle function).
 *   2. Cleanup retries: terminal jobs with pending/failed cleanups → retryClipperPendingCleanups.
 *   3. Abandoned-upload sweep: ephemeral uploads older than the TTL that no ACTIVE clip job
 *      references are deleted. Anything uncertain (missing timestamps, listing/DB errors,
 *      foreign or malformed keys) is SKIPPED, never deleted.
 *
 * All phases are bounded per run and isolated: a failure in one phase does not stop the others.
 */

import { timingSafeEqual } from "node:crypto";
import { CLIPPER_MAINTENANCE_LIMITS, CLIPPER_QUEUE_WAIT_STALE_MS, CLIPPER_STORAGE_OP_TIMEOUT_MS, EPHEMERAL_UPLOAD_TTL_SECONDS } from "./config";
import { withStorageTimeout, type ClipperStorage } from "./storage/adapter";
import { isEphemeralUploadKeyOwnedBy, SEGMENT_REGEX } from "./storage/keys";
import { retryClipperPendingCleanups, type ClipperWorkerLifecycle, type ClipperWorkerStorage } from "./worker/process-job";

export interface ClipperMaintenanceDeps {
  reconcileStale(params: { pendingThresholdMs: number }): Promise<{ checked: number; settled: number }>;
  findJobsWithPendingCleanups(limit: number): Promise<string[]>;
  lifecycle: Pick<ClipperWorkerLifecycle, "getCleanupState" | "recordCleanup">;
  storage: Pick<ClipperStorage, "listFolder"> & Pick<ClipperWorkerStorage, "delete">;
  isUploadKeyInActiveJob(key: string): Promise<boolean>;
  now?: () => Date;
  log?: Pick<Console, "error">;
}

export interface SweepResult {
  scannedUsers: number;
  scannedObjects: number;
  deleted: number;
  deleteFailed: number;
  skipped: number;
  listingErrors: number;
  truncated: boolean;
}

export interface MaintenanceSummary {
  stale: { checked: number; settled: number } | { error: string };
  cleanupRetries: { jobs: number; deleted: number; abandoned: number } | { error: string };
  abandonedUploads: SweepResult | { error: string };
}

export async function sweepAbandonedUploads(
  deps: Pick<ClipperMaintenanceDeps, "storage" | "isUploadKeyInActiveJob" | "now">,
  limits: { maxUserFolders?: number; maxDeletes?: number; ttlSeconds?: number; timeoutMs?: number } = {},
): Promise<SweepResult> {
  const now = (deps.now?.() ?? new Date()).getTime();
  const ttlMs = (limits.ttlSeconds ?? EPHEMERAL_UPLOAD_TTL_SECONDS) * 1000;
  const maxUsers = limits.maxUserFolders ?? CLIPPER_MAINTENANCE_LIMITS.sweepUserFolders;
  const maxDeletes = limits.maxDeletes ?? CLIPPER_MAINTENANCE_LIMITS.sweepDeletes;
  const timeoutMs = limits.timeoutMs ?? CLIPPER_STORAGE_OP_TIMEOUT_MS;
  const r: SweepResult = { scannedUsers: 0, scannedObjects: 0, deleted: 0, deleteFailed: 0, skipped: 0, listingErrors: 0, truncated: false };

  const root = await withStorageTimeout("list-root", timeoutMs, deps.storage.listFolder("ephemeral/users", { limit: maxUsers + 1, offset: 0 }));
  const userIds = root.folders.filter((f) => SEGMENT_REGEX.test(f));
  if (userIds.length > maxUsers) r.truncated = true;

  for (const userId of userIds.slice(0, maxUsers)) {
    if (r.deleted + r.deleteFailed >= maxDeletes) {
      r.truncated = true;
      break;
    }
    r.scannedUsers++;
    let listing;
    try {
      listing = await withStorageTimeout("list-user", timeoutMs, deps.storage.listFolder(`ephemeral/users/${userId}/uploads`, { limit: 100, offset: 0 }));
    } catch {
      r.listingErrors++;
      continue;
    }
    for (const obj of listing.objects) {
      if (r.deleted + r.deleteFailed >= maxDeletes) {
        r.truncated = true;
        break;
      }
      r.scannedObjects++;
      const born = obj.createdAt ?? obj.updatedAt;
      if (!isEphemeralUploadKeyOwnedBy(obj.key, userId) || !born || now - born.getTime() <= ttlMs) {
        r.skipped++;
        continue;
      }
      let inUse: boolean;
      try {
        inUse = await deps.isUploadKeyInActiveJob(obj.key);
      } catch {
        r.skipped++; // cannot prove it is unused → keep it
        continue;
      }
      if (inUse) {
        r.skipped++;
        continue;
      }
      try {
        await withStorageTimeout("delete", timeoutMs, deps.storage.delete(obj.key));
        r.deleted++;
      } catch {
        r.deleteFailed++;
      }
    }
  }
  return r;
}

export async function runClipperMaintenance(
  deps: ClipperMaintenanceDeps,
  limits: { cleanupRetryJobs?: number; sweepUserFolders?: number; sweepDeletes?: number } = {},
): Promise<MaintenanceSummary> {
  const log = deps.log ?? console;
  const errName = (e: unknown) => ((e as Error)?.name ?? "Error").slice(0, 60);
  const summary = {} as MaintenanceSummary;

  try {
    summary.stale = await deps.reconcileStale({ pendingThresholdMs: CLIPPER_QUEUE_WAIT_STALE_MS });
  } catch (e) {
    log.error("[clipper-maintenance] stale reconciliation failed", { name: errName(e) });
    summary.stale = { error: errName(e) };
  }

  try {
    const ids = await deps.findJobsWithPendingCleanups(limits.cleanupRetryJobs ?? CLIPPER_MAINTENANCE_LIMITS.cleanupRetryJobs);
    let deleted = 0;
    let abandoned = 0;
    for (const id of ids) {
      try {
        const res = await retryClipperPendingCleanups(id, { lifecycle: deps.lifecycle, storage: deps.storage });
        deleted += res.deleted;
        abandoned += res.abandoned.length;
      } catch (e) {
        log.error("[clipper-maintenance] cleanup retry failed", { jobId: id, name: errName(e) });
      }
    }
    summary.cleanupRetries = { jobs: ids.length, deleted, abandoned };
  } catch (e) {
    log.error("[clipper-maintenance] cleanup query failed", { name: errName(e) });
    summary.cleanupRetries = { error: errName(e) };
  }

  try {
    summary.abandonedUploads = await sweepAbandonedUploads(deps, {
      maxUserFolders: limits.sweepUserFolders,
      maxDeletes: limits.sweepDeletes,
    });
  } catch (e) {
    log.error("[clipper-maintenance] upload sweep failed", { name: errName(e) });
    summary.abandonedUploads = { error: errName(e) };
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Cron authorization (fails CLOSED in production when CRON_SECRET is unset)
// ---------------------------------------------------------------------------
export function isAuthorizedCronRequest(request: Request, env: { CRON_SECRET?: string; NODE_ENV?: string }): boolean {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) return env.NODE_ENV !== "production"; // dev convenience only
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createClipperCronHandler(deps: {
  env: () => { CRON_SECRET?: string; NODE_ENV?: string };
  maintenance: () => ClipperMaintenanceDeps;
}) {
  return async function GET(request: Request): Promise<Response> {
    const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
    if (!isAuthorizedCronRequest(request, deps.env())) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    try {
      const summary = await runClipperMaintenance(deps.maintenance());
      return new Response(JSON.stringify({ ok: true, ...summary, timestamp: new Date().toISOString() }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Maintenance failed", name: (e as Error)?.name ?? "Error" }), { status: 500, headers });
    }
  };
}
