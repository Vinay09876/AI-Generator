import { AssetType, GenerationStatus, GenerationType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { utcDayRange } from "@/lib/utc";
import { debitWallet, jobDebitKey, jobRefundKey, refundJobDebit } from "@/features/credits/ledger";
import { AccountingError } from "@/features/generations/errors";
import { assertPromptContentSafety } from "@/features/moderation/safety";
import {
  canGenerateVideoInStage8,
  resolveUserVideoEntitlement,
  type ServerUserIdentity,
} from "./auth";
import {
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_PROVIDER,
  DEFAULT_VIDEO_SETTINGS,
  VIDEO_INGESTION_LEASE_MS,
  VIDEO_PENDING_STALE_MS,
  VIDEO_PROCESSING_STALE_MS,
  isSupportedVideoAspectRatio,
  isSupportedVideoDuration,
  isSupportedVideoFrameRate,
  isSupportedVideoResolution,
  validateVideoPrompt,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoFrameRate,
  type VideoResolution,
} from "./config";

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const ACTIVE_STATUSES = [GenerationStatus.PENDING, GenerationStatus.PROCESSING];

export class JobNotCompletableError extends Error {
  constructor(public readonly jobId: string, message = "Video job is no longer completable.") {
    super(message);
    this.name = "JobNotCompletableError";
  }
}

export interface CompletedVideoAssetInput {
  userId: string;
  assetId: string;
  storageKey: string;
  thumbnailKey?: string | null;
  mimeType?: string;
  width: number;
  height: number;
  durationSeconds: number;
  sizeBytes: number;
}

export interface VideoJobSettings {
  aspectRatio: VideoAspectRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  fps: VideoFrameRate;
  creditCost: number;
  providerResult?: unknown;
  submission?: unknown;
}

const videoJobSelect = {
  id: true,
  userId: true,
  type: true,
  status: true,
  prompt: true,
  provider: true,
  providerJobId: true,
  model: true,
  settings: true,
  estimatedCredits: true,
  chargedCredits: true,
  errorMessage: true,
  idempotencyKey: true,
  ingestionToken: true,
  ingestionLeaseExpiresAt: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
} as const;

export type VideoJob = Prisma.GenerationJobGetPayload<{ select: typeof videoJobSelect }>;

export interface ValidatedVideoRequest {
  prompt: string;
  settings: {
    aspectRatio: VideoAspectRatio;
    duration: VideoDuration;
    resolution: VideoResolution;
    fps: VideoFrameRate;
  };
  idempotencyKey: string;
}

/**
 * Validates untrusted input for video generation requests.
 */
export function validateVideoRequestInput(input: {
  prompt: unknown;
  aspectRatio?: unknown;
  duration?: unknown;
  resolution?: unknown;
  fps?: unknown;
  idempotencyKey: unknown;
}): ValidatedVideoRequest {
  const promptRes = validateVideoPrompt(input.prompt);
  if (!promptRes.valid || !promptRes.cleaned) {
    throw new AccountingError("INVALID_INPUT", promptRes.error ?? "Invalid video prompt.");
  }
  const prompt = promptRes.cleaned;
  assertPromptContentSafety(prompt);

  const aspectRatio = input.aspectRatio ?? DEFAULT_VIDEO_SETTINGS.aspectRatio;
  if (!isSupportedVideoAspectRatio(aspectRatio)) {
    throw new AccountingError("INVALID_INPUT", `Unsupported aspect ratio: ${aspectRatio}`);
  }

  const duration = input.duration ?? DEFAULT_VIDEO_SETTINGS.duration;
  if (!isSupportedVideoDuration(duration)) {
    throw new AccountingError("INVALID_INPUT", `Unsupported duration: ${duration}`);
  }

  const resolution = input.resolution ?? DEFAULT_VIDEO_SETTINGS.resolution;
  if (!isSupportedVideoResolution(resolution)) {
    throw new AccountingError("INVALID_INPUT", `Unsupported resolution: ${resolution}`);
  }

  const fps = input.fps ?? DEFAULT_VIDEO_SETTINGS.fps;
  if (!isSupportedVideoFrameRate(fps)) {
    throw new AccountingError("INVALID_INPUT", `Unsupported frame rate: ${fps}`);
  }

  const rawKey = input.idempotencyKey;
  if (typeof rawKey !== "string" || !rawKey.trim()) {
    throw new AccountingError("INVALID_INPUT", "A non-empty idempotencyKey is required.");
  }
  const idempotencyKey = rawKey.trim().slice(0, 100);

  return {
    prompt,
    settings: {
      aspectRatio,
      duration,
      resolution,
      fps,
    },
    idempotencyKey,
  };
}

/**
 * Counts user video jobs created within a given UTC day range.
 * Active (PENDING, PROCESSING) and successful (COMPLETED) jobs consume daily quota.
 */
export function countDailyVideoJobs(
  db: Pick<Prisma.TransactionClient, "generationJob">,
  userId: string,
  day: { start: Date; end: Date },
) {
  return db.generationJob.count({
    where: {
      userId,
      type: GenerationType.VIDEO,
      createdAt: { gte: day.start, lt: day.end },
      status: { in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING, GenerationStatus.COMPLETED] },
    },
  });
}

