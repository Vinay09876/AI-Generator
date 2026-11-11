import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  claimVideoIngestionLease,
  failVideoJob,
  recordVideoProviderResult,
} from "../lifecycle";
import { ingestVideoOutput } from "../storage/ingestion";
import type { VideoThumbnailExtractor } from "../storage/thumbnail";
import type { VideoObjectStorage } from "../storage/types";
import {
  claimWebhookEvent,
  settleWebhookEvent,
} from "./durable-events";
import { verifyWebhookCorrelationToken } from "./correlation";

export interface ProcessWebhookEventParams {
  eventId: string;
  storage: VideoObjectStorage;
  thumbnailExtractor?: VideoThumbnailExtractor;
  db?: typeof prisma;
}

export interface ProcessWebhookEventResult {
  processed: boolean;
  jobId?: string;
  assetId?: string;
  reason?: string;
}

/**
 * Orchestrates background event processing for durably persisted webhook events:
 *   1. Atomically claims the webhook event lease (guards against duplicate workers).
 *   2. Correlates the provider event ID (request_id) with the corresponding GenerationJob.
 *   3. Records the provider payload into job settings.
 *   4. On success (status OK):
 *      - Claims the job ingestion lease.
 *      - Streams video from provider output directly to Supabase Storage with SSRF connection pinning.
 *      - Extracts and persists the WebP thumbnail poster frame.
 *      - Finalizes job status to COMPLETED and registers the GeneratedAsset atomically.
 *   5. On error (status ERROR):
 *      - Safely transitions job to FAILED and triggers dynamic ledger refund.
 *      - Invariant: A late failure event will match 0 rows and CANNOT refund a completed job.
 *   6. Settles the webhook event record to PROCESSED.
 *   7. Crash recovery: If a worker terminates mid-ingestion, the event lease expires and can be re-claimed.
 */
