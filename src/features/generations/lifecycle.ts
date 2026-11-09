import { GenerationStatus, GenerationType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { utcDayRange } from "@/lib/utc";
import { debitWallet, jobDebitKey, refundJobDebit } from "@/features/credits/ledger";
import {
  consumeReservation,
  ensureBudgetDay,
  releaseReservation,
  reserveNeuronsForJob,
} from "@/features/budget/neuron-budget";
import {
  DAILY_NEURON_LIMIT_CENTI,
  DAILY_USER_IMAGE_LIMIT,
  IMAGE_MODEL,
  IMAGE_PROVIDER,
  IMAGE_QUALITIES,
  PENDING_STALE_MS,
  PROCESSING_STALE_MS,
  PROMPT_MAX_LENGTH,
  PROMPT_MIN_LENGTH,
  isImageQuality,
  type ImageQuality,
} from "./config";
import { AccountingError } from "./errors";

/*
 * Image job lifecycle and its accounting.
 *
 *   createImageJob ──► PENDING        (credits debited + Neurons RESERVED, one transaction)
 *   markJobStarted ──► PROCESSING     (committed BEFORE the provider is called)
 *   recordProviderSuccess             (reservation CONSUMED with actual usage)
 *   completeJob    ──► COMPLETED      (only after provider success; nothing refunded)
 *
 * Failure paths (each settles exactly once via a guarded job-status transition):
 *   failJobProviderNotRun        provider definitely did not run → release + refund
 *   failJobAfterProviderSuccess  provider ran, a later stage failed → keep usage + refund
 *   markProviderOutcomeUnknown   provider MAY have run → no settlement; reconcile later
 *   reconcileStaleJobs           settles jobs that can no longer have a request in flight
 *
 * No function here calls an external service, and every transaction is short.
 */

// Generous limits: the dev database is ~200 ms per round trip away. Locks on the shared
// budget row are still held for only one statement + COMMIT.
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const ACTIVE_STATUSES = [GenerationStatus.PENDING, GenerationStatus.PROCESSING];
/** Only used for legacy image jobs that pre-date budget reservations. */
const LEGACY_COUNTED_STATUSES = [GenerationStatus.PENDING, GenerationStatus.PROCESSING, GenerationStatus.COMPLETED];

/**
 * Per-user daily allowance usage. The provider reservation is the source of truth:
 *  - RESERVED: in flight; the provider may run or may have run → counts
 *  - CONSUMED: the provider ran (or was conservatively charged by reconciliation),
 *              even if the job then FAILED and was refunded → counts
 *  - RELEASED: the provider definitely never ran → does not count (failure stays retryable)
 * One row per job, so a job is counted at most once whatever transitions it goes through.
 * Image jobs without a reservation (pre-pipeline data) fall back to their job status.
 */
export function countDailyImageJobs(db: Pick<Prisma.TransactionClient, "generationJob">, userId: string, day: { start: Date; end: Date }) {
  return db.generationJob.count({
    where: {
      userId,
      type: GenerationType.IMAGE,
      createdAt: { gte: day.start, lt: day.end },
      OR: [
        { budgetReservation: { is: { status: { in: ["RESERVED", "CONSUMED"] } } } },
        { budgetReservation: { is: null }, status: { in: LEGACY_COUNTED_STATUSES } },
      ],
    },
  });
}
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export type ImageJobSettings = {
  quality: ImageQuality;
  steps: number;
  credits: number;
  reservedCentiNeurons: number;
};

const jobSelect = {
  id: true,
  userId: true,
  status: true,
  prompt: true,
  settings: true,
  estimatedCredits: true,
  chargedCredits: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} as const;

export type ImageJob = Prisma.GenerationJobGetPayload<{ select: typeof jobSelect }>;

/** Test-only overrides; production callers never pass these. */
export type AccountingOverrides = { now?: Date; provider?: string; dailyNeuronLimit?: number };

/** Validation happens before any transaction, so invalid input never debits or reserves. */
export function validateImageRequest(input: { prompt: unknown; quality: unknown; idempotencyKey: unknown }) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length < PROMPT_MIN_LENGTH || prompt.length > PROMPT_MAX_LENGTH) {
    throw new AccountingError("INVALID_INPUT", `Prompt must be ${PROMPT_MIN_LENGTH}-${PROMPT_MAX_LENGTH} characters.`);
  }
  if (!isImageQuality(input.quality)) throw new AccountingError("INVALID_INPUT", "Unknown quality option.");
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new AccountingError("INVALID_INPUT", "Invalid request key.");
  }
  return { prompt, quality: input.quality, idempotencyKey: input.idempotencyKey };
}

