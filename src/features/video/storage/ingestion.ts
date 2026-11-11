import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  MAX_PROVIDER_VIDEO_BYTES,
  MAX_STORED_THUMBNAIL_BYTES,
  VIDEO_SIGNED_URL_TTL_SECONDS,
} from "../config";
import {
  claimVideoIngestionLease,
  completeVideoJobWithAsset,
  type CompletedVideoAssetInput,
} from "../lifecycle";
import {
  buildVideoObjectKey,
  buildVideoThumbnailObjectKey,
  isVideoKeyOwnedBy,
  isVideoThumbnailKeyOwnedBy,
} from "./keys";
import type { SsrfValidationOptions } from "./ssrf";
import { downloadVideoStream } from "./stream";
import {
  CompositeVideoThumbnailExtractor,
  ThumbnailExtractionError,
  type VideoThumbnailExtractor,
} from "./thumbnail";
import {
  VideoAssetPersistenceError,
  VideoStorageError,
  type VideoObjectStorage,
} from "./types";

export interface VideoIngestionParams {
  jobId: string;
  userId: string;
  ingestionToken: string;
  videoUrl: string;
  posterUrl?: string | null;
  posterBuffer?: Buffer | null;
  width: number;
  height: number;
  durationSeconds: number;
  storage: VideoObjectStorage;
  thumbnailExtractor?: VideoThumbnailExtractor;
  db?: typeof prisma;
  options?: {
    maxVideoBytes?: number;
    maxThumbnailBytes?: number;
    requireThumbnail?: boolean;
    timeoutMs?: number;
    validationOptions?: SsrfValidationOptions;
  };
}

export interface VideoIngestionResult {
  jobId: string;
  assetId: string;
  videoKey: string;
  thumbnailKey: string | null;
  sizeBytes: number;
}

/**
 * Orchestrates the full video ingestion pipeline:
 *   1. Generates deterministic user-scoped storage keys.
 *   2. Downloads the provider output via streaming with SSRF and signature checks.
 *   3. Uploads the MP4 video stream directly to private Supabase Storage.
 *   4. Extracts and uploads a WebP thumbnail poster frame (if extractor succeeds).
 *   5. Finalizes job status and registers GeneratedAsset atomically using Batch 2A lifecycle.
 *   6. Cleans up uploaded objects from storage if completion or database persistence fails.
 */
