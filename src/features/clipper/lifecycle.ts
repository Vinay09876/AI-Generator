/**
 * AI Video Clipper Lifecycle State Machine, Lease Coordination & Credit Accounting.
 *
 * Implements the ACID generation lifecycle for VIDEO_CLIP generation jobs:
 * 1. Atomic job creation and credit debit in a single transaction.
 * 2. Idempotent replay vs conflict detection.
 * 3. Daily quota enforcement and platform-wide active concurrency guard (1 active job across all types).
 * 4. PENDING -> PROCESSING -> COMPLETED / FAILED / CANCELLED state machine.
 * 5. Ingestion lease claiming, expiration, and renewal for worker isolation.
 * 6. Guarded completion with multi-clip asset creation.
 * 7. Strictly idempotent refunds through the double-entry credit ledger.
 * 8. Terminal state protection: completed jobs cannot be refunded; failed/cancelled cannot create assets.
 * 9. Decoupled source storage cleanup tracking (pendingCleanups & cleanupAudit) without affecting financial settlements.
 */

import { AssetType, GenerationStatus, GenerationType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { utcDayRange } from "@/lib/utc";
import { debitWallet, jobDebitKey, refundJobDebit } from "@/features/credits/ledger";
import { AccountingError } from "@/features/generations/errors";
import {
  CLIPPER_ASPECT_RATIOS,
  CLIPPER_FRAMING_MODES,
  DEFAULT_CLIPPER_ASPECT_RATIO,
  DEFAULT_CLIPPER_ENGINE,
  DEFAULT_CLIPPER_FRAMING_MODE,
  DEFAULT_TARGET_CLIP_DURATION_SECONDS,
  getClipperCreditCost,
  getClipperMaxClipsPerJob,
  getDailyUserClipLimit,
  type ClipperAspectRatio,
  type ClipperFramingMode,
} from "./config";
import { assertSafeIdentifier, isClipperKeyOwnedBy } from "./storage/keys";
import type {
  CandidateHighlight,
  CleanupAuditRecord,
  ClipperJobSettings,
  RenderedClipRecord,
} from "./types";

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const ACTIVE_STATUSES = [GenerationStatus.PENDING, GenerationStatus.PROCESSING];

export const CLIPPER_INGESTION_LEASE_MS = 5 * 60 * 1000; // 5 minutes
export const CLIPPER_PENDING_STALE_MS = 5 * 60 * 1000; // 5 minutes
export const CLIPPER_PROCESSING_STALE_MS = 15 * 60 * 1000; // 15 minutes

export class JobNotCompletableError extends Error {
  constructor(public readonly jobId: string, message = "Clipper job is no longer completable.") {
    super(message);
    this.name = "JobNotCompletableError";
  }
}

export interface CompletedClipAssetInput {
  clipId: string;
  assetId?: string;
  userId: string;
  storageKey: string;
  thumbnailKey?: string | null;
  mimeType?: string;
  width: number;
  height: number;
  durationSeconds: number;
  sizeBytes: number;
  aspectRatio: ClipperAspectRatio;
  title: string;
}

const clipperJobSelect = {
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

export type ClipperJob = Prisma.GenerationJobGetPayload<{ select: typeof clipperJobSelect }>;

export interface ValidatedClipperRequest {
  sourceType: "upload" | "platform_asset";
  sourceKey: string;
  sourceAssetId?: string;
  sourceDurationSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  isVisualOnly: boolean;
  targetAspectRatio: ClipperAspectRatio;
  targetFraming: ClipperFramingMode;
  burnSubtitles: boolean;
  requestedClipsCount: number;
  prompt: string;
  idempotencyKey: string;
}

/**
 * Validates untrusted input for video clipping requests.
 */
export function validateClipperRequestInput(
  input: {
    sourceType?: unknown;
    sourceKey: unknown;
    sourceAssetId?: unknown;
    sourceDurationSeconds?: unknown;
    sourceWidth?: unknown;
    sourceHeight?: unknown;
    isVisualOnly?: unknown;
    targetAspectRatio?: unknown;
    targetFraming?: unknown;
    burnSubtitles?: unknown;
    requestedClipsCount?: unknown;
    prompt?: unknown;
    idempotencyKey: unknown;
  },
  userId?: string,
): ValidatedClipperRequest {
  const sourceType = input.sourceType === "platform_asset" ? "platform_asset" : "upload";

  if (typeof input.sourceKey !== "string" || !input.sourceKey.trim()) {
    throw new AccountingError("INVALID_INPUT", "sourceKey is required for video clipping.");
  }
  const sourceKey = input.sourceKey.trim();

  // If userId is provided, ensure sourceKey belongs to this user namespace
  if (userId && !isClipperKeyOwnedBy(sourceKey, userId)) {
    // Also allow platform asset references if sourceKey starts with users/{userId}/videos
    if (!sourceKey.startsWith(`users/${userId}/videos/`)) {
      throw new AccountingError("INVALID_INPUT", "Source video storage key does not belong to authorized user.");
    }
  }

  const sourceAssetId = typeof input.sourceAssetId === "string" && input.sourceAssetId.trim()
    ? input.sourceAssetId.trim()
    : undefined;

  const durationNum = typeof input.sourceDurationSeconds === "number"
    ? input.sourceDurationSeconds
    : parseFloat(String(input.sourceDurationSeconds || 0));
  if (!Number.isFinite(durationNum) || durationNum <= 0) {
    throw new AccountingError("INVALID_INPUT", "sourceDurationSeconds must be a positive number.");
  }

  const width = typeof input.sourceWidth === "number" ? input.sourceWidth : parseInt(String(input.sourceWidth || 1920), 10);
  const height = typeof input.sourceHeight === "number" ? input.sourceHeight : parseInt(String(input.sourceHeight || 1080), 10);

  const isVisualOnly = Boolean(input.isVisualOnly);

  const targetAspectRatio: ClipperAspectRatio =
    typeof input.targetAspectRatio === "string" && input.targetAspectRatio in CLIPPER_ASPECT_RATIOS
      ? (input.targetAspectRatio as ClipperAspectRatio)
      : DEFAULT_CLIPPER_ASPECT_RATIO;

  const targetFraming: ClipperFramingMode =
    typeof input.targetFraming === "string" && input.targetFraming in CLIPPER_FRAMING_MODES
      ? (input.targetFraming as ClipperFramingMode)
      : DEFAULT_CLIPPER_FRAMING_MODE;

  const burnSubtitles = isVisualOnly ? false : (input.burnSubtitles !== undefined ? Boolean(input.burnSubtitles) : true);

  const rawClipsCount = typeof input.requestedClipsCount === "number"
    ? input.requestedClipsCount
    : parseInt(String(input.requestedClipsCount || 1), 10);
  const requestedClipsCount = Math.max(1, Math.min(rawClipsCount || 1, getClipperMaxClipsPerJob()));

  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 500) : "Video highlight clip";

  const rawKey = input.idempotencyKey;
  if (typeof rawKey !== "string" || !rawKey.trim()) {
    throw new AccountingError("INVALID_INPUT", "A non-empty idempotencyKey is required.");
  }
  const idempotencyKey = rawKey.trim().slice(0, 100);

  return {
    sourceType,
    sourceKey,
    sourceAssetId,
    sourceDurationSeconds: durationNum,
    sourceWidth: width,
    sourceHeight: height,
    isVisualOnly,
    targetAspectRatio,
    targetFraming,
    burnSubtitles,
    requestedClipsCount,
    prompt,
    idempotencyKey,
  };
}

/**
 * Counts user video clipping jobs created within a given UTC day range.
 */
export function countDailyClipJobs(
  db: Pick<Prisma.TransactionClient, "generationJob">,
  userId: string,
  day: { start: Date; end: Date },
) {
  return db.generationJob.count({
    where: {
      userId,
      type: GenerationType.VIDEO_CLIP,
      createdAt: { gte: day.start, lt: day.end },
      status: { in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING, GenerationStatus.COMPLETED] },
    },
  });
}