/**
 * Create an image job with all initial accounting in ONE short transaction:
 *   lock user row → idempotency replay → daily limit → one-active-job → create job
 *   → debit credits → reserve Neurons + insert reservation (last, single statement).
 * Any failure rolls everything back, so a job exists only if BOTH the debit and the
 * reservation succeeded. Repeating the same idempotency key returns the original job.
 * The day's budget row is created beforehand (outside the transaction) if missing.
 */
export async function createImageJob(
  input: { userId: string; prompt: unknown; quality: unknown; idempotencyKey: unknown },
  overrides: AccountingOverrides = {},
): Promise<{ job: ImageJob; replayed: boolean }> {
  const { prompt, quality, idempotencyKey } = validateImageRequest(input);
  const { userId } = input;
  const tier = IMAGE_QUALITIES[quality];
  const now = overrides.now ?? new Date();
  const day = utcDayRange(now); // one clock reading for both the user limit and the provider budget day
  const settings: ImageJobSettings = {
    quality,
    steps: tier.steps,
    credits: tier.credits,
    reservedCentiNeurons: tier.reservedCentiNeurons,
  };

  const provider = overrides.provider ?? IMAGE_PROVIDER;
  await ensureBudgetDay(prisma, { provider, dayKey: day.key, limit: overrides.dailyNeuronLimit ?? DAILY_NEURON_LIMIT_CENTI });

  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize all job creation for this user. Concurrent requests (any idempotency key)
      // queue here, so the daily count and idempotency check below see committed state.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (locked.length === 0) throw new AccountingError("USER_NOT_FOUND");

      const existing = await tx.generationJob.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        select: jobSelect,
      });
      if (existing) {
        const prev = existing.settings as Partial<ImageJobSettings> | null;
        if (existing.prompt !== prompt || prev?.quality !== quality) throw new AccountingError("IDEMPOTENCY_CONFLICT");
        return { job: existing, replayed: true };
      }

      const usedToday = await countDailyImageJobs(tx, userId, day);
      if (usedToday >= DAILY_USER_IMAGE_LIMIT) throw new AccountingError("DAILY_LIMIT_REACHED");

      const active = await tx.generationJob.findFirst({
        where: { userId, status: { in: ACTIVE_STATUSES } },
        select: { id: true },
      });
      if (active) throw new AccountingError("ACTIVE_JOB_EXISTS");

      const job = await tx.generationJob.create({
        data: {
          userId,
          type: GenerationType.IMAGE,
          status: GenerationStatus.PENDING,
          prompt,
          provider,
          model: IMAGE_MODEL,
          settings,
          estimatedCredits: tier.credits,
          idempotencyKey,
          createdAt: now,
        },
        select: jobSelect,
      });

      await debitWallet(tx, {
        userId,
        amount: tier.credits,
        jobId: job.id,
        idempotencyKey: jobDebitKey(job.id),
        description: `${tier.label} image generation`,
      });

      // Last: the shared budget row is locked only for this statement + COMMIT.
      await reserveNeuronsForJob(tx, { provider, dayKey: day.key, amount: tier.reservedCentiNeurons, jobId: job.id });

      return { job, replayed: false };
    }, TX_OPTIONS);
  } catch (error) {
    // Database backstops (should be unreachable thanks to the user-row lock).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AccountingError(String(error.message).includes("idempotencyKey") ? "IDEMPOTENCY_CONFLICT" : "ACTIVE_JOB_EXISTS");
    }
    throw error;
  }
}

/**
 * PENDING → PROCESSING. Must commit BEFORE calling the provider. Returns false if the job
 * was already settled (e.g. reconciled as stale); the caller must then NOT call the provider.
 */
export async function markJobStarted(jobId: string, now: Date = new Date()) {
  const { count } = await prisma.generationJob.updateMany({
    where: { id: jobId, status: GenerationStatus.PENDING },
    data: { status: GenerationStatus.PROCESSING, startedAt: now },
  });
  return count === 1;
}

/**
 * Provider succeeded: record actual usage (exactly once). The job stays PROCESSING until
 * the storage stage finishes, so provider success and job completion are separate steps.
 */
export async function recordProviderSuccess(jobId: string, actualCentiNeurons: number) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.generationJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (job?.status !== GenerationStatus.PROCESSING) return false;
    return consumeReservation(tx, { jobId, actualCentiNeurons });
  }, TX_OPTIONS);
}

