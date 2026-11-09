-- CreateEnum
CREATE TYPE "BudgetReservationStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "jobId" TEXT;

-- AlterTable
ALTER TABLE "GeneratedAsset" ADD COLUMN     "height" INTEGER,
ADD COLUMN     "storageKey" TEXT NOT NULL,
ADD COLUMN     "width" INTEGER,
ALTER COLUMN "fileUrl" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "settings" JSONB,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProviderDailyBudget" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "limitCentiNeurons" INTEGER NOT NULL,
    "reservedCentiNeurons" INTEGER NOT NULL DEFAULT 0,
    "consumedCentiNeurons" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderDailyBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderBudgetReservation" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "BudgetReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedCentiNeurons" INTEGER NOT NULL,
    "actualCentiNeurons" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "ProviderBudgetReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderDailyBudget_provider_day_key" ON "ProviderDailyBudget"("provider", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderBudgetReservation_jobId_key" ON "ProviderBudgetReservation"("jobId");

-- CreateIndex
CREATE INDEX "ProviderBudgetReservation_budgetId_status_idx" ON "ProviderBudgetReservation"("budgetId", "status");

-- CreateIndex
CREATE INDEX "ProviderBudgetReservation_status_createdAt_idx" ON "ProviderBudgetReservation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_jobId_idx" ON "CreditTransaction"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationJob_userId_idempotencyKey_key" ON "GenerationJob"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderBudgetReservation" ADD CONSTRAINT "ProviderBudgetReservation_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "ProviderDailyBudget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderBudgetReservation" ADD CONSTRAINT "ProviderBudgetReservation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written integrity rules (not expressible in the Prisma schema).
-- All are additive; existing rows were verified to satisfy them before applying.
-- ---------------------------------------------------------------------------

-- Wallet balances can never go negative, even if application code has a bug.
ALTER TABLE "CreditWallet" ADD CONSTRAINT "CreditWallet_balance_non_negative" CHECK ("balance" >= 0);

-- Daily provider budget counters stay within sane bounds.
ALTER TABLE "ProviderDailyBudget"
  ADD CONSTRAINT "ProviderDailyBudget_limit_positive" CHECK ("limitCentiNeurons" > 0),
  ADD CONSTRAINT "ProviderDailyBudget_reserved_non_negative" CHECK ("reservedCentiNeurons" >= 0),
  ADD CONSTRAINT "ProviderDailyBudget_consumed_non_negative" CHECK ("consumedCentiNeurons" >= 0);

-- Reservation amounts are positive, and each status has consistent settlement fields:
-- RESERVED: not settled; CONSUMED: settled with actual usage; RELEASED: settled, no usage.
ALTER TABLE "ProviderBudgetReservation"
  ADD CONSTRAINT "ProviderBudgetReservation_reserved_positive" CHECK ("reservedCentiNeurons" > 0),
  ADD CONSTRAINT "ProviderBudgetReservation_actual_non_negative" CHECK ("actualCentiNeurons" IS NULL OR "actualCentiNeurons" >= 0),
  ADD CONSTRAINT "ProviderBudgetReservation_status_consistency" CHECK (
    ("status" = 'RESERVED' AND "settledAt" IS NULL AND "actualCentiNeurons" IS NULL) OR
    ("status" = 'CONSUMED' AND "settledAt" IS NOT NULL AND "actualCentiNeurons" IS NOT NULL) OR
    ("status" = 'RELEASED' AND "settledAt" IS NOT NULL AND "actualCentiNeurons" IS NULL)
  );

-- At most one active (PENDING/PROCESSING) generation job per user.
CREATE UNIQUE INDEX "GenerationJob_one_active_per_user"
  ON "GenerationJob" ("userId")
  WHERE "status" IN ('PENDING', 'PROCESSING');
