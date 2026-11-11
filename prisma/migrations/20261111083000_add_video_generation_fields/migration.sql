-- AlterTable: Add video ingestion lease columns to GenerationJob
ALTER TABLE "GenerationJob" ADD COLUMN "ingestionToken" TEXT;
ALTER TABLE "GenerationJob" ADD COLUMN "ingestionLeaseExpiresAt" TIMESTAMP(3);

-- AlterTable: Add durationSeconds and thumbnailKey to GeneratedAsset
ALTER TABLE "GeneratedAsset" ADD COLUMN "durationSeconds" DOUBLE PRECISION;
ALTER TABLE "GeneratedAsset" ADD COLUMN "thumbnailKey" TEXT;

-- CreateIndex: Efficient lookup for expired ingestion leases during reconciliation
CREATE INDEX "GenerationJob_status_ingestionLeaseExpiresAt_idx" ON "GenerationJob"("status", "ingestionLeaseExpiresAt");

-- AddCheckConstraints: Data integrity guards
-- 1. Lease consistency: exactly two valid states permitted:
--    (ingestionToken IS NULL AND ingestionLeaseExpiresAt IS NULL) OR
--    (ingestionToken IS NOT NULL AND ingestionLeaseExpiresAt IS NOT NULL)
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_ingestion_lease_consistency"
  CHECK (
    ("ingestionToken" IS NULL AND "ingestionLeaseExpiresAt" IS NULL) OR
    ("ingestionToken" IS NOT NULL AND "ingestionLeaseExpiresAt" IS NOT NULL)
  );

-- 2. Asset duration (if set) must be strictly positive
ALTER TABLE "GeneratedAsset" ADD CONSTRAINT "GeneratedAsset_duration_positive"
  CHECK ("durationSeconds" IS NULL OR "durationSeconds" > 0);