/** PROCESSING → COMPLETED, only after provider success was recorded. Exactly once. */
export async function completeJob(jobId: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "GenerationJob" j
      SET "status" = 'COMPLETED', "chargedCredits" = j."estimatedCredits", "completedAt" = now(), "updatedAt" = now()
      WHERE j."id" = ${jobId} AND j."status" = 'PROCESSING'
        AND EXISTS (SELECT 1 FROM "ProviderBudgetReservation" r WHERE r."jobId" = j."id" AND r."status" = 'CONSUMED')
      RETURNING j."id"`;
    return rows.length === 1;
  }, TX_OPTIONS);
}

type ReservationMode = "release" | "consume-if-reserved";

/**
 * Settle a failed job exactly once. The guarded status transition (WHERE status IN …) is
 * the lock: concurrent or repeated calls block on the job row, then match zero rows and
 * do nothing. Within the same transaction it settles the reservation and refunds credits.
 */
async function settleFailedJob(jobId: string, reason: string, mode: ReservationMode, fromStatuses: GenerationStatus[]) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "GenerationJob"
      SET "status" = 'FAILED', "errorMessage" = ${reason}, "completedAt" = now(), "updatedAt" = now()
      WHERE "id" = ${jobId} AND "status"::text = ANY(${fromStatuses})
      RETURNING "id"`;
    if (rows.length === 0) return { settled: false as const };

    const reservation =
      mode === "release"
        ? (await releaseReservation(tx, { jobId })) && "released"
        : (await consumeReservation(tx, { jobId, actualCentiNeurons: null })) && "consumed-conservatively";

    const refund = await refundJobDebit(tx, { jobId, description: "Refund: generation failed" });
    return { settled: true as const, reservation: reservation || "already-settled", refund };
  }, TX_OPTIONS);
}

/**
 * The provider definitely did not run (validation rejection, 4xx such as quota exhausted,
 * or failure before the request was sent). Release the Neurons and refund the user.
 */
export function failJobProviderNotRun(jobId: string, reason: string) {
  return settleFailedJob(jobId, reason, "release", [GenerationStatus.PENDING, GenerationStatus.PROCESSING]);
}

/**
 * The provider ran and its usage was recorded, but a later stage (decode, validation,
 * storage) failed. Keep the consumed usage and refund the user, who received nothing.
 */
export function failJobAfterProviderSuccess(jobId: string, reason: string) {
  return settleFailedJob(jobId, reason, "consume-if-reserved", [GenerationStatus.PROCESSING]);
}

/**
 * The provider MAY have run (timeout, dropped connection, 5xx). Nothing is settled: the
 * reservation stays RESERVED and no refund is issued while a request could still be in
 * flight. reconcileStaleJobs settles it once that is no longer possible.
 */
export async function markProviderOutcomeUnknown(jobId: string, reason: string) {
  const { count } = await prisma.generationJob.updateMany({
    where: { id: jobId, status: GenerationStatus.PROCESSING },
    data: { errorMessage: `Awaiting reconciliation: ${reason}` },
  });
  return count === 1;
}

/**
 * Settle jobs that can no longer have a provider request in flight:
 *  - PENDING older than PENDING_STALE_MS: never started, so the provider never ran → release + refund.
 *  - PROCESSING older than PROCESSING_STALE_MS (by startedAt): any request has finished.
 *    Unknown usage is charged at the reserved amount (conservative); the user is refunded
 *    because no output was delivered.
 * Safe to run concurrently and repeatedly: each job settles at most once.
 */
export async function reconcileStaleJobs(options: { now?: Date; limit?: number; userId?: string } = {}) {
  const now = options.now ?? new Date();
  const take = options.limit ?? 50;
  const scope = options.userId ? { userId: options.userId } : {};

  const [pending, processing] = await Promise.all([
    prisma.generationJob.findMany({
      where: { ...scope, status: GenerationStatus.PENDING, createdAt: { lt: new Date(now.getTime() - PENDING_STALE_MS) } },
      select: { id: true },
      take,
    }),
    prisma.generationJob.findMany({
      where: { ...scope, status: GenerationStatus.PROCESSING, startedAt: { lt: new Date(now.getTime() - PROCESSING_STALE_MS) } },
      select: { id: true },
      take,
    }),
  ]);

  let settled = 0;
  for (const { id } of pending) {
    // fromStatuses is PENDING only: if the job started meanwhile, this matches nothing.
    const r = await settleFailedJob(id, "Generation did not start in time", "release", [GenerationStatus.PENDING]);
    if (r.settled) settled++;
  }
  for (const { id } of processing) {
    const r = await settleFailedJob(id, "Generation timed out", "consume-if-reserved", [GenerationStatus.PROCESSING]);
    if (r.settled) settled++;
  }
  return { checked: pending.length + processing.length, settled };
}
