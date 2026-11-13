-- CreateEnum
CREATE TYPE "AbuseReportCategory" AS ENUM ('CSAM', 'EXTREME_VIOLENCE', 'SELF_HARM', 'HATE_SPEECH', 'HARASSMENT', 'COPYRIGHT_INFRINGEMENT', 'SPAM_OR_ABUSE', 'OTHER');

-- CreateEnum
CREATE TYPE "ModerationQueueStatus" AS ENUM ('PENDING_REVIEW', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ModerationAction" AS ENUM ('DISMISS', 'HIDE_CONTENT', 'SUSPEND_USER', 'WARN_USER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isSuspended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT,
ADD COLUMN     "warningCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastWarningAt" TIMESTAMP(3),
ADD COLUMN     "lastWarningReason" TEXT;

-- AlterTable
ALTER TABLE "GeneratedAsset" ADD COLUMN     "isHidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hiddenAt" TIMESTAMP(3),
ADD COLUMN     "hiddenBy" TEXT,
ADD COLUMN     "hiddenReason" TEXT;

-- CreateTable
CREATE TABLE "AbuseReport" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "category" "AbuseReportCategory" NOT NULL,
    "details" TEXT NOT NULL,
    "status" "ModerationQueueStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reporterId" TEXT,
    "reportedUserId" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "actionTaken" "ModerationAction",
    "resolutionNotes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbuseReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAuditLog" (
    "id" TEXT NOT NULL,
    "reportId" TEXT,
    "operatorId" TEXT NOT NULL,
    "action" "ModerationAction" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "previousStatus" "ModerationQueueStatus",
    "newStatus" "ModerationQueueStatus",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbuseReport_status_createdAt_idx" ON "AbuseReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AbuseReport_targetType_targetId_idx" ON "AbuseReport"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AbuseReport_reportedUserId_idx" ON "AbuseReport"("reportedUserId");

-- CreateIndex
CREATE INDEX "AbuseReport_reporterId_idx" ON "AbuseReport"("reporterId");

-- CreateIndex
CREATE INDEX "ModerationAuditLog_reportId_idx" ON "ModerationAuditLog"("reportId");

-- CreateIndex
CREATE INDEX "ModerationAuditLog_targetType_targetId_idx" ON "ModerationAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ModerationAuditLog_operatorId_createdAt_idx" ON "ModerationAuditLog"("operatorId", "createdAt");

-- AddForeignKey
ALTER TABLE "AbuseReport" ADD CONSTRAINT "AbuseReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseReport" ADD CONSTRAINT "AbuseReport_reportedUserId_fkey" FOREIGN KEY ("reportedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAuditLog" ADD CONSTRAINT "ModerationAuditLog_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "AbuseReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