export interface CreateVideoJobInput {
  userId: string;
  user?: ServerUserIdentity | null;
  prompt: unknown;
  aspectRatio?: unknown;
  duration?: unknown;
  resolution?: unknown;
  fps?: unknown;
  idempotencyKey: unknown;
  clientPayload?: unknown;
  trustedSubscription?: { status: string; tier: string } | null;
}

export interface CreateVideoJobOverrides {
  now?: Date;
  provider?: string;
  model?: string;
  allowlistRaw?: string | null;
  nodeEnv?: string;
  creditCost?: number;
}

/**
 * Creates a video generation job with ACID credit debit in ONE short transaction:
 *   1. Resolve authoritative server-side entitlement (tier, daily limit, cost).
 *   2. In production, enforce Stage 8 QA authorization guard.
 *   3. Lock User row (FOR UPDATE) to serialize job creation per user.
 *   4. Check idempotency replay (same key + same settings -> returns existing job; conflict -> throws).
 *   5. Check daily video generation quota.
 *   6. Check active generation concurrency (maximum 1 across all job types).
 *   7. Insert GenerationJob (PENDING).
 *   8. Debit credit wallet atomically with job-linked ledger entry.
 */
export async function createVideoJob(
  input: CreateVideoJobInput,
  overrides: CreateVideoJobOverrides = {},
  db: typeof prisma = prisma,
): Promise<{ job: VideoJob; replayed: boolean }> {
  const validated = validateVideoRequestInput(input);
  const { userId } = input;
  const now = overrides.now ?? new Date();
  const day = utcDayRange(now);

  const entitlement = resolveUserVideoEntitlement({
    user: input.user ?? { id: userId },
    clientPayload: input.clientPayload,
    trustedSubscription: input.trustedSubscription,
    allowlistRaw: overrides.allowlistRaw,
    nodeEnv: overrides.nodeEnv,
  });

  const access = canGenerateVideoInStage8({
    entitlement,
    nodeEnv: overrides.nodeEnv,
  });
  if (!access.allowed) {
    throw new AccountingError("INVALID_INPUT", access.reason ?? "Video generation is restricted to authorized QA accounts.");
  }

  const effectiveCreditCost = overrides.creditCost !== undefined ? overrides.creditCost : entitlement.creditCost;

  const jobSettings: VideoJobSettings = {
    ...validated.settings,
    creditCost: effectiveCreditCost,
    submission: { state: "intent", createdAt: now.toISOString() },
  };

  try {
    return await db.$transaction(async (tx) => {
      // Serialize all generation creation for this user
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (locked.length === 0) throw new AccountingError("USER_NOT_FOUND");

      // Idempotency replay check
      const existing = await tx.generationJob.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: validated.idempotencyKey } },
        select: videoJobSelect,
      });

      if (existing) {
        const prev = existing.settings as Partial<VideoJobSettings> | null;
        if (
          existing.prompt !== validated.prompt ||
          prev?.aspectRatio !== validated.settings.aspectRatio ||
          prev?.duration !== validated.settings.duration ||
          prev?.resolution !== validated.settings.resolution ||
          prev?.fps !== validated.settings.fps
        ) {
          throw new AccountingError("IDEMPOTENCY_CONFLICT");
        }
        return { job: existing, replayed: true };
      }

      // Check daily quota
      const usedToday = await countDailyVideoJobs(tx, userId, day);
      if (usedToday >= entitlement.dailyLimit) {
        throw new AccountingError("DAILY_LIMIT_REACHED", "You have reached your daily video generation limit.");
      }

      // Check active job concurrency across ALL types (IMAGE & VIDEO)
      const active = await tx.generationJob.findFirst({
        where: { userId, status: { in: ACTIVE_STATUSES } },
        select: { id: true },
      });
      if (active) {
        throw new AccountingError("ACTIVE_JOB_EXISTS");
      }

      // Create video generation job
      const job = await tx.generationJob.create({
        data: {
          userId,
          type: GenerationType.VIDEO,
          status: GenerationStatus.PENDING,
          prompt: validated.prompt,
          provider: overrides.provider ?? DEFAULT_VIDEO_PROVIDER,
          model: overrides.model ?? DEFAULT_VIDEO_MODEL,
          settings: jobSettings as unknown as Prisma.InputJsonValue,
          estimatedCredits: effectiveCreditCost,
          chargedCredits: 0,
          idempotencyKey: validated.idempotencyKey,
          createdAt: now,
        },
        select: videoJobSelect,
      });

      // Atomic wallet debit
      await debitWallet(tx, {
        userId,
        amount: effectiveCreditCost,
        jobId: job.id,
        idempotencyKey: jobDebitKey(job.id),
        description: "AI video generation",
      });

      return { job, replayed: false };
    }, TX_OPTIONS);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AccountingError(
        String(error.message).includes("idempotencyKey") ? "IDEMPOTENCY_CONFLICT" : "ACTIVE_JOB_EXISTS",
      );
    }
    throw error;
  }
}

