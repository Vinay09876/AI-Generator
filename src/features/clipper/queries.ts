/**
 * Read-side Prisma queries for the clipper (Batch 5). JSON-path filters target
 * GenerationJob.settings (PostgreSQL jsonb). Not executed against any database in Batch 5.
 */

import { AssetType, GenerationStatus, GenerationType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { ClipJobRecord } from "./job-view";
import type { PlatformVideoAsset } from "./jobs";
import { SEGMENT_REGEX } from "./storage/keys";
import type { ClipperJobSettings } from "./types";

type Db = Pick<Prisma.TransactionClient, "generationJob" | "generatedAsset">;

const ACTIVE = [GenerationStatus.PENDING, GenerationStatus.PROCESSING];
const TERMINAL = [GenerationStatus.COMPLETED, GenerationStatus.FAILED, GenerationStatus.CANCELLED];

const sourceKeyIs = (key: string): Prisma.GenerationJobWhereInput => ({
  settings: { path: ["sourceKey"], equals: key },
});

export async function findPendingClipperJobs(limit: number, db: Db = prisma) {
  const rows = await db.generationJob.findMany({
    where: { type: GenerationType.VIDEO_CLIP, status: GenerationStatus.PENDING },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 20)),
    select: { id: true, userId: true, settings: true },
  });
  return rows.map((r) => ({ id: r.id, userId: r.userId, settings: r.settings as unknown as ClipperJobSettings }));
}

export async function getActiveClipSourceKeys(userId: string, db: Db = prisma): Promise<string[]> {
  const rows = await db.generationJob.findMany({
    where: { userId, type: GenerationType.VIDEO_CLIP, status: { in: ACTIVE } },
    select: { settings: true },
  });
  return rows
    .map((r) => (r.settings as Partial<ClipperJobSettings> | null)?.sourceKey)
    .filter((k): k is string => typeof k === "string");
}

export async function isClipSourceKeyReferenced(userId: string, key: string, db: Db = prisma): Promise<boolean> {
  const n = await db.generationJob.count({ where: { userId, type: GenerationType.VIDEO_CLIP, ...sourceKeyIs(key) } });
  return n > 0;
}

export async function isUploadKeyInActiveClipJob(key: string, db: Db = prisma): Promise<boolean> {
  const n = await db.generationJob.count({ where: { type: GenerationType.VIDEO_CLIP, status: { in: ACTIVE }, ...sourceKeyIs(key) } });
  return n > 0;
}

export async function findClipJobsWithPendingCleanups(limit: number, db: Db = prisma): Promise<string[]> {
  const rows = await db.generationJob.findMany({
    where: {
      type: GenerationType.VIDEO_CLIP,
      status: { in: TERMINAL },
      OR: [
        { settings: { path: ["cleanupStatus"], equals: "pending" } },
        { settings: { path: ["cleanupStatus"], equals: "failed" } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function findClipJobIdByIdempotencyKey(userId: string, idempotencyKey: string, db: Db = prisma) {
  return db.generationJob.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    select: { id: true },
  });
}

export async function getClipJobForUser(userId: string, jobId: string, db: Db = prisma): Promise<ClipJobRecord | null> {
  if (!SEGMENT_REGEX.test(jobId)) return null;
  const job = await db.generationJob.findFirst({
    where: { id: jobId, userId, type: GenerationType.VIDEO_CLIP },
    select: {
      id: true,
      status: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      errorMessage: true,
      estimatedCredits: true,
      chargedCredits: true,
      settings: true,
      assets: {
        orderBy: { createdAt: "asc" },
        select: { id: true, thumbnailKey: true, width: true, height: true, durationSeconds: true },
      },
    },
  });
  return job ?? null;
}

/** Signing lookup: the asset must belong to the user AND to a VIDEO_CLIP job. */
export async function getClipAssetKeys(userId: string, assetId: string, db: Db = prisma) {
  if (!SEGMENT_REGEX.test(assetId)) return null;
  return db.generatedAsset.findFirst({
    where: { id: assetId, userId, type: AssetType.VIDEO, job: { type: GenerationType.VIDEO_CLIP } },
    select: { storageKey: true, thumbnailKey: true },
  });
}

export async function getPlatformVideoAsset(userId: string, assetId: string, db: Db = prisma): Promise<PlatformVideoAsset | null> {
  const asset = await db.generatedAsset.findFirst({
    where: {
      id: assetId,
      userId,
      type: AssetType.VIDEO,
      job: { type: GenerationType.VIDEO, status: GenerationStatus.COMPLETED },
    },
    select: { storageKey: true, durationSeconds: true, width: true, height: true, fileSize: true },
  });
  if (!asset || !asset.storageKey.startsWith(`users/${userId}/videos/`)) return null;
  return {
    storageKey: asset.storageKey,
    durationSeconds: asset.durationSeconds,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.fileSize !== null ? Number(asset.fileSize) : null,
  };
}