export interface CreateClipperJobInput {
  userId: string;
  sourceType?: unknown;
  sourceKey: unknown;
  sourceAssetId?: unknown;
  sourceDurationSeconds?: unknown;
  sourceWidth?: unknown;
  sourceHeight?: unknown;
  isVisualOnly?: unknown;
  targetAspectRatio?: unknown;
  targetFraming?: unknown;
  burnSubtitles?: unknown;
  requestedClipsCount?: unknown;
  prompt?: unknown;
  idempotencyKey: unknown;
  userTier?: unknown;
}

export interface CreateClipperJobOverrides {
  now?: Date;
  engine?: string;
  model?: string;
  creditCost?: number;
  /** Server-derived settings (Batch 5): metadata origin, verified size, analysis capabilities. */
  extraSettings?: Pick<ClipperJobSettings, "sourceMetadataOrigin" | "sourceSizeBytes" | "analysis">;
}

/**
 * Creates a video clipping job with ACID credit debit in ONE short transaction:
 *   1. Validate untrusted inputs and user ownership.
 *   2. Lock User row (FOR UPDATE) to serialize job creation per user.
 *   3. Check idempotency replay (same key + same settings -> returns existing job; conflict -> throws).
 *   4. Check daily clipping generation quota.
 *   5. Check active generation concurrency across ALL types (IMAGE, VIDEO, VIDEO_CLIP).
 *   6. Insert GenerationJob (type: VIDEO_CLIP, status: PENDING).
 *   7. Debit credit wallet atomically with job-linked ledger entry.
 */