/**
 * PENDING -> PROCESSING transition upon submitting request to the video provider.
 * Sets startedAt timestamp and records external providerJobId.
 */
export async function markVideoJobStarted(
  params: {
    jobId: string;
    providerJobId: string;
    provider?: string;
    model?: string;
    now?: Date;
  },
  db: typeof prisma = prisma,
): Promise<boolean> {
  const { jobId, providerJobId, provider, model, now = new Date() } = params;

  const { count } = await db.generationJob.updateMany({
    where: { id: jobId, status: GenerationStatus.PENDING },
    data: {
      status: GenerationStatus.PROCESSING,
      providerJobId,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      startedAt: now,
    },
  });

  return count === 1;
}

/**
 * Records an ambiguous submission attempt on a video job (outcome = "unknown").
 * Does NOT refund credits prematurely, because the provider may have accepted
 * and queued the generation on their GPU cluster.
 * Transitions status from PENDING to PROCESSING with providerJobId: null (or preliminary marker),
 * records submission details in job settings, and sets startedAt timestamp.
 *
 * Safe Recovery:
 * - If a webhook arrives later (carrying the jobId query param), it recovers and completes the job.
 * - If no webhook arrives within the 15-minute reconciliation window, reconcileStaleVideoJobs transitions
 *   the job into an explicit operationally reviewable unresolved state rather than automatically refunding it.
 *   This preserves the user's debit while preventing unearned video delivery or provider billing discrepancies.
 */
