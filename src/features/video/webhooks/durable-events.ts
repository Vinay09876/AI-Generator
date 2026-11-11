import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { WebhookEventStatus } from "@/generated/prisma/client";

export const DEFAULT_WEBHOOK_LEASE_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_WEBHOOK_DELIVERY_ATTEMPTS = 5;
export const WEBHOOK_RETRY_BASE_BACKOFF_MS = 15_000; // 15 seconds

/**
 * Calculates bounded exponential backoff delay for retrying failed webhook deliveries:
 * - Attempt 1: 15s
 * - Attempt 2: 30s
 * - Attempt 3: 60s
 * - Attempt 4: 120s
 * Capped at 5 minutes.
 */
export function getWebhookRetryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const backoff = WEBHOOK_RETRY_BASE_BACKOFF_MS * Math.pow(2, attempts - 1);
  return Math.min(backoff, 5 * 60 * 1000);
}

export interface PersistWebhookEventParams {
  provider: string;
  eventId: string;
  jobId?: string | null;
  payload: unknown;
  db?: typeof prisma;
}

export interface ClaimWebhookEventResult {
  acquired: boolean;
  processingToken: string | null;
  event: any | null;
}

/**
 * Durably persists a verified webhook event before returning an HTTP ACK.
 * Idempotent: duplicate deliveries with the same eventId (e.g. Fal.ai request_id)
 * return the existing row without creating duplicate events or failing.
 */
export async function persistVerifiedWebhookEvent(
  params: PersistWebhookEventParams,
): Promise<{ persisted: boolean; event: any }> {
  const { provider, eventId, jobId = null, payload, db = prisma } = params;

  // Use raw upsert / transaction to guarantee atomic deduplication
  const event = await db.providerWebhookEvent.upsert({
    where: { eventId },
    create: {
      provider,
      eventId,
      jobId,
      payload: payload as any,
      status: WebhookEventStatus.PENDING,
    },
    update: {
      // If jobId was missing previously and now discovered, update it
      ...(jobId ? { jobId } : {}),
    },
  });

  return { persisted: true, event };
}

/**
 * Atomically claims a webhook event for background ingestion.
 * Guards against concurrent workers, respects bounded retry backoffs on FAILED events,
 * and recovers from previous worker crashes if the lease expired.
 */
export async function claimWebhookEvent(
  eventId: string,
  leaseDurationMs = DEFAULT_WEBHOOK_LEASE_MS,
  db: typeof prisma = prisma,
): Promise<ClaimWebhookEventResult> {
  const token = `wtoken-${randomUUID()}`;
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<any[]>`
      UPDATE "ProviderWebhookEvent"
      SET "status" = 'PROCESSING',
          "processingToken" = ${token},
          "leaseExpiresAt" = ${leaseExpiresAt},
          "attempts" = "attempts" + 1,
          "updatedAt" = now()
      WHERE "eventId" = ${eventId}
        AND (
          "status" = 'PENDING'
          OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now())
          OR ("status" = 'FAILED' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now()))
        )
        AND "attempts" < ${MAX_WEBHOOK_DELIVERY_ATTEMPTS}
      RETURNING *`;

    if (rows.length === 0) {
      return { acquired: false, processingToken: null, event: null };
    }

    return { acquired: true, processingToken: token, event: rows[0] };
  });
}

/**
 * Settles a webhook event after processing completion or failure.
 * Clears active processing token.
 * On failure, schedules the next retry delay using bounded exponential backoff.
 */
export async function settleWebhookEvent(params: {
  eventId: string;
  processingToken: string;
  status: "PROCESSED" | "FAILED";
  error?: string | null;
  db?: typeof prisma;
}): Promise<boolean> {
  const { eventId, processingToken, status, error = null, db = prisma } = params;

  const targetStatus =
    status === "PROCESSED" ? WebhookEventStatus.PROCESSED : WebhookEventStatus.FAILED;

  let nextLeaseExpiry: Date | null = null;
  if (targetStatus === WebhookEventStatus.FAILED) {
    const existing = await db.providerWebhookEvent.findUnique({
      where: { eventId },
      select: { attempts: true },
    });
    const attempts = existing?.attempts ?? 1;
    const backoffMs = getWebhookRetryBackoffMs(attempts);
    nextLeaseExpiry = new Date(Date.now() + backoffMs);
  }

  const result = await db.providerWebhookEvent.updateMany({
    where: {
      eventId,
      status: WebhookEventStatus.PROCESSING,
      processingToken,
    },
    data: {
      status: targetStatus,
      processingToken: null,
      leaseExpiresAt: nextLeaseExpiry,
      lastError: error,
    },
  });

  return result.count > 0;
}

/**
 * Resets an exhausted failed event (attempts >= 5) so it can be re-evaluated
 * by an operator or manual administrative replay.
 */
export async function resetExhaustedWebhookEvent(
  eventId: string,
  db: typeof prisma = prisma,
): Promise<boolean> {
  const result = await db.providerWebhookEvent.updateMany({
    where: { eventId },
    data: {
      status: WebhookEventStatus.PENDING,
      attempts: 0,
      processingToken: null,
      leaseExpiresAt: null,
      lastError: null,
    },
  });
  return result.count > 0;
}

/**
 * Sweeps expired webhook leases (crash recovery).
 * Resets stuck PROCESSING events where leaseExpiresAt < now() back to PENDING.
 */
export async function sweepStaleWebhookEvents(
  db: typeof prisma = prisma,
): Promise<{ recoveredCount: number }> {
  const result = await db.providerWebhookEvent.updateMany({
    where: {
      status: WebhookEventStatus.PROCESSING,
      leaseExpiresAt: { lt: new Date() },
      attempts: { lt: MAX_WEBHOOK_DELIVERY_ATTEMPTS },
    },
    data: {
      status: WebhookEventStatus.PENDING,
      processingToken: null,
      leaseExpiresAt: null,
    },
  });

  return { recoveredCount: result.count };
}