export async function ingestVideoOutput(params: VideoIngestionParams): Promise<VideoIngestionResult> {
  const {
    jobId,
    userId,
    ingestionToken,
    videoUrl,
    posterUrl,
    posterBuffer,
    width,
    height,
    durationSeconds,
    storage,
    thumbnailExtractor = new CompositeVideoThumbnailExtractor(),
    db = prisma,
    options,
  } = params;

  const maxVideoBytes = options?.maxVideoBytes ?? MAX_PROVIDER_VIDEO_BYTES;
  const maxThumbnailBytes = options?.maxThumbnailBytes ?? MAX_STORED_THUMBNAIL_BYTES;
  const requireThumbnail = options?.requireThumbnail ?? false;
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const validationOptions = options?.validationOptions;

  const assetId = randomUUID();
  const videoKey = buildVideoObjectKey({ userId, jobId, assetId });
  const thumbnailKey = buildVideoThumbnailObjectKey({ userId, jobId, assetId });

  const uploadedKeys: string[] = [];

  try {
    // 1. Download video stream from provider with SSRF validation
    const download = await downloadVideoStream({
      videoUrl,
      maxBytes: maxVideoBytes,
      timeoutMs,
      validationOptions,
    });

    // 2. Stream video directly into private object storage
    await storage.putStream(videoKey, download.stream, {
      contentType: "video/mp4",
      maxBytes: maxVideoBytes,
      contentLength: download.expectedSizeBytes ?? undefined,
    });
    uploadedKeys.push(videoKey);

    const actualSizeBytes = download.getBytesRead() || download.expectedSizeBytes || 0;

    // 3. Extract and upload thumbnail poster frame
    let recordedThumbnailKey: string | null = null;
    try {
      const thumb = await thumbnailExtractor.extract({
        videoUrl,
        posterBuffer: posterBuffer ?? undefined,
        posterUrl: posterUrl ?? undefined,
        width,
        height,
      });

      if (thumb.buffer.length > maxThumbnailBytes) {
        throw new ThumbnailExtractionError(
          "TOO_LARGE",
          `Thumbnail buffer (${thumb.buffer.length} bytes) exceeds limit of ${maxThumbnailBytes} bytes.`,
        );
      }

      await storage.put(thumbnailKey, thumb.buffer, {
        contentType: "image/webp",
        maxBytes: maxThumbnailBytes,
      });
      uploadedKeys.push(thumbnailKey);
      recordedThumbnailKey = thumbnailKey;
    } catch (thumbErr) {
      if (requireThumbnail) {
        throw thumbErr;
      }
      // Log structured warning for missing dependency / extraction failure without failing ingestion
      const reason = thumbErr instanceof Error ? thumbErr.message : String(thumbErr);
      console.warn(`[video-ingestion] Thumbnail extraction skipped for job ${jobId}: ${reason}`);
      recordedThumbnailKey = null;
    }

    // 4. Atomically complete the job and register GeneratedAsset
    const assetInput: CompletedVideoAssetInput = {
      userId,
      assetId,
      storageKey: videoKey,
      thumbnailKey: recordedThumbnailKey,
      mimeType: "video/mp4",
      width,
      height,
      durationSeconds,
      sizeBytes: actualSizeBytes,
    };

    await completeVideoJobWithAsset({ jobId, ingestionToken, asset: assetInput }, db);

    return {
      jobId,
      assetId,
      videoKey,
      thumbnailKey: recordedThumbnailKey,
      sizeBytes: actualSizeBytes,
    };
  } catch (pipelineErr) {
    // Clean up any uploaded storage objects to avoid orphaned files
    const orphanedKeys: string[] = [];
    for (const key of uploadedKeys) {
      try {
        await storage.delete(key);
      } catch (delErr) {
        orphanedKeys.push(key);
        console.error(`[video-ingestion] Failed to clean up orphaned storage key '${key}':`, delErr);
      }
    }

    if (orphanedKeys.length > 0) {
      throw new VideoAssetPersistenceError(
        "Ingestion failed and some uploaded storage objects could not be cleaned up.",
        orphanedKeys,
        { cause: pipelineErr },
      );
    }

    throw pipelineErr;
  }
}

/**
 * Generates an ownership-checked signed URL for a video asset or poster frame.
 * Strict authentication and access invariants:
 *   1. userId MUST come from the authenticated server session, never trusted from client input.
 *   2. Validates user ID and asset ID segments to eliminate path traversal / injection probing.
 *   3. Scopes the database lookup strictly by { id: assetId, userId }.
 *   4. Validates that the recorded storage key strictly matches the user's isolated prefix:
 *      - video key: users/{userId}/videos/{jobId}/{assetId}.mp4
 *      - thumbnail key: users/{userId}/videos/{jobId}/{assetId}-thumb.webp
 *   5. All authorization failures return identical 404 NOT_FOUND to prevent ID probing.
 *   6. Storage keys and internal file paths are never exposed in error responses.
 */
export async function getSignedVideoAssetUrl(params: {
  userId: string;
  assetId: string;
  storage: VideoObjectStorage;
  kind?: "video" | "thumbnail";
  db?: typeof prisma;
  expiresInSeconds?: number;
}): Promise<string> {
  const {
    userId,
    assetId,
    storage,
    kind = "video",
    db = prisma,
    expiresInSeconds = VIDEO_SIGNED_URL_TTL_SECONDS,
  } = params;

  const SEGMENT = /^[A-Za-z0-9_-]{8,64}$/;

  // Reject malformed or unauthorized user ID
  if (typeof userId !== "string" || !SEGMENT.test(userId)) {
    throw new VideoStorageError("NOT_FOUND", "Asset not found.", 404);
  }

  // Reject malformed asset ID
  if (typeof assetId !== "string" || !SEGMENT.test(assetId)) {
    throw new VideoStorageError("NOT_FOUND", "Asset not found.", 404);
  }

  const asset = await db.generatedAsset.findFirst({
    where: { id: assetId, userId },
    select: { storageKey: true, thumbnailKey: true },
  });

  if (!asset) {
    throw new VideoStorageError("NOT_FOUND", "Asset not found.", 404);
  }

  const targetKey = kind === "thumbnail" ? asset.thumbnailKey : asset.storageKey;
  if (!targetKey) {
    throw new VideoStorageError("NOT_FOUND", "Asset not found.", 404);
  }

  // Defence-in-depth: verify key prefix matches authenticated user's isolated namespace
  const isAuthorized =
    kind === "thumbnail"
      ? isVideoThumbnailKeyOwnedBy(targetKey, userId)
      : isVideoKeyOwnedBy(targetKey, userId);

  if (!isAuthorized) {
    throw new VideoStorageError("NOT_FOUND", "Asset not found.", 404);
  }

  return storage.createSignedUrl(targetKey, expiresInSeconds);
}