export async function processVideoWebhookEvent(
  params: ProcessWebhookEventParams,
): Promise<ProcessWebhookEventResult> {
  const { eventId, storage, thumbnailExtractor, db = prisma } = params;

  // 1. Claim the webhook event lease
  const claim = await claimWebhookEvent(eventId, undefined, db);
  if (!claim.acquired || !claim.event || !claim.processingToken) {
    return { processed: false, reason: "ALREADY_CLAIMED_OR_SETTLED" };
  }

  const { event, processingToken } = claim;

  try {
    const payload = (event.payload || {}) as {
      request_id?: string;
      status?: string;
      error?: string;
      payload?: {
        video?: { url?: string; thumbnail_url?: string };
        thumbnail?: { url?: string };
      };
    };

    const bodyRequestId = (payload.request_id || eventId).trim();

    // 2. Correlate with GenerationJob
    // Priority A: Match by providerJobId = bodyRequestId
    let job = await db.generationJob.findFirst({
      where: {
        provider: "fal-ai",
        providerJobId: bodyRequestId,
      },
      select: {
        id: true,
        userId: true,
        status: true,
        providerJobId: true,
        settings: true,
      },
    });

    // Priority B: Match by event.jobId (query parameter recovery from ambiguous submission)
    if (!job && event.jobId) {
      const candidateJob = await db.generationJob.findFirst({
        where: {
          id: event.jobId,
          provider: "fal-ai",
        },
        select: {
          id: true,
          userId: true,
          status: true,
          providerJobId: true,
          settings: true,
        },
      });

      if (candidateJob) {
        // Enforce correlation token verification:
        // Must match token generated during submission attempt and stored on candidateJob.settings.submission
        const payloadCorrelationToken =
          typeof (event.payload as any)?._correlationToken === "string"
            ? (event.payload as any)._correlationToken
            : null;
        const jobSubmission = (candidateJob.settings as any)?.submission;
        const jobCorrelationToken =
          typeof jobSubmission?.correlationToken === "string"
            ? jobSubmission.correlationToken
            : null;
        const submissionAttempt =
          typeof jobSubmission?.token === "string"
            ? jobSubmission.token
            : null;

        let tokenValid = false;
        if (payloadCorrelationToken && jobCorrelationToken && submissionAttempt) {
          const verified = verifyWebhookCorrelationToken({
            token: payloadCorrelationToken,
            jobId: candidateJob.id,
            provider: "fal-ai",
            submissionAttempt,
          });
          const tokensMatch =
            payloadCorrelationToken.length === jobCorrelationToken.length &&
            crypto.timingSafeEqual(
              Buffer.from(payloadCorrelationToken),
              Buffer.from(jobCorrelationToken),
            );
          tokenValid = verified && tokensMatch;
        }

        if (tokenValid) {
          job = candidateJob;
          // If job was found via event.jobId and had missing providerJobId, backfill it
          if (!job.providerJobId) {
            await db.generationJob.update({
              where: { id: job.id },
              data: { providerJobId: bodyRequestId },
            });
            job.providerJobId = bodyRequestId;
          }
        } else {
          console.warn(
            `[webhook-process] Correlation token rejected for event ${eventId} on candidate job ${candidateJob.id}`,
          );
        }
      }
    }

    if (!job) {
      await settleWebhookEvent({
        eventId,
        processingToken,
        status: "FAILED",
        error: `No GenerationJob found matching providerJobId: ${bodyRequestId}`,
        db,
      });
      return { processed: false, reason: "JOB_NOT_FOUND" };
    }

    // Guard against post-terminal jobs: if already COMPLETED, FAILED, or CANCELLED,
    // settle webhook event to PROCESSED without creating duplicate assets or issuing refunds.
    if (job.status !== "PROCESSING") {
      await settleWebhookEvent({
        eventId,
        processingToken,
        status: "PROCESSED",
        db,
      });
      return { processed: true, jobId: job.id, reason: "JOB_ALREADY_TERMINAL" };
    }

    // 3. Atomically record provider result into job settings
    await recordVideoProviderResult(job.id, payload, db);

    // 4. Handle Failure Outcome
    if (payload.status === "ERROR" || !payload.payload?.video?.url) {
      const reason = payload.error || "Fal.ai generation reported failure.";
      await failVideoJob(job.id, reason, db);

      await settleWebhookEvent({
        eventId,
        processingToken,
        status: "PROCESSED",
        error: reason,
        db,
      });

      return { processed: true, jobId: job.id, reason: "JOB_FAILED" };
    }

    // 5. Handle Success Outcome: Acquire Ingestion Lease on Job
    const lease = await claimVideoIngestionLease({ jobId: job.id }, db);
    if (!lease.claimed || !lease.token) {
      // Job is no longer in PROCESSING or lease held by concurrent worker
      await settleWebhookEvent({
        eventId,
        processingToken,
        status: "PROCESSED",
        db,
      });
      return { processed: true, jobId: job.id, reason: "JOB_ALREADY_SETTLED_OR_LEASE_HELD" };
    }

    const videoUrl = payload.payload.video.url;
    const posterUrl = payload.payload.thumbnail?.url ?? payload.payload.video.thumbnail_url ?? null;

    // 6. Ingest video asset directly into private storage
    const ingestResult = await ingestVideoOutput({
      jobId: job.id,
      userId: job.userId,
      ingestionToken: lease.token,
      videoUrl,
      posterUrl,
      width: 1280,
      height: 720,
      durationSeconds: 5,
      storage,
      thumbnailExtractor,
      db,
    });

    // 6b. If this was an ambiguous/unresolved job, record resolution audit trail
    const currentSettings = (job.settings as Record<string, unknown> | null) ?? {};
    const submission = (currentSettings.submission as Record<string, unknown> | null) ?? {};
    if (submission.state === "ambiguous") {
      try {
        await db.generationJob.update({
          where: { id: job.id },
          data: {
            settings: {
              ...currentSettings,
              submission: {
                ...submission,
                state: "submitted",
                unresolved: false,
                reviewStatus: "resolved_completed",
              },
              resolution: {
                resolvedBy: "delayed_webhook",
                action: "complete",
                reason: "Late valid webhook received and verified",
                resolvedAt: new Date().toISOString(),
              },
            },
          },
        });
      } catch {
        // Non-fatal audit log update; core asset ingestion is already complete
      }
    }

    // 7. Settle webhook event as PROCESSED only AFTER lifecycle effects have succeeded
    await settleWebhookEvent({
      eventId,
      processingToken,
      status: "PROCESSED",
      db,
    });

    return {
      processed: true,
      jobId: job.id,
      assetId: ingestResult.assetId,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await settleWebhookEvent({
      eventId,
      processingToken,
      status: "FAILED",
      error: errorMsg,
      db,
    });

    return { processed: false, reason: errorMsg };
  }
}

export interface ProcessWebhookBatchParams {
  limit?: number;
  db?: typeof prisma;
  storage: VideoObjectStorage;
  thumbnailExtractor?: VideoThumbnailExtractor;
}

export interface ProcessWebhookBatchResult {
  inspected: number;
  processed: number;
  failed: number;
  exhausted: number;
  skipped: number;
}

/**
 * Sweeps and processes pending or reclaimable webhook events in batch.
 * Guarantees durable execution after process restarts or when events were missed.
 * Concurrency-safe: each event is atomically claimed via claimWebhookEvent before execution.
 */
export async function processPendingWebhookBatch(
  params: ProcessWebhookBatchParams,
): Promise<ProcessWebhookBatchResult> {
  const { limit = 10, db = prisma, storage, thumbnailExtractor } = params;

  const now = new Date();

  // Find eligible events:
  // - PENDING with attempts < 5
  // - PROCESSING with expired lease and attempts < 5
  // - FAILED with leaseExpiresAt < now and attempts < 5
  const eligibleEvents = await db.providerWebhookEvent.findMany({
    where: {
      provider: "fal-ai",
      attempts: { lt: 5 },
      OR: [
        { status: "PENDING" },
        { status: "PROCESSING", leaseExpiresAt: { lt: now } },
        {
          status: "FAILED",
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const result: ProcessWebhookBatchResult = {
    inspected: eligibleEvents.length,
    processed: 0,
    failed: 0,
    exhausted: 0,
    skipped: 0,
  };

  for (const event of eligibleEvents) {
    const procRes = await processVideoWebhookEvent({
      eventId: event.eventId,
      storage,
      thumbnailExtractor,
      db,
    });

    if (procRes.processed) {
      result.processed++;
    } else if (procRes.reason === "ALREADY_CLAIMED_OR_SETTLED") {
      result.skipped++;
    } else {
      result.failed++;
    }
  }

  return result;
}
