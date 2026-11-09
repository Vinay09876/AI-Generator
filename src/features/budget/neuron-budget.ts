import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AccountingError } from "@/features/generations/errors";

/**
 * Provider capacity (Neuron) accounting, kept separate from user credits.
 *
 * The daily budget row is shared by every user, so statements that lock it are kept to a
 * single round trip each (CTEs), and the reservation runs last in its transaction. This
 * keeps the row lock to "one statement + COMMIT".
 */
type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

/**
 * Make sure the budget row for (provider, UTC day) exists. Safe under concurrency:
 * racing inserts resolve via the unique (provider, day) constraint. Runs outside the
 * job transaction so first-row creation never extends a transaction.
 */
export async function ensureBudgetDay(db: Db, params: { provider: string; dayKey: string; limit: number }) {
  await db.$executeRaw`
    INSERT INTO "ProviderDailyBudget" ("id", "provider", "day", "limitCentiNeurons", "updatedAt")
    VALUES (${randomUUID()}, ${params.provider}, ${params.dayKey}::date, ${params.limit}, now())
    ON CONFLICT ("provider", "day") DO NOTHING`;
}

/**
 * Atomically reserve capacity for a job and record the reservation, in ONE statement:
 * the guarded UPDATE only matches if reserved + consumed + amount stays within the limit;
 * the reservation row is inserted only from that UPDATE's result. Concurrent reservations
 * serialize on the budget row and each re-checks the condition, so the cap always holds.
 * Consumed usage (including any overage) counts toward the cap.
 */
export async function reserveNeuronsForJob(
  tx: Tx,
  params: { provider: string; dayKey: string; amount: number; jobId: string },
): Promise<string> {
  const { provider, dayKey, amount, jobId } = params;
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Reservation must be a positive integer.");

  const rows = await tx.$queryRaw<{ budgetId: string }[]>`
    WITH b AS (
      UPDATE "ProviderDailyBudget"
      SET "reservedCentiNeurons" = "reservedCentiNeurons" + ${amount}, "updatedAt" = now()
      WHERE "provider" = ${provider} AND "day" = ${dayKey}::date
        AND "reservedCentiNeurons" + "consumedCentiNeurons" + ${amount} <= "limitCentiNeurons"
      RETURNING "id"
    )
    INSERT INTO "ProviderBudgetReservation" ("id", "budgetId", "jobId", "reservedCentiNeurons")
    SELECT ${randomUUID()}, b."id", ${jobId}, ${amount} FROM b
    RETURNING "budgetId"`;
  if (rows.length === 0) throw new AccountingError("CAPACITY_EXHAUSTED");
  return rows[0].budgetId;
}

/**
 * RESERVED -> CONSUMED, exactly once, in one statement. Records actual provider usage
 * separately from the reserved amount and moves it from "reserved" to "consumed".
 * Actual may exceed the reservation; it is recorded as-is and counts toward the cap.
 * Pass null when actual usage is unknown to charge the reserved amount (conservative).
 * Returns false if the reservation was already settled (or does not exist).
 */
export async function consumeReservation(tx: Tx, params: { jobId: string; actualCentiNeurons: number | null }) {
  const { jobId, actualCentiNeurons } = params;
  if (actualCentiNeurons !== null && (!Number.isInteger(actualCentiNeurons) || actualCentiNeurons < 0)) {
    throw new Error("Actual usage must be a non-negative integer.");
  }

  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH r AS (
      UPDATE "ProviderBudgetReservation"
      SET "status" = 'CONSUMED',
          "actualCentiNeurons" = COALESCE(${actualCentiNeurons}::int, "reservedCentiNeurons"),
          "settledAt" = now()
      WHERE "jobId" = ${jobId} AND "status" = 'RESERVED'
      RETURNING "budgetId", "reservedCentiNeurons", "actualCentiNeurons"
    )
    UPDATE "ProviderDailyBudget" b
    SET "reservedCentiNeurons" = b."reservedCentiNeurons" - r."reservedCentiNeurons",
        "consumedCentiNeurons" = b."consumedCentiNeurons" + r."actualCentiNeurons",
        "updatedAt" = now()
    FROM r WHERE b."id" = r."budgetId"
    RETURNING b."id"`;
  return rows.length === 1;
}

/**
 * RESERVED -> RELEASED, exactly once, in one statement. Only for cases where the provider
 * definitely did not run. Returns false if the reservation was already settled.
 */
export async function releaseReservation(tx: Tx, params: { jobId: string }) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH r AS (
      UPDATE "ProviderBudgetReservation"
      SET "status" = 'RELEASED', "settledAt" = now()
      WHERE "jobId" = ${params.jobId} AND "status" = 'RESERVED'
      RETURNING "budgetId", "reservedCentiNeurons"
    )
    UPDATE "ProviderDailyBudget" b
    SET "reservedCentiNeurons" = b."reservedCentiNeurons" - r."reservedCentiNeurons", "updatedAt" = now()
    FROM r WHERE b."id" = r."budgetId"
    RETURNING b."id"`;
  return rows.length === 1;
}