export interface ProcessPendingIngestionParams {
  limit?: number;
  storage: VideoObjectStorage;
  thumbnailExtractor?: VideoThumbnailExtractor;
  db?: typeof prisma;
}

export interface ProcessPendingIngestionResult {
  checked: number;
  ingested: number;
  failed: number;
  jobIds: string[];
}

/**
 * Scheduled Recovery Worker: Independently discovers and processes pending video ingestion work.
 *
 * Operational Guarantees:
 *   1. Independent Ingestion: Ingestion progresses to COMPLETED even if no client polls and the browser was closed.
 *   2. Decoupled from GET: GET /api/generations/video/[jobId] is only an optional latency shortcut.
 *   3. Crash Recovery: When an immediate trigger (after()) terminates mid-download, the lease expires
 *      and this scheduled worker automatically claims and resumes it.
 *   4. Concurrency Safety: Atomic claimVideoIngestionLease prevents duplicate workers from ingesting simultaneously.
 */
export async function processPendingIngestionJobs(
  params: ProcessPendingIngestionParams,
): Promise<ProcessPendingIngestionResult> {
  const { limit = 10, storage, thumbnailExtractor, db = prisma } = params;
  const now = new Date();

  // Find candidate PROCESSING video jobs
  const candidateJobs = await db.generationJob.findMany({
    where: {
      type: "VIDEO" as any,
      status: "PROCESSING" as any,
    },
    select: {
      id: true,
      userId: true,
      status: true,
      settings: true,
      ingestionToken: true,
      ingestionLeaseExpiresAt: true,
    },
    take: limit,
  });

  let ingested = 0;
  let failed = 0;
  const jobIds: string[] = [];

  for (const job of candidateJobs) {
    if (job.status !== "PROCESSING") continue;

    // Check if an active worker currently holds the ingestion lease
    if (
      job.ingestionToken &&
      job.ingestionLeaseExpiresAt &&
      new Date(job.ingestionLeaseExpiresAt).getTime() > now.getTime()
    ) {
      continue;
    }

    const settings = (job.settings as Record<string, unknown> | null) ?? {};
    const providerResult = settings.providerResult as
      | { payload?: { video?: { url?: string; thumbnail_url?: string }; thumbnail?: { url?: string } } }
      | undefined;

    const videoUrl = providerResult?.payload?.video?.url;
    if (!videoUrl) continue;

    const posterUrl =
      providerResult?.payload?.thumbnail?.url ??
      providerResult?.payload?.video?.thumbnail_url ??
      null;

    const token = randomUUID();
    const lease = await claimVideoIngestionLease({ jobId: job.id, customToken: token }, db);
    if (!lease.claimed || !lease.token) continue;

    try {
      await ingestVideoOutput({
        jobId: job.id,
        userId: job.userId,
        ingestionToken: token,
        videoUrl,
        posterUrl,
        width: 1280,
        height: 720,
        durationSeconds: 5.0,
        storage,
        thumbnailExtractor,
        db,
      });
      ingested++;
      jobIds.push(job.id);
    } catch (err) {
      console.error(`[ingestion-worker] Ingestion failed for job ${job.id}:`, err);
      failed++;
    }
  }

  return {
    checked: candidateJobs.length,
    ingested,
    failed,
    jobIds,
  };
}