export async function recordVideoJobSubmissionAmbiguous(
  params: {
    jobId: string;
    error: string;
    token?: string;
    correlationToken?: string;
    now?: Date;
  },
  db: typeof prisma = prisma,
): Promise<boolean> {
  const { jobId, error, token, correlationToken, now = new Date() } = params;

  const patch: Record<string, unknown> = {
    state: "ambiguous",
    error,
    attemptedAt: now.toISOString(),
  };
  if (token) patch.token = token;
  if (correlationToken) patch.correlationToken = correlationToken;

  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "GenerationJob"
    SET "status" = 'PROCESSING',
        "startedAt" = ${now},
        "updatedAt" = ${now},
        "settings" = jsonb_set(
          coalesce("settings", '{}'::jsonb),
          '{submission}',
          coalesce("settings"->'submission', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
        )
    WHERE "id" = ${jobId}
      AND "status" = 'PENDING'
    RETURNING "id"`;

  return rows.length === 1;
}

/**
 * Records provider completion payload (e.g. temporary CDN URL) into job settings.
 * Allows Fast-ACK (<200ms) for webhooks without blocking on heavy video downloading.
 */
export async function recordVideoProviderResult(
  jobId: string,
  providerResult: unknown,
  db: typeof prisma = prisma,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "GenerationJob"
    SET "settings" = jsonb_set(coalesce("settings", '{}'::jsonb), '{providerResult}', ${JSON.stringify(providerResult)}::jsonb),
        "updatedAt" = now()
    WHERE "id" = ${jobId}
      AND "status" = 'PROCESSING'
    RETURNING "id"`;

  return rows.length === 1;
}

export interface ClaimLeaseResult {
  claimed: boolean;
  token?: string;
  expiresAt?: Date;
  reason?: string;
}

/**
 * Atomically claims the exclusive video ingestion lease for a job:
 *   - Only matches if status is 'PROCESSING'.
 *   - Only matches if ingestionToken IS NULL OR ingestionLeaseExpiresAt < now().
 *   - Updates ingestionToken to a new unique token and sets expiration (default 5 minutes).
 *
 * Exactly one concurrent caller receives { claimed: true }.
 */
export async function claimVideoIngestionLease(
  params: {
    jobId: string;
    customToken?: string;
    leaseDurationMs?: number;
  },
  db: typeof prisma = prisma,
): Promise<ClaimLeaseResult> {
  const token = params.customToken ?? crypto.randomUUID();
  const leaseMs = params.leaseDurationMs ?? VIDEO_INGESTION_LEASE_MS;

  const rows = await db.$queryRaw<{ id: string; userId: string; ingestionToken: string; ingestionLeaseExpiresAt: Date }[]>`
    UPDATE "GenerationJob"
    SET "ingestionToken" = ${token},
        "ingestionLeaseExpiresAt" = now() + (${leaseMs} * interval '1 millisecond'),
        "updatedAt" = now()
    WHERE "id" = ${params.jobId}
      AND "status" = 'PROCESSING'
      AND ("ingestionToken" IS NULL OR "ingestionLeaseExpiresAt" < now())
    RETURNING "id", "userId", "ingestionToken", "ingestionLeaseExpiresAt"`;

  if (rows.length === 0) {
    return { claimed: false, reason: "already_claimed_or_not_processing" };
  }

  return {
    claimed: true,
    token: rows[0].ingestionToken,
    expiresAt: rows[0].ingestionLeaseExpiresAt,
  };
}

/**
 * Completes a video generation job and inserts its GeneratedAsset record in ONE short transaction:
 *   - Guarded transition: PROCESSING -> COMPLETED only if ingestionToken matches the lease holder.
 *   - Finalizes chargedCredits = estimatedCredits (NO credit refund).
 *   - Inserts GeneratedAsset with video metadata, durationSeconds, and thumbnailKey.
 *   - Defence-in-depth: verifies asset owner matches job owner.
 *
 * Throws JobNotCompletableError if the lease was lost or expired, or job was already settled.
 */
export async function completeVideoJobWithAsset(
  params: {
    jobId: string;
    ingestionToken: string;
    asset: CompletedVideoAssetInput;
  },
  db: typeof prisma = prisma,
): Promise<{ jobId: string; assetId: string }> {
  const { jobId, ingestionToken, asset } = params;

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; userId: string; estimatedCredits: number }[]>`
      UPDATE "GenerationJob" j
      SET "status" = 'COMPLETED',
          "chargedCredits" = j."estimatedCredits",
          "ingestionToken" = NULL,
          "ingestionLeaseExpiresAt" = NULL,
          "completedAt" = now(),
          "updatedAt" = now()
      WHERE j."id" = ${jobId}
        AND j."status" = 'PROCESSING'
        AND j."ingestionToken" = ${ingestionToken}
      RETURNING j."id", j."userId", j."estimatedCredits"`;

    if (rows.length === 0) {
      throw new JobNotCompletableError(jobId, "Job is not in PROCESSING state with matching ingestionToken");
    }

    const job = rows[0];
    if (job.userId !== asset.userId) {
      throw new JobNotCompletableError(jobId, "Asset owner does not match job owner");
    }

    await tx.generatedAsset.create({
      data: {
        id: asset.assetId,
        userId: asset.userId,
        jobId,
        type: AssetType.VIDEO,
        storageKey: asset.storageKey,
        thumbnailKey: asset.thumbnailKey ?? null,
        mimeType: asset.mimeType ?? "video/mp4",
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.durationSeconds,
        fileSize: BigInt(asset.sizeBytes),
      },
      select: { id: true },
    });

    return { jobId, assetId: asset.assetId };
  }, TX_OPTIONS);
}

