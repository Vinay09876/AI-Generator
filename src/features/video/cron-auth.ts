import { timingSafeEqual } from "node:crypto";
import { reconcileStaleVideoJobs } from "@/features/video/lifecycle";
import { processPendingIngestionJobs } from "@/features/video/storage/ingestion";
import type { SupabaseVideoObjectStorage } from "@/features/video/storage/supabase";
import { sweepStaleWebhookEvents } from "@/features/video/webhooks/durable-events";
import { processPendingWebhookBatch } from "@/features/video/webhooks/process-event";

export interface VideoCronContext {
  db?: any;
  storage?: any;
}

export interface VideoCronAuthEnv {
  CRON_SECRET?: string;
  NODE_ENV?: string;
}

/**
 * Authorization for GET /api/cron/video-webhooks.
 *
 * Production FAILS CLOSED: a request is accepted only when CRON_SECRET is configured
 * (non-blank) AND the request carries `Authorization: Bearer <CRON_SECRET>` (timing-safe compare).
 * Outside production the endpoint stays open, preserving the original local-development behavior.
 */
export function isVideoCronRequestAuthorized(request: Request, env: VideoCronAuthEnv): boolean {
  if (env.NODE_ENV !== "production") return true;
  const secret = env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Periodic Webhook Event Reconciliation & Sweeper Endpoint Logic.
 *
 * Provides a reliable, database-backed trigger for processing video webhook events
 * without introducing paid infrastructure (e.g. Redis, BullMQ).
 *
 * Operational Execution Guarantees:
 *   1. Crash Recovery: Sweeps expired webhook leases (PROCESSING events where leaseExpiresAt < now()).
 *   2. Durable Batch Processing: Claims and processes eligible PENDING, expired, and retryable FAILED events.
 *   3. Stale Job Reconciliation: Settles dead video jobs older than 15 minutes and refunds credits.
 *   4. Zero Paid Infrastructure: Invocable via standard Linux crontab, GitHub Actions scheduled workflow,
 *      or free webhook heartbeat (e.g. cron-job.org).
 *   5. Security: In production, requires a configured CRON_SECRET and a matching bearer token
 *      (fails closed when the secret is missing). Open outside production for local development.
 */
export async function handleVideoCronRequest(request: Request, context?: VideoCronContext) {
  // Authorization check — fails closed in production when CRON_SECRET is missing.
  if (!isVideoCronRequestAuthorized(request, { CRON_SECRET: process.env.CRON_SECRET, NODE_ENV: process.env.NODE_ENV })) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = context?.db;
    const storage =
      context?.storage ??
      (((await import("@/features/generations/storage")).getObjectStorage()) as unknown as SupabaseVideoObjectStorage);

    // 1. Recover crashed worker leases
    const sweepResult = await sweepStaleWebhookEvents(db);

    // 2. Process eligible events in batch (with concurrency-safe atomic claims)
    const batchResult = await processPendingWebhookBatch({
      limit: 20,
      storage,
      ...(db ? { db } : {}),
    });

    // 3. Independently discover and ingest ready provider results on GenerationJobs
    const ingestionResult = await processPendingIngestionJobs({
      limit: 20,
      storage,
      ...(db ? { db } : {}),
    });

    // 4. Reconcile stale jobs (distinguishing ordinary stale jobs from ambiguous submissions)
    const staleJobsResult = await reconcileStaleVideoJobs({}, db);

    return Response.json(
      {
        ok: true,
        sweptExpiredLeases: sweepResult.recoveredCount,
        batch: batchResult,
        pendingIngestion: ingestionResult,
        staleJobsSettled: staleJobsResult.settled,
        staleJobsUnresolved: staleJobsResult.unresolved,
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    );
  } catch (err) {
    console.error("[cron-video-webhooks] Error during reconciliation:", err);
    return Response.json(
      {
        error: "Reconciliation failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
