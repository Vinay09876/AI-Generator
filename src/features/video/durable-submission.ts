import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  failVideoJob,
  markVideoJobStarted,
  recordVideoJobSubmissionAmbiguous,
} from "./lifecycle";
import type { VideoProviderAdapter, VideoSubmitResult } from "./types";
import { generateWebhookCorrelationToken } from "./webhooks/correlation";

export const SUBMISSION_LEASE_DURATION_MS = 60_000; // 60 seconds

export interface VideoSubmissionIntent {
  state: "intent" | "dispatching" | "submitted" | "ambiguous" | "failed";
  token?: string;
  correlationToken?: string;
  expiresAt?: string;
  attemptedAt?: string;
  providerJobId?: string;
  error?: string;
  unresolved?: boolean;
  unresolvedAt?: string;
  reviewStatus?: "pending_operator_review" | "resolved_failed" | "resolved_completed";
  reason?: string;
  ambiguousReason?: string;
}

/**
 * Atomically claims the right to dispatch a video submission to the upstream provider.
 * Protects against race conditions between concurrent requests and recovers from
 * processes that crashed before dispatching.
 *
 * Eligible states:
 *   - No submission state set yet
 *   - state = 'intent' (persisted intent before network attempt)
 *   - state = 'dispatching' with expired lease (worker crashed before dispatch began)
 */
export async function claimVideoSubmissionLease(
  jobId: string,
  token: string,
  leaseExpiresAt: Date,
  db: typeof prisma = prisma,
  correlationToken?: string,
): Promise<boolean> {
  const now = new Date();
  const submissionData: VideoSubmissionIntent = {
    state: "dispatching",
    token,
    ...(correlationToken ? { correlationToken } : {}),
    expiresAt: leaseExpiresAt.toISOString(),
    attemptedAt: now.toISOString(),
  };

  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "GenerationJob"
    SET "settings" = jsonb_set(
          coalesce("settings", '{}'::jsonb),
          '{submission}',
          ${JSON.stringify(submissionData)}::jsonb
        ),
        "updatedAt" = ${now}
    WHERE "id" = ${jobId}
      AND "status" = 'PENDING'
      AND (
        "settings"->'submission' IS NULL
        OR "settings"->'submission'->>'state' = 'intent'
        OR (
          "settings"->'submission'->>'state' = 'dispatching'
          AND ("settings"->'submission'->>'expiresAt')::timestamptz < ${now}
        )
      )
    RETURNING "id"`;

  return rows.length > 0;
}

/**
 * Records that the upstream provider successfully accepted the submission into its queue.
 * Atomically transitions the job to PROCESSING and updates the submission intent to 'submitted'.
 */
export async function recordVideoSubmissionSucceeded(
  jobId: string,
  token: string,
  result: VideoSubmitResult,
  db: typeof prisma = prisma,
  correlationToken?: string,
): Promise<boolean> {
  const now = new Date();
  const submissionData: VideoSubmissionIntent = {
    state: "submitted",
    token,
    ...(correlationToken ? { correlationToken } : {}),
    providerJobId: result.providerJobId,
    attemptedAt: now.toISOString(),
  };

  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "GenerationJob"
    SET "status" = 'PROCESSING',
        "providerJobId" = ${result.providerJobId},
        "provider" = ${result.provider},
        "model" = ${result.model},
        "startedAt" = ${now},
        "updatedAt" = ${now},
        "settings" = jsonb_set(
          coalesce("settings", '{}'::jsonb),
          '{submission}',
          ${JSON.stringify(submissionData)}::jsonb
        )
    WHERE "id" = ${jobId}
      AND "status" = 'PENDING'
    RETURNING "id"`;

  return rows.length > 0;
}

/**
 * Recovers a stuck submission where a worker held a 'dispatching' lease that expired
 * without recording success or definite failure.
 *
 * CRITICAL IDEMPOTENCY SAFETY:
 * Because Fal.ai queue submissions do NOT support idempotency keys, we do NOT blindly
 * re-dispatch to the provider (which could bill the customer twice if the request actually reached Fal).
 * Instead, we transition the job to 'ambiguous' (PROCESSING) to await webhook delivery via ?jobId={jobId},
 * preserving the user's debit. If no webhook arrives within the timeout window, the job enters an
 * explicit operationally reviewable unresolved state rather than being automatically refunded, preventing
 * unearned video delivery or provider billing discrepancies.
 */
export async function reconcileStaleSubmissionIntent(
  jobId: string,
  db: typeof prisma = prisma,
): Promise<boolean> {
  return recordVideoJobSubmissionAmbiguous(
    {
      jobId,
      error: "Submission dispatch timed out or worker crashed without confirming provider queue ID",
    },
    db,
  );
}

export type DispatchVideoResult =
  | { outcome: "submitted"; providerJobId: string }
  | { outcome: "ambiguous"; error: string }
  | { outcome: "rejected"; error: string }
  | { outcome: "already_dispatched" | "lease_rejected" };

/**
 * Dispatches an asynchronous video generation request to the provider with full
 * crash recovery and lease protection.
 */
export async function dispatchVideoSubmission(params: {
  jobId: string;
  prompt: string;
  aspectRatio: any;
  provider: VideoProviderAdapter;
  signal?: AbortSignal;
  db?: typeof prisma;
}): Promise<DispatchVideoResult> {
  const { jobId, prompt, aspectRatio, provider, signal, db = prisma } = params;
  const token = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + SUBMISSION_LEASE_DURATION_MS);
  const correlationToken = generateWebhookCorrelationToken({
    jobId,
    provider: provider.id,
    submissionAttempt: token,
  });

  // 1. Atomically claim submission lease
  const claimed = await claimVideoSubmissionLease(
    jobId,
    token,
    leaseExpiresAt,
    db,
    correlationToken,
  );
  if (!claimed) {
    return { outcome: "lease_rejected" };
  }

  // 2. Submit to provider with embedded ?jobId={jobId}&token={correlationToken} in webhook parameter
  try {
    const result = await provider.submit({
      prompt,
      settings: { aspectRatio },
      jobId,
      correlationToken,
      signal,
    });

    // 3. Record successful queue submission
    await recordVideoSubmissionSucceeded(jobId, token, result, db, correlationToken);
    return { outcome: "submitted", providerJobId: result.providerJobId };
  } catch (error: any) {
    const outcome = error?.outcome ?? "unknown";

    if (outcome === "not_run") {
      // Definite upstream rejection (e.g. invalid request, authentication, quota, or aborted before transmission)
      // Safe to refund credits immediately
      await failVideoJob(jobId, error.message ?? "Provider rejected submission", db);
      return { outcome: "rejected", error: error.message };
    }

    // Ambiguous outcome (e.g. timeout, connection drop, 5xx):
    // Fal.ai may have accepted the request onto GPU queue. Never refund prematurely!
    await recordVideoJobSubmissionAmbiguous(
      {
        jobId,
        error: error.message ?? "Ambiguous provider outcome",
        token,
        correlationToken,
      },
      db,
    );
    return { outcome: "ambiguous", error: error.message };
  }
}