/**
 * Transitions an active video job (PENDING or PROCESSING) to FAILED and refunds debited credits exactly once.
 * Subsequent or duplicate calls match zero rows and perform no refund.
 */
export async function failVideoJob(
  jobId: string,
  reason: string,
  db: typeof prisma = prisma,
): Promise<{ settled: boolean; refund: Awaited<ReturnType<typeof refundJobDebit>> }> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "GenerationJob"
      SET "status" = 'FAILED',
          "errorMessage" = ${reason},
          "ingestionToken" = NULL,
          "ingestionLeaseExpiresAt" = NULL,
          "completedAt" = now(),
          "updatedAt" = now()
      WHERE "id" = ${jobId}
        AND "status"::text IN ('PENDING', 'PROCESSING')
      RETURNING "id"`;

    if (rows.length === 0) {
      return { settled: false, refund: null };
    }

    const refund = await refundJobDebit(tx, {
      jobId,
      description: "Refund: video generation failed",
    });

    return { settled: true, refund };
  }, TX_OPTIONS);
}

/**
 * Transitions an active video job (PENDING or PROCESSING) to CANCELLED and refunds debited credits exactly once.
 */
export async function cancelVideoJob(
  jobId: string,
  reason: string,
  db: typeof prisma = prisma,
): Promise<{ settled: boolean; refund: Awaited<ReturnType<typeof refundJobDebit>> }> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "GenerationJob"
      SET "status" = 'CANCELLED',
          "errorMessage" = ${reason},
          "ingestionToken" = NULL,
          "ingestionLeaseExpiresAt" = NULL,
          "completedAt" = now(),
          "updatedAt" = now()
      WHERE "id" = ${jobId}
        AND "status"::text IN ('PENDING', 'PROCESSING')
      RETURNING "id"`;

    if (rows.length === 0) {
      return { settled: false, refund: null };
    }

    const refund = await refundJobDebit(tx, {
      jobId,
      description: "Refund: video generation cancelled",
    });

    return { settled: true, refund };
  }, TX_OPTIONS);
}

export interface ReconcileStaleVideoJobsResult {
  checked: number;
  settled: number;
  unresolved: number;
}

/**
 * Reconciles stuck video generation jobs:
 *   - PENDING older than VIDEO_PENDING_STALE_MS: provider request never began -> FAILED + refund.
 *   - PROCESSING older than VIDEO_PROCESSING_STALE_MS:
 *     - If ordinary job (confirmed providerJobId and submission not ambiguous): timed out -> FAILED + refund.
 *     - If ambiguous submission (submission.state === 'ambiguous' or null providerJobId):
 *       MUST NOT be automatically refunded merely because 15 minutes elapsed!
 *       Instead, transitions into an explicit operationally reviewable unresolved state:
 *       settings.submission.unresolved = true, reviewStatus = 'pending_operator_review'.
 *       Preserves the user's debit while provider outcome remains unresolved.
 *       Safe to run repeatedly; duplicate reconciliations are strictly idempotent (settled: 0, unresolved: 0).
 */