export async function createClipperJob(
  input: CreateClipperJobInput,
  overrides: CreateClipperJobOverrides = {},
  db: typeof prisma = prisma,
): Promise<{ job: ClipperJob; replayed: boolean }> {
  assertSafeIdentifier("userId", input.userId);
  const validated = validateClipperRequestInput(input, input.userId);
  const { userId } = input;
  const now = overrides.now ?? new Date();
  const day = utcDayRange(now);

  const dailyLimit = getDailyUserClipLimit(input.userTier);
  const effectiveCreditCost =
    overrides.creditCost !== undefined
      ? overrides.creditCost
      : getClipperCreditCost({ clipsCount: validated.requestedClipsCount });

  const jobSettings: ClipperJobSettings = {
    sourceType: validated.sourceType,
    sourceAssetId: validated.sourceAssetId,
    sourceKey: validated.sourceKey,
    sourceDurationSeconds: validated.sourceDurationSeconds,
    sourceWidth: validated.sourceWidth,
    sourceHeight: validated.sourceHeight,
    isVisualOnly: validated.isVisualOnly,
    targetAspectRatio: validated.targetAspectRatio,
    targetFraming: validated.targetFraming,
    burnSubtitles: validated.burnSubtitles,
    requestedClipsCount: validated.requestedClipsCount,
    engine: overrides.engine ?? DEFAULT_CLIPPER_ENGINE,
    // Only ephemeral uploads are ever scheduled for deletion. A platform_asset source is the
    // user's own permanent generated video and must never be deleted by the clipper.
    pendingCleanups: validated.sourceType === "upload" ? [validated.sourceKey] : [],
    cleanupStatus: validated.sourceType === "upload" ? "pending" : "cleaned",
    cleanupAudit: [],
    ...(overrides.extraSettings ?? {}),
  };

  try {
    return await db.$transaction(async (tx) => {
      // 1. Serialize all generation creation for this user
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (locked.length === 0) throw new AccountingError("USER_NOT_FOUND");

      // 2. Idempotency replay check
      const existing = await tx.generationJob.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: validated.idempotencyKey } },
        select: clipperJobSelect,
      });

      if (existing) {
        const prev = existing.settings as Partial<ClipperJobSettings> | null;
        if (
          existing.type !== GenerationType.VIDEO_CLIP ||
          prev?.sourceKey !== validated.sourceKey ||
          prev?.targetAspectRatio !== validated.targetAspectRatio ||
          prev?.targetFraming !== validated.targetFraming ||
          prev?.requestedClipsCount !== validated.requestedClipsCount
        ) {
          throw new AccountingError("IDEMPOTENCY_CONFLICT");
        }
        return { job: existing, replayed: true };
      }

      // 3. Check daily clipping quota
      const usedToday = await countDailyClipJobs(tx, userId, day);
      if (usedToday >= dailyLimit) {
        throw new AccountingError("DAILY_LIMIT_REACHED", "You have reached your daily video clipping limit.");
      }

      // 4. Check active generation concurrency across ALL types (IMAGE, VIDEO, VIDEO_CLIP)
      const active = await tx.generationJob.findFirst({
        where: { userId, status: { in: ACTIVE_STATUSES } },
        select: { id: true, type: true },
      });
      if (active) {
        throw new AccountingError("ACTIVE_JOB_EXISTS");
      }

      // 5. Insert GenerationJob record
      const job = await tx.generationJob.create({
        data: {
          userId,
          type: GenerationType.VIDEO_CLIP,
          status: GenerationStatus.PENDING,
          prompt: validated.prompt,
          provider: overrides.engine ?? DEFAULT_CLIPPER_ENGINE,
          model: overrides.model ?? "clipper-v1",
          settings: jobSettings as unknown as Prisma.InputJsonValue,
          estimatedCredits: effectiveCreditCost,
          chargedCredits: 0,
          idempotencyKey: validated.idempotencyKey,
          createdAt: now,
        },
        select: clipperJobSelect,
      });

      // 6. Atomic wallet debit
      await debitWallet(tx, {
        userId,
        amount: effectiveCreditCost,
        jobId: job.id,
        idempotencyKey: jobDebitKey(job.id),
        description: `AI video clipping (${validated.requestedClipsCount} clip${validated.requestedClipsCount > 1 ? "s" : ""})`,
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
 * PENDING -> PROCESSING transition when worker picks up the clipping task.
 */
export async function markClipperJobStarted(
  params: {
    jobId: string;
    engine?: string;
    now?: Date;
  },
  db: typeof prisma = prisma,
): Promise<boolean> {
  const { jobId, engine, now = new Date() } = params;

  const { count } = await db.generationJob.updateMany({
    where: { id: jobId, status: GenerationStatus.PENDING },
    data: {
      status: GenerationStatus.PROCESSING,
      ...(engine ? { provider: engine } : {}),
      startedAt: now,
    },
  });

  return count === 1;
}

export interface ClaimClipperLeaseResult {
  claimed: boolean;
  token?: string;
  expiresAt?: Date;
  reason?: string;
}

/**
 * Atomically claims the exclusive worker lease for a clipper job:
 *   - Only matches if status is 'PROCESSING'.
 *   - Only matches if ingestionToken IS NULL OR ingestionLeaseExpiresAt < now().
 *   - Updates ingestionToken and sets expiration (default 5 minutes).
 */
export async function claimClipperLease(
  params: {
    jobId: string;
    customToken?: string;
    leaseDurationMs?: number;
  },
  db: typeof prisma = prisma,
): Promise<ClaimClipperLeaseResult> {
  const token = params.customToken ?? crypto.randomUUID();
  const leaseMs = params.leaseDurationMs ?? CLIPPER_INGESTION_LEASE_MS;

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
 * Renews an active worker lease to prevent premature timeout during multi-clip rendering.
 */
export async function renewClipperLease(
  params: {
    jobId: string;
    token: string;
    extensionMs?: number;
  },
  db: typeof prisma = prisma,
): Promise<boolean> {
  const extensionMs = params.extensionMs ?? CLIPPER_INGESTION_LEASE_MS;

  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "GenerationJob"
    SET "ingestionLeaseExpiresAt" = now() + (${extensionMs} * interval '1 millisecond'),
        "updatedAt" = now()
    WHERE "id" = ${params.jobId}
      AND "status" = 'PROCESSING'
      AND "ingestionToken" = ${params.token}
      AND ("ingestionLeaseExpiresAt" IS NULL OR "ingestionLeaseExpiresAt" > now())
    RETURNING "id"`;

  return rows.length === 1;
}

/**
 * Completes a video clipping job and inserts its GeneratedAsset records in ONE transaction:
 *   - Guarded transition: PROCESSING -> COMPLETED only if ingestionToken matches the lease holder.
 *   - Finalizes chargedCredits = estimatedCredits (NO credit refund).
 *   - Inserts GeneratedAsset records for each rendered clip.
 *   - Records renderedClips and highlights in job settings.
 *   - Adds source storage key to pendingCleanups for decoupled post-completion deletion.
 *
 * Throws JobNotCompletableError if the lease was lost or expired, or job was already settled.
 */
export async function completeClipperJobWithAssets(
  params: {
    jobId: string;
    ingestionToken: string;
    clips: CompletedClipAssetInput[];
    highlights?: CandidateHighlight[];
  },
  db: typeof prisma = prisma,
): Promise<{ jobId: string; assetIds: string[] }> {
  const { jobId, ingestionToken, clips, highlights } = params;

  if (clips.length === 0) {
    throw new JobNotCompletableError(jobId, "Cannot complete clipper job with zero rendered clips.");
  }

  return db.$transaction(async (tx) => {
    // 1. Guarded update on GenerationJob
    const rows = await tx.$queryRaw<{ id: string; userId: string; estimatedCredits: number; settings: any }[]>`
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
        AND (j."ingestionLeaseExpiresAt" IS NULL OR j."ingestionLeaseExpiresAt" > now())
      RETURNING j."id", j."userId", j."estimatedCredits", j."settings"`;

    if (rows.length === 0) {
      throw new JobNotCompletableError(jobId, "Job is not in PROCESSING state with matching ingestionToken");
    }

    const job = rows[0];
    const assetIds: string[] = [];
    const renderedRecords: RenderedClipRecord[] = [];

    // 2. Insert all GeneratedAsset records
    for (const clip of clips) {
      if (clip.userId !== job.userId) {
        throw new JobNotCompletableError(jobId, "Clip asset owner does not match job owner");
      }

      const assetId = clip.assetId ?? crypto.randomUUID();
      assetIds.push(assetId);

      await tx.generatedAsset.create({
        data: {
          id: assetId,
          userId: clip.userId,
          jobId,
          type: AssetType.VIDEO,
          storageKey: clip.storageKey,
          thumbnailKey: clip.thumbnailKey ?? null,
          mimeType: clip.mimeType ?? "video/mp4",
          width: clip.width,
          height: clip.height,
          durationSeconds: clip.durationSeconds,
          fileSize: BigInt(clip.sizeBytes),
        },
        select: { id: true },
      });

      renderedRecords.push({
        clipId: clip.clipId,
        assetId,
        storageKey: clip.storageKey,
        thumbnailKey: clip.thumbnailKey ?? undefined,
        durationSeconds: clip.durationSeconds,
        width: clip.width,
        height: clip.height,
        fileSizeBytes: clip.sizeBytes,
        aspectRatio: clip.aspectRatio,
        title: clip.title,
      });
    }

    // 3. Update job settings with rendered clips and highlights
    const currentSettings = (job.settings as ClipperJobSettings) ?? {};
    const updatedSettings: ClipperJobSettings = {
      ...currentSettings,
      highlights: highlights ?? currentSettings.highlights,
      renderedClips: renderedRecords,
      // Nothing scheduled (e.g. platform_asset source) => already clean, so the retry sweep skips it.
      cleanupStatus: (currentSettings.pendingCleanups?.length ?? 0) > 0 ? "pending" : "cleaned",
    };

    await tx.generationJob.update({
      where: { id: jobId },
      data: { settings: updatedSettings as unknown as Prisma.InputJsonValue },
    });

    return { jobId, assetIds };
  }, TX_OPTIONS);
}

/**
 * Transitions an active clipper job (PENDING or PROCESSING) to FAILED and refunds debited credits exactly once.
 * Subsequent or duplicate calls match zero rows and perform no refund.
 */
export async function failClipperJob(
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
      description: "Refund: video clipping failed",
    });

    return { settled: true, refund };
  }, TX_OPTIONS);
}

/**
 * Worker-side failure settlement, FENCED by the lease token:
 *   - Only PROCESSING jobs whose ingestionToken matches AND whose lease has not expired.
 *   - A worker that lost (or let expire) its lease matches zero rows: it can never fail,
 *     refund or overwrite a job now owned by another worker or already settled.
 *   - Refund is idempotent via refundJobDebit (job-refund:<jobId>).
 * Expired-lease jobs are settled by reconcileStaleClipperJobs instead.
 */
export async function failClipperJobFenced(
  params: { jobId: string; ingestionToken: string; reason: string },
  db: typeof prisma = prisma,
): Promise<{ settled: boolean; refund: Awaited<ReturnType<typeof refundJobDebit>> }> {
  const { jobId, ingestionToken, reason } = params;
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
        AND "status" = 'PROCESSING'
        AND "ingestionToken" = ${ingestionToken}
        AND ("ingestionLeaseExpiresAt" IS NULL OR "ingestionLeaseExpiresAt" > now())
      RETURNING "id"`;

    if (rows.length === 0) {
      return { settled: false, refund: null };
    }

    const refund = await refundJobDebit(tx, {
      jobId,
      description: "Refund: video clipping failed",
    });

    return { settled: true, refund };
  }, TX_OPTIONS);
}

export interface ClipperCleanupResult {
  key: string;
  success: boolean;
  error?: string;
}

/**
 * Records storage deletion outcomes (source or orphaned outputs) on the job's settings.
 *   - Successful keys are removed from pendingCleanups; failed keys are ADDED (deduplicated)
 *     so a retry sweep can find them.
 *   - The row is locked (FOR UPDATE) for the read-modify-write so concurrent settings writers
 *     (e.g. a completion by another lease holder) are never lost.
 *   - Never touches status, credits or the ledger.
 */
export async function recordClipperCleanupResults(
  params: {
    jobId: string;
    results: ClipperCleanupResult[];
    /** Keys removed from automatic retry (ineligible or over the attempt cap) — flagged for review. */
    abandonKeys?: { key: string; reason: string }[];
    /** Recompute cleanupStatus even with no new results (e.g. stale "pending" with an empty list). */
    finalize?: boolean;
    now?: Date;
  },
  db: typeof prisma = prisma,
): Promise<boolean> {
  const { jobId, results, abandonKeys = [], finalize = false, now = new Date() } = params;
  if (results.length === 0 && abandonKeys.length === 0 && !finalize) return true;

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; settings: unknown }[]>`
      SELECT "id", "settings" FROM "GenerationJob" WHERE "id" = ${jobId} FOR UPDATE`;
    if (rows.length === 0) return false;

    const current = ((rows[0].settings as Partial<ClipperJobSettings> | null) ?? {}) as Partial<ClipperJobSettings>;
    const pending = new Set(current.pendingCleanups ?? []);
    const audit = [...(current.cleanupAudit ?? [])];

    for (const r of results) {
      if (r.success) pending.delete(r.key);
      else pending.add(r.key);
      audit.push({
        key: r.key,
        action: "delete",
        timestamp: now.toISOString(),
        success: r.success,
        error: r.error?.slice(0, 200),
      });
    }

    for (const a of abandonKeys) {
      pending.delete(a.key);
      audit.push({ key: a.key, action: "delete", timestamp: now.toISOString(), success: false, error: `ABANDONED:${a.reason}`.slice(0, 200) });
    }

    const pendingCleanups = [...pending];
    const reviewNeeded = abandonKeys.length > 0 || current.cleanupStatus === "needs_review";
    const updated = {
      ...current,
      pendingCleanups,
      cleanupStatus:
        pendingCleanups.length > 0 ? ("failed" as const) : reviewNeeded ? ("needs_review" as const) : ("cleaned" as const),
      // Bound the audit trail so a flapping storage backend cannot grow the row indefinitely.
      cleanupAudit: audit.slice(-50),
    };

    await tx.generationJob.update({
      where: { id: jobId },
      data: { settings: updated as unknown as Prisma.InputJsonValue },
    });
    return true;
  }, TX_OPTIONS);
}

