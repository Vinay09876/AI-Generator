import { GenerationStatus, GenerationType } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  toVideoJobView,
  type VideoAssetView,
  type VideoJobRecord,
  type VideoJobView,
} from "./job-view";
import { getSignedVideoAssetUrl } from "./storage/ingestion";
import type { VideoObjectStorage } from "./storage/types";

function videoJobRecordSelect(userId: string) {
  return {
    id: true,
    status: true,
    prompt: true,
    settings: true,
    chargedCredits: true,
    estimatedCredits: true,
    errorMessage: true,
    createdAt: true,
    startedAt: true,
    completedAt: true,
    assets: {
      where: { userId },
      orderBy: { createdAt: "asc" as const },
      take: 1,
      select: {
        id: true,
        width: true,
        height: true,
        mimeType: true,
        fileSize: true,
        durationSeconds: true,
        thumbnailKey: true,
      },
    },
  } as const;
}

/**
 * Loads one video job with its asset metadata, strictly scoped to the owner.
 * Returns null for both missing jobs and jobs owned by another user.
 * Internal storage keys are never selected.
 */
export async function getVideoJobForUser(
  userId: string,
  jobId: string,
  db: typeof prisma = prisma,
): Promise<VideoJobRecord | null> {
  const job = await db.generationJob.findFirst({
    where: {
      id: jobId,
      userId,
      type: GenerationType.VIDEO,
    },
    select: videoJobRecordSelect(userId),
  });

  return (job as VideoJobRecord) ?? null;
}

/**
 * Loads the user's active in-progress video job (PENDING or PROCESSING), if any.
 * Owner-scoped.
 */
export async function getActiveVideoJob(
  userId: string,
  db: typeof prisma = prisma,
): Promise<VideoJobRecord | null> {
  const job = await db.generationJob.findFirst({
    where: {
      userId,
      type: GenerationType.VIDEO,
      status: { in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: videoJobRecordSelect(userId),
  });

  return (job as VideoJobRecord) ?? null;
}

/**
 * Loads the user's recent COMPLETED video jobs, newest first.
 * Owner-scoped on both job and asset; never returns internal storage keys.
 */
export async function getRecentVideoJobs(
  userId: string,
  take = 8,
  db: typeof prisma = prisma,
): Promise<VideoJobRecord[]> {
  const limit = Math.min(Math.max(Math.trunc(take) || 0, 1), 24);
  const jobs = await db.generationJob.findMany({
    where: {
      userId,
      type: GenerationType.VIDEO,
      status: GenerationStatus.COMPLETED,
      assets: { some: { userId } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: videoJobRecordSelect(userId),
  });

  return (jobs as unknown as VideoJobRecord[]) ?? [];
}

export interface VideoJobViewWithAsset {
  job: VideoJobView;
  asset: VideoAssetView | null;
}

/**
 * Loads recent completed video jobs for a user and resolves authenticated signed URLs
 * for each job's video and thumbnail assets.
 * Pure read-only view helper for the gallery.
 */
export async function getRecentVideoJobsWithUrls(
  userId: string,
  storage: VideoObjectStorage,
  take = 8,
  db: typeof prisma = prisma,
): Promise<VideoJobViewWithAsset[]> {
  const records = await getRecentVideoJobs(userId, take, db);
  return Promise.all(
    records.map(async (record) => {
      let signedUrls: { videoUrl?: string; thumbnailUrl?: string | null } | undefined;
      if (record.assets && record.assets.length > 0) {
        const asset = record.assets[0];
        try {
          const [videoUrl, thumbnailUrl] = await Promise.all([
            getSignedVideoAssetUrl({ userId, assetId: asset.id, storage, kind: "video", db }),
            asset.thumbnailKey
              ? getSignedVideoAssetUrl({ userId, assetId: asset.id, storage, kind: "thumbnail", db }).catch(() => null)
              : Promise.resolve(null),
          ]);
          signedUrls = { videoUrl, thumbnailUrl };
        } catch {
          // If signed URL generation fails, fallback gracefully
        }
      }
      return toVideoJobView(record, signedUrls);
    }),
  );
}

