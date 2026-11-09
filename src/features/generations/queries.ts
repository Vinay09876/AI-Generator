import { cache } from "react";
import { GenerationStatus, GenerationType } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

const jobListSelect = {
  id: true,
  type: true,
  status: true,
  prompt: true,
  estimatedCredits: true,
  chargedCredits: true,
  createdAt: true,
  completedAt: true,
} as const;

export type JobListItem = Awaited<ReturnType<typeof getRecentJobs>>[number];

export type UsageStats = {
  total: number;
  byType: Record<GenerationType, number>;
  completed: number;
  failed: number;
  inProgress: number;
  cancelled: number;
  /** completed / (completed + failed); null when there is nothing finished yet. */
  successRate: number | null;
};

/** One grouped query over the user's jobs, folded into overview statistics. */
export const getUsageStats = cache(async (userId: string): Promise<UsageStats> => {
  const rows = await prisma.generationJob.groupBy({
    by: ["type", "status"],
    where: { userId },
    _count: { _all: true },
  });

  const stats: UsageStats = {
    total: 0,
    byType: { IMAGE: 0, VIDEO: 0, VIDEO_CLIP: 0 },
    completed: 0,
    failed: 0,
    inProgress: 0,
    cancelled: 0,
    successRate: null,
  };

  for (const row of rows) {
    const n = row._count._all;
    stats.total += n;
    stats.byType[row.type] += n;
    if (row.status === GenerationStatus.COMPLETED) stats.completed += n;
    else if (row.status === GenerationStatus.FAILED) stats.failed += n;
    else if (row.status === GenerationStatus.CANCELLED) stats.cancelled += n;
    else stats.inProgress += n; // PENDING + PROCESSING
  }

  const finished = stats.completed + stats.failed;
  stats.successRate = finished > 0 ? stats.completed / finished : null;
  return stats;
});

export type DailyActivity = { date: string; count: number }[];

/** Jobs per UTC day for the last `days` days (including today), zero-filled. */
export async function getDailyActivity(userId: string, days = 14): Promise<DailyActivity> {
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1)));

  // Parameterised tagged template: userId and start are sent as bind parameters.
  const rows = await prisma.$queryRaw<{ day: string; count: number }[]>`
    SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, count(*)::int AS count
    FROM "GenerationJob"
    WHERE "userId" = ${userId} AND "createdAt" >= ${start}
    GROUP BY 1
    ORDER BY 1`;

  const counts = new Map(rows.map((r) => [r.day, r.count]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    return { date: key, count: counts.get(key) ?? 0 };
  });
}

export const getRecentJobs = cache(async (userId: string, take = 6) => {
  return prisma.generationJob.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: jobListSelect,
  });
});

/**
 * Fields needed to render an image job (job-view.ts `ImageJobRecord`). The asset relation is
 * restricted to the owner and NEVER selects the storage key.
 */
function imageJobRecordSelect(userId: string) {
  return {
    id: true,
    status: true,
    prompt: true,
    settings: true,
    chargedCredits: true,
    errorMessage: true,
    createdAt: true,
    completedAt: true,
    assets: {
      where: { userId },
      orderBy: { createdAt: "asc" },
      take: 1,
      select: { id: true, width: true, height: true, mimeType: true, fileSize: true },
    },
  } as const;
}

/**
 * One image job with its asset metadata, scoped to the owner. Returns null for both
 * "missing" and "not yours". Never selects the storage key.
 */
export async function getImageJobForUser(userId: string, jobId: string) {
  return prisma.generationJob.findFirst({
    where: { id: jobId, userId, type: GenerationType.IMAGE },
    select: imageJobRecordSelect(userId),
  });
}

/**
 * The user's in-progress image job (PENDING or PROCESSING), if any. At most one can exist
 * (partial unique index), so the page can resume it after a refresh. Owner-scoped.
 */
export async function getActiveImageJob(userId: string) {
  return prisma.generationJob.findFirst({
    where: { userId, type: GenerationType.IMAGE, status: { in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: imageJobRecordSelect(userId),
  });
}

export const RECENT_IMAGES_MAX = 24;

/**
 * The user's most recent COMPLETED image jobs that have a stored asset, newest first.
 * Owner-scoped on both the job and the asset; never returns storage keys.
 */
export async function getRecentImageJobs(userId: string, take = 8) {
  const limit = Math.min(Math.max(Math.trunc(take) || 0, 1), RECENT_IMAGES_MAX);
  return prisma.generationJob.findMany({
    where: { userId, type: GenerationType.IMAGE, status: GenerationStatus.COMPLETED, assets: { some: { userId } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: imageJobRecordSelect(userId),
  });
}

export const HISTORY_PAGE_SIZE = 20;

/** Keyset pagination over the user's jobs, newest first, optionally filtered by type. */
export async function getJobsPage(
  userId: string,
  { type, cursor: requestedCursor, take = HISTORY_PAGE_SIZE }: { type?: GenerationType; cursor?: string; take?: number },
) {
  // Only honour cursors that point at this user's own jobs (and match the active filter).
  const cursor = requestedCursor
    ? (
        await prisma.generationJob.findFirst({
          where: { id: requestedCursor, userId, ...(type ? { type } : {}) },
          select: { id: true },
        })
      )?.id
    : undefined;

  const items = await prisma.generationJob.findMany({
    where: { userId, ...(type ? { type } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: jobListSelect,
  });

  const hasMore = items.length > take;
  const page = hasMore ? items.slice(0, take) : items;
  return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
}