/** Read-only snapshot used by the worker after an ambiguous completion and by cleanup retries. */
export async function getClipperJobCleanupState(
  jobId: string,
  db: typeof prisma = prisma,
): Promise<{ id: string; userId: string; status: GenerationStatus; settings: Partial<ClipperJobSettings>; assetKeys: string[] } | null> {
  const job = await db.generationJob.findUnique({
    where: { id: jobId },
    select: { id: true, userId: true, status: true, type: true, settings: true },
  });
  if (!job || job.type !== GenerationType.VIDEO_CLIP) return null;
  const assets = await db.generatedAsset.findMany({
    where: { jobId },
    select: { storageKey: true, thumbnailKey: true },
  });
  const assetKeys = assets.flatMap((a) => [a.storageKey, a.thumbnailKey].filter((k): k is string => Boolean(k)));
  return {
    id: job.id,
    userId: job.userId,
    status: job.status,
    settings: (job.settings as Partial<ClipperJobSettings> | null) ?? {},
    assetKeys,
  };
}

/**
 * Transitions an active clipper job (PENDING or PROCESSING) to CANCELLED and refunds debited credits exactly once.
 */
export async function cancelClipperJob(
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
      description: "Refund: video clipping cancelled",
    });

    return { settled: true, refund };
  }, TX_OPTIONS);
}

