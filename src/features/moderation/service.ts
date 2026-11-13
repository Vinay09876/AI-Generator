import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type {
  AbuseReportInput,
  ActionModerationInput,
  ModerationItem,
  ModerationQueueStatus,
  ModerationAction,
} from "./types";

// Ephemeral, explicitly non-authoritative in-memory cache for development and test inspection.
// Production behavior never uses this as durable storage; all writes must commit to PostgreSQL.
const globalForModeration = globalThis as unknown as {
  inMemoryModerationQueue?: Map<string, ModerationItem>;
};

const inMemoryQueue =
  globalForModeration.inMemoryModerationQueue ?? new Map<string, ModerationItem>();

if (process.env.NODE_ENV !== "production") {
  globalForModeration.inMemoryModerationQueue = inMemoryQueue;
}

export class ModerationItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Moderation item ${id} not found.`);
    this.name = "ModerationItemNotFoundError";
  }
}

export class InvalidAbuseReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAbuseReportError";
  }
}

export class ModerationServiceUnavailableError extends Error {
  constructor(
    message: string = "Moderation persistence service is unavailable. Abuse reports and moderation actions must be durably recorded in PostgreSQL.",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ModerationServiceUnavailableError";
  }
}

/**
 * Submits an abuse report and registers it into the moderation queue.
 * Persists durably to PostgreSQL via Prisma. If database persistence fails or is
 * unavailable, throws ModerationServiceUnavailableError and does NOT store only in memory.
 */
export async function submitAbuseReport(
  input: AbuseReportInput,
  reporterId: string | null = null,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ModerationItem> {
  if (!input.targetId || typeof input.targetId !== "string" || input.targetId.trim().length === 0) {
    throw new InvalidAbuseReportError("targetId is required.");
  }

  if (!input.details || typeof input.details !== "string" || input.details.trim().length < 5) {
    throw new InvalidAbuseReportError("Details must be at least 5 characters.");
  }

  if (input.details.length > 2000) {
    throw new InvalidAbuseReportError("Details cannot exceed 2000 characters.");
  }

  const reportId = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  let targetExcerpt: string | undefined;

  // PostgreSQL persistence is mandatory. We do not report success or store in process memory
  // if the database write fails or client lacks abuseReport persistence.
  const persistOperation = async (tx: Prisma.TransactionClient | typeof prisma) => {
    // 1. If target is a generation job, inspect it and persist moderation metadata in settings JSONB
    if (input.targetType === "JOB") {
      const job = await tx.generationJob.findUnique({
        where: { id: input.targetId },
        select: { id: true, prompt: true, settings: true },
      });

      if (job) {
        targetExcerpt = job.prompt?.slice(0, 100);
        const currentSettings = (job.settings ?? {}) as Record<string, any>;
        const existingReports = Array.isArray(currentSettings.moderationReports)
          ? currentSettings.moderationReports
          : [];

        await tx.generationJob.update({
          where: { id: job.id },
          data: {
            settings: {
              ...currentSettings,
              moderationStatus: "PENDING_REVIEW",
              moderationReports: [
                ...existingReports,
                {
                  reportId,
                  category: input.category,
                  details: input.details,
                  reporterId,
                  reportedAt: now,
                },
              ],
            },
          },
        });
      }
    }

    // 2. Persist abuse report & initial audit log
    if (!("abuseReport" in tx) || typeof (tx as any).abuseReport?.create !== "function") {
      throw new Error("Client lacks durable abuseReport model persistence.");
    }

    await (tx as any).abuseReport.create({
      data: {
        id: reportId,
        targetType: input.targetType,
        targetId: input.targetId,
        category: input.category.toUpperCase(),
        details: input.details,
        status: "PENDING_REVIEW",
        reporterId: reporterId ?? undefined,
        metadata: { targetExcerpt },
        auditLogs: {
          create: {
            operatorId: "SYSTEM",
            action: "DISMISS",
            targetType: input.targetType,
            targetId: input.targetId,
            reason: "Abuse report ingested into moderation queue",
            previousStatus: "PENDING_REVIEW",
            newStatus: "PENDING_REVIEW",
          },
        },
      },
    });
  };

  try {
    if (typeof (client as any).$transaction === "function") {
      await (client as any).$transaction(persistOperation);
    } else {
      await persistOperation(client);
    }
  } catch (err: any) {
    if (err instanceof InvalidAbuseReportError) {
      throw err;
    }
    throw new ModerationServiceUnavailableError(
      `Moderation persistence service unavailable: failed to durably persist abuse report. ${err?.message || String(err)}`,
      err,
    );
  }

  const item: ModerationItem = {
    id: reportId,
    targetType: input.targetType,
    targetId: input.targetId,
    category: input.category,
    details: input.details,
    status: "PENDING_REVIEW",
    reporterId,
    reportedAt: now,
    targetExcerpt,
    auditHistory: [
      {
        timestamp: now,
        operatorId: "SYSTEM",
        action: "DISMISS",
        reason: "Abuse report ingested into moderation queue",
        previousStatus: "PENDING_REVIEW",
        newStatus: "PENDING_REVIEW",
      },
    ],
  };

  // Only populated in memory cache strictly after successful DB transaction commit.
  inMemoryQueue.set(reportId, item);
  return item;
}

/**
 * Retrieves the moderation queue with optional status filtering.
 * Queries PostgreSQL durably via Prisma. Never silently falls back to in-memory items on DB error.
 */
export async function getModerationQueue(
  filters: { status?: ModerationQueueStatus; take?: number } = {},
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ModerationItem[]> {
  if (!("abuseReport" in client) || typeof (client as any).abuseReport?.findMany !== "function") {
    throw new ModerationServiceUnavailableError(
      "Moderation persistence service unavailable: client lacks durable abuseReport model.",
    );
  }

  try {
    const dbReports = await (client as any).abuseReport.findMany({
      where: filters.status ? { status: filters.status } : undefined,
      orderBy: { createdAt: "desc" },
      take: filters.take,
      include: { auditLogs: { orderBy: { createdAt: "asc" } } },
    });

    return (dbReports || []).map((r: any) => ({
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      category: r.category.toLowerCase(),
      details: r.details,
      status: r.status,
      reporterId: r.reporterId,
      reportedAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : (r.createdAt || new Date().toISOString()),
      reviewedAt: r.reviewedAt instanceof Date ? r.reviewedAt.toISOString() : (r.reviewedAt || undefined),
      reviewedBy: r.reviewedBy,
      resolutionNotes: r.resolutionNotes,
      actionTaken: r.actionTaken,
      targetExcerpt: (r.metadata as any)?.targetExcerpt,
      auditHistory: (r.auditLogs || []).map((a: any) => ({
        timestamp: a.createdAt instanceof Date ? a.createdAt.toISOString() : (a.createdAt || new Date().toISOString()),
        operatorId: a.operatorId,
        action: a.action,
        reason: a.reason,
        previousStatus: a.previousStatus,
        newStatus: a.newStatus,
      })),
    }));
  } catch (err: any) {
    throw new ModerationServiceUnavailableError(
      `Moderation persistence service unavailable: failed to query moderation queue. ${err?.message || String(err)}`,
      err,
    );
  }
}

/**
 * Executes an administrative moderation action on a reported item.
 * Enforces actual content hiding, user suspension, warnings, or dismissal,
 * within an atomic database transaction. Considered successful ONLY after the database
 * transaction commits. Does not silently fall back to in-memory storage.
 */
export async function actionModerationItem(
  input: ActionModerationInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ModerationItem> {
  if (!input.operatorId) {
    throw new Error("operatorId is required to take a moderation action.");
  }

  if (!input.notes || input.notes.trim().length === 0) {
    throw new Error("Resolution notes are required for moderation actions.");
  }

  if (!("abuseReport" in client) || typeof (client as any).abuseReport?.findUnique !== "function") {
    throw new ModerationServiceUnavailableError(
      "Moderation persistence service unavailable: client lacks durable abuseReport model.",
    );
  }

  let dbReport: any;
  try {
    dbReport = await (client as any).abuseReport.findUnique({
      where: { id: input.reportId },
      include: { auditLogs: { orderBy: { createdAt: "asc" } } },
    });
  } catch (err: any) {
    throw new ModerationServiceUnavailableError(
      `Moderation persistence service unavailable: failed to retrieve report ${input.reportId}. ${err?.message || String(err)}`,
      err,
    );
  }

  if (!dbReport) {
    throw new ModerationItemNotFoundError(input.reportId);
  }

  const now = new Date().toISOString();
  const previousStatus = dbReport.status;
  const newStatus: ModerationQueueStatus = input.action === "DISMISS" ? "DISMISSED" : "ACTIONED";

  const executeActionTx = async (tx: Prisma.TransactionClient | typeof prisma) => {
    // 1. ENFORCE: HIDE_CONTENT
    // Makes content immediately inaccessible via normal user-facing gallery/media/download APIs
    if (input.action === "HIDE_CONTENT") {
      if (dbReport.targetType === "JOB") {
        const job = await tx.generationJob.findUnique({
          where: { id: dbReport.targetId },
          select: { id: true, userId: true, settings: true },
        });
        if (job) {
          const currentSettings = (job.settings ?? {}) as Record<string, any>;
          await tx.generationJob.update({
            where: { id: dbReport.targetId },
            data: {
              settings: {
                ...currentSettings,
                moderationStatus: "ACTIONED",
                contentHidden: true,
                hiddenAt: now,
                hiddenBy: input.operatorId,
                hiddenReason: input.notes,
              },
            },
          });

          // Also mark all associated assets as hidden
          if ("generatedAsset" in tx) {
            await tx.generatedAsset.updateMany({
              where: { jobId: dbReport.targetId },
              data: {
                isHidden: true,
                hiddenAt: new Date(now),
                hiddenBy: input.operatorId,
                hiddenReason: input.notes,
              },
            });
          }
        }
      } else if (dbReport.targetType === "ASSET") {
        if ("generatedAsset" in tx) {
          await tx.generatedAsset.update({
            where: { id: dbReport.targetId },
            data: {
              isHidden: true,
              hiddenAt: new Date(now),
              hiddenBy: input.operatorId,
              hiddenReason: input.notes,
            },
          });
        }
      }
    }

    // 2. ENFORCE: SUSPEND_USER
    // Suspends user account, records suspension reason, and revokes all active sessions immediately
    if (input.action === "SUSPEND_USER") {
      let targetUserId = dbReport.targetType === "USER" ? dbReport.targetId : null;
      if (!targetUserId && dbReport.targetType === "JOB") {
        const job = await tx.generationJob.findUnique({
          where: { id: dbReport.targetId },
          select: { userId: true },
        });
        targetUserId = job?.userId ?? null;
      }

      if (targetUserId) {
        await tx.user.update({
          where: { id: targetUserId },
          data: {
            isSuspended: true,
            suspendedAt: new Date(now),
            suspensionReason: input.notes,
          },
        });

        // Revoke all active sessions for suspended user immediately
        if ("session" in tx) {
          await tx.session.deleteMany({ where: { userId: targetUserId } });
        }
      }
    }

    // 3. ENFORCE: WARN_USER
    // Durably increments warningCount and records warning timestamp and reason on user record
    if (input.action === "WARN_USER") {
      let targetUserId = dbReport.targetType === "USER" ? dbReport.targetId : null;
      if (!targetUserId && dbReport.targetType === "JOB") {
        const job = await tx.generationJob.findUnique({
          where: { id: dbReport.targetId },
          select: { userId: true },
        });
        targetUserId = job?.userId ?? null;
      }

      if (targetUserId) {
        await tx.user.update({
          where: { id: targetUserId },
          data: {
            warningCount: { increment: 1 },
            lastWarningAt: new Date(now),
            lastWarningReason: input.notes,
          },
        });
      }
    }

    // 4. Update AbuseReport in DB
    await (tx as any).abuseReport.update({
      where: { id: dbReport.id },
      data: {
        status: newStatus,
        actionTaken: input.action,
        reviewedAt: new Date(now),
        reviewedBy: input.operatorId,
        resolutionNotes: input.notes,
      },
    });

    // 5. Create immutable ModerationAuditLog in DB
    if ("moderationAuditLog" in tx) {
      await (tx as any).moderationAuditLog.create({
        data: {
          reportId: dbReport.id,
          operatorId: input.operatorId,
          action: input.action,
          targetType: dbReport.targetType,
          targetId: dbReport.targetId,
          reason: input.notes,
          previousStatus,
          newStatus,
        },
      });
    }
  };

  try {
    if (typeof (client as any).$transaction === "function") {
      await (client as any).$transaction(executeActionTx);
    } else {
      await executeActionTx(client);
    }
  } catch (err: any) {
    throw new ModerationServiceUnavailableError(
      `Moderation persistence service unavailable: failed to commit action transaction to database. ${err?.message || String(err)}`,
      err,
    );
  }

  const newAuditEntry = {
    timestamp: now,
    operatorId: input.operatorId,
    action: input.action,
    reason: input.notes,
    previousStatus,
    newStatus,
  };

  const existingAuditLogs = (dbReport.auditLogs || []).map((a: any) => ({
    timestamp: a.createdAt instanceof Date ? a.createdAt.toISOString() : (a.createdAt || now),
    operatorId: a.operatorId,
    action: a.action,
    reason: a.reason,
    previousStatus: a.previousStatus,
    newStatus: a.newStatus,
  }));

  const updatedItem: ModerationItem = {
    id: dbReport.id,
    targetType: dbReport.targetType,
    targetId: dbReport.targetId,
    category: dbReport.category.toLowerCase(),
    details: dbReport.details,
    status: newStatus,
    reporterId: dbReport.reporterId,
    reportedAt: dbReport.createdAt instanceof Date ? dbReport.createdAt.toISOString() : (dbReport.createdAt || now),
    reviewedAt: now,
    reviewedBy: input.operatorId,
    resolutionNotes: input.notes,
    actionTaken: input.action,
    targetExcerpt: (dbReport.metadata as any)?.targetExcerpt,
    auditHistory: [...existingAuditLogs, newAuditEntry],
  };

  // Only populated in memory cache strictly after successful DB transaction commit.
  inMemoryQueue.set(updatedItem.id, updatedItem);
  return updatedItem;
}

/**
 * Resets the in-memory moderation queue (used strictly in test fixtures).
 */
export function resetModerationQueueForTesting(): void {
  inMemoryQueue.clear();
}