export async function reconcileStaleVideoJobs(
  options: {
    now?: Date;
    limit?: number;
    userId?: string;
  } = {},
  db: typeof prisma = prisma,
): Promise<ReconcileStaleVideoJobsResult> {
  const now = options.now ?? new Date();
  const take = options.limit ?? 50;
  const scope = options.userId ? { userId: options.userId } : {};

  const [pending, processing] = await Promise.all([
    db.generationJob.findMany({
      where: {
        ...scope,
        type: GenerationType.VIDEO,
        status: GenerationStatus.PENDING,
        createdAt: { lt: new Date(now.getTime() - VIDEO_PENDING_STALE_MS) },
      },
      select: { id: true },
      take,
    }),
    db.generationJob.findMany({
      where: {
        ...scope,
        type: GenerationType.VIDEO,
        status: GenerationStatus.PROCESSING,
        startedAt: { lt: new Date(now.getTime() - VIDEO_PROCESSING_STALE_MS) },
      },
      select: {
        id: true,
        providerJobId: true,
        settings: true,
      },
      take,
    }),
  ]);

  let settled = 0;
  let unresolved = 0;

  for (const { id } of pending) {
    const res = await failVideoJob(id, "Video generation did not start in time", db);
    if (res.settled) settled++;
  }

  for (const job of processing) {
    const settings = (job.settings as Record<string, unknown> | null) ?? {};
    const submission = (settings.submission as Record<string, unknown> | null) ?? {};
    const isAmbiguousSubmission = submission.state === "ambiguous" || !job.providerJobId;

    if (isAmbiguousSubmission) {
      // 1. If already marked as unresolved, skip (duplicate reconciliation is strictly idempotent)
      if (submission.unresolved === true) {
        continue;
      }

      // 2. Mark as unresolved for operational review.
      // CRITICAL: Preserve PROCESSING status, preserve debited credits, DO NOT refund.
      // This allows a late valid webhook to complete the job or an operator to audit.
      const updatedSettings = {
        ...settings,
        submission: {
          ...submission,
          state: "ambiguous",
          unresolved: true,
          unresolvedAt: now.toISOString(),
          reviewStatus: "pending_operator_review",
          reason:
            "Ambiguous provider submission: dispatch timed out or dropped and no webhook received within 15 minutes. Preserving debit pending operator review or delayed webhook.",
        },
      };

      await db.generationJob.update({
        where: { id: job.id },
        data: {
          errorMessage: "Generation unresolved: provider response was ambiguous. Under operational review.",
          settings: updatedSettings,
          updatedAt: now,
        },
      });

      unresolved++;
    } else {
      // Ordinary stale job with confirmed providerJobId that never reported completion
      const res = await failVideoJob(job.id, "Video generation timed out", db);
      if (res.settled) settled++;
    }
  }

  return { checked: pending.length + processing.length, settled, unresolved };
}

/**
 * Operator Resolution Path: Confirmed Provider Non-Execution.
 *
 * When operational investigation (e.g. Fal dashboard / logs / support) confirms that
 * an ambiguous video generation request never executed or was dropped by the provider:
 *   - Transitions the job from PROCESSING to FAILED.
 *   - Atomically refunds the debited credits back to the user's wallet.
 *   - Records full audit trail: operatorId, resolution action, reason, timestamp.
 *   - Enforces invariant: Late webhooks or completions arriving after refund are strictly rejected.
 */