export interface ReconcileStaleClipperJobsResult {
  checked: number;
  settled: number;
}

/**
 * Sweeps and recovers stale clipper jobs:
 *   - Stale PENDING jobs older than pendingThresholdMs (default 5 min).
 *   - Stale PROCESSING jobs with expired worker lease older than processingThresholdMs (default 15 min).
 */
export async function reconcileStaleClipperJobs(
  params: {
    pendingThresholdMs?: number;
    processingThresholdMs?: number;
    now?: Date;
  } = {},
  db: typeof prisma = prisma,
): Promise<ReconcileStaleClipperJobsResult> {
  const now = params.now ?? new Date();
  const pendingCutoff = new Date(now.getTime() - (params.pendingThresholdMs ?? CLIPPER_PENDING_STALE_MS));
  const processingCutoff = new Date(now.getTime() - (params.processingThresholdMs ?? CLIPPER_PROCESSING_STALE_MS));

  // Find candidate stale jobs
  const candidates = await db.generationJob.findMany({
    where: {
      type: GenerationType.VIDEO_CLIP,
      OR: [
        { status: GenerationStatus.PENDING, createdAt: { lt: pendingCutoff } },
        {
          status: GenerationStatus.PROCESSING,
          OR: [
            { ingestionLeaseExpiresAt: { lt: now }, startedAt: { lt: processingCutoff } },
            { ingestionLeaseExpiresAt: null, startedAt: { lt: processingCutoff } },
          ],
        },
      ],
    },
    select: { id: true, status: true },
  });

  let settled = 0;
  for (const job of candidates) {
    const reason =
      job.status === GenerationStatus.PENDING
        ? "Clipper job timed out waiting for worker pickup (5m timeout)"
        : "Clipper worker lease expired and did not report completion (15m timeout)";

    const res = await failClipperJob(job.id, reason, db);
    if (res.settled) settled++;
  }

  return { checked: candidates.length, settled };
}

/**
 * Records an ephemeral source storage cleanup attempt in job settings:
 *   - Decoupled from credit ledger accounting.
 *   - Updates pendingCleanups, cleanupStatus, and appends a record to cleanupAudit.
 */
export async function recordClipperSourceCleanup(
  params: {
    jobId: string;
    storageKey: string;
    success: boolean;
    error?: string;
    now?: Date;
  },
  db: typeof prisma = prisma,
): Promise<boolean> {
  const { jobId, storageKey, success, error, now = new Date() } = params;

  const auditEntry: CleanupAuditRecord = {
    key: storageKey,
    action: "delete",
    timestamp: now.toISOString(),
    success,
    error,
  };

  return db.$transaction(async (tx) => {
    const job = await tx.generationJob.findUnique({
      where: { id: jobId },
      select: { settings: true },
    });

    if (!job) return false;

    const current = ((job.settings as unknown) as Partial<ClipperJobSettings>) ?? {};
    const pendingCleanups = (current.pendingCleanups ?? []).filter((k) => (success ? k !== storageKey : true));
    const cleanupAudit = [...(current.cleanupAudit ?? []), auditEntry];
    const cleanupStatus = pendingCleanups.length === 0 ? ("cleaned" as const) : ("failed" as const);

    const updatedSettings: Record<string, unknown> = {
      ...current,
      pendingCleanups,
      cleanupStatus,
      cleanupAudit,
    };

    await tx.generationJob.update({
      where: { id: jobId },
      data: { settings: updatedSettings as Prisma.InputJsonValue },
    });

    return true;
  });
}