export async function resolveAmbiguousJobAsFailed(
  params: {
    jobId: string;
    operatorId: string;
    reason: string;
  },
  db: typeof prisma = prisma,
): Promise<{ settled: boolean; refund: Awaited<ReturnType<typeof refundJobDebit>> }> {
  const { jobId, operatorId, reason } = params;
  const now = new Date();

  return db.$transaction(async (tx) => {
    const job = await tx.generationJob.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, settings: true },
    });

    if (!job || job.status !== GenerationStatus.PROCESSING) {
      return { settled: false, refund: null };
    }

    const currentSettings = (job.settings as Record<string, unknown> | null) ?? {};
    const updatedSettings = {
      ...currentSettings,
      submission: {
        ...((currentSettings.submission as Record<string, unknown> | null) ?? {}),
        state: "failed",
        unresolved: false,
        reviewStatus: "resolved_failed",
      },
      resolution: {
        resolvedBy: "operator",
        action: "refund",
        operatorId,
        reason,
        resolvedAt: now.toISOString(),
      },
    };

    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "GenerationJob"
      SET "status" = 'FAILED',
          "errorMessage" = ${reason},
          "ingestionToken" = NULL,
          "ingestionLeaseExpiresAt" = NULL,
          "completedAt" = ${now},
          "updatedAt" = ${now},
          "settings" = ${JSON.stringify(updatedSettings)}::jsonb
      WHERE "id" = ${jobId}
        AND "status" = 'PROCESSING'
      RETURNING "id"`;

    if (rows.length === 0) {
      return { settled: false, refund: null };
    }

    const refund = await refundJobDebit(tx, {
      jobId,
      description: `Operator resolution refund: ${reason}`,
    });

    return { settled: true, refund };
  }, TX_OPTIONS);
}

/**
 * Operator Resolution Path: Confirmed Provider Completion.
 *
 * When operational investigation confirms that the provider did execute the generation
 * and provides the verified asset metadata / storage details:
 *   - Transitions the job from PROCESSING to COMPLETED.
 *   - Finalizes chargedCredits = estimatedCredits (no refund).
 *   - Inserts the GeneratedAsset record with verified dimensions and duration.
 *   - Records full audit trail: operatorId, resolution action, reason, timestamp.
 */
export async function resolveAmbiguousJobAsCompleted(
  params: {
    jobId: string;
    operatorId: string;
    reason: string;
    asset: CompletedVideoAssetInput;
  },
  db: typeof prisma = prisma,
): Promise<{ settled: boolean; assetId: string | null }> {
  const { jobId, operatorId, reason, asset } = params;
  const now = new Date();

  return db.$transaction(async (tx) => {
    const job = await tx.generationJob.findUnique({
      where: { id: jobId },
      select: { id: true, userId: true, status: true, estimatedCredits: true, settings: true },
    });

    if (!job || job.status !== GenerationStatus.PROCESSING) {
      return { settled: false, assetId: null };
    }

    if (asset.userId !== job.userId) {
      throw new JobNotCompletableError(
        jobId,
        `Asset user ${asset.userId} does not match job user ${job.userId}`,
      );
    }

    const currentSettings = (job.settings as Record<string, unknown> | null) ?? {};
    const updatedSettings = {
      ...currentSettings,
      submission: {
        ...((currentSettings.submission as Record<string, unknown> | null) ?? {}),
        state: "submitted",
        unresolved: false,
        reviewStatus: "resolved_completed",
      },
      resolution: {
        resolvedBy: "operator",
        action: "complete",
        operatorId,
        reason,
        resolvedAt: now.toISOString(),
      },
    };

    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "GenerationJob"
      SET "status" = 'COMPLETED',
          "chargedCredits" = "estimatedCredits",
          "ingestionToken" = NULL,
          "ingestionLeaseExpiresAt" = NULL,
          "completedAt" = ${now},
          "updatedAt" = ${now},
          "settings" = ${JSON.stringify(updatedSettings)}::jsonb
      WHERE "id" = ${jobId}
        AND "status" = 'PROCESSING'
      RETURNING "id"`;

    if (rows.length === 0) {
      return { settled: false, assetId: null };
    }

    const createdAsset = await tx.generatedAsset.create({
      data: {
        id: asset.assetId,
        userId: asset.userId,
        jobId,
        type: AssetType.VIDEO,
        storageKey: asset.storageKey,
        thumbnailKey: asset.thumbnailKey ?? null,
        mimeType: asset.mimeType ?? "video/mp4",
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.durationSeconds,
        fileSize: BigInt(asset.sizeBytes),
      },
      select: { id: true },
    });

    return { settled: true, assetId: createdAsset.id };
  }, TX_OPTIONS);
}
