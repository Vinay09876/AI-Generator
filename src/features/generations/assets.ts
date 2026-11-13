import "server-only";
import { randomUUID } from "node:crypto";
import { MAX_STORED_IMAGE_BYTES, SIGNED_URL_TTL_SECONDS } from "./config";
import type { ProcessedImage } from "./image-processing";
import { buildImageObjectKey, isImageKeyOwnedBy } from "./storage/keys";
import { StorageError, type ObjectStorage } from "./storage/types";

/**
 * Asset persistence and access. This module does NOT touch credits, refunds or job
 * status — orchestration (Stage 5) decides what a failure means for the job.
 */

export type AssetRecordInput = {
  assetId: string;
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
};

export class AssetPersistenceError extends Error {
  constructor(
    message: string,
    /** Set when the uploaded object could not be removed and is now orphaned. */
    public readonly orphanedKey: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AssetPersistenceError";
  }
}

/**
 * Upload a processed image under the user's prefix, then record it via `save` (the
 * caller's DB write). If `save` fails, the uploaded object is deleted so no unreferenced
 * file is left behind; if that cleanup also fails the orphaned key is reported.
 * Upload failures propagate as StorageError (nothing to clean up).
 */
export async function persistImageAsset<T>(params: {
  storage: ObjectStorage;
  userId: string;
  jobId: string;
  image: ProcessedImage;
  save: (record: AssetRecordInput) => Promise<T>;
  assetId?: string;
}): Promise<T> {
  const { storage, userId, jobId, image, save } = params;
  const assetId = params.assetId ?? randomUUID();
  const storageKey = buildImageObjectKey({ userId, jobId, assetId });

  if (image.sizeBytes !== image.buffer.length) throw new StorageError("TOO_LARGE", "Image size metadata does not match its data.");
  await storage.put(storageKey, image.buffer, { contentType: image.mimeType, maxBytes: MAX_STORED_IMAGE_BYTES });

  try {
    return await save({ assetId, storageKey, mimeType: image.mimeType, width: image.width, height: image.height, sizeBytes: image.sizeBytes });
  } catch (saveError) {
    try {
      await storage.delete(storageKey);
    } catch {
      console.error("[assets] cleanup failed; orphaned object", { storageKey });
      throw new AssetPersistenceError("Asset record could not be saved and the uploaded object could not be removed.", storageKey, { cause: saveError });
    }
    throw new AssetPersistenceError("Asset record could not be saved; the uploaded object was removed.", null, { cause: saveError });
  }
}

export class AssetAccessError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor() {
    // Same error for "missing" and "not yours", so asset ids cannot be probed.
    super("Asset not found.");
    this.name = "AssetAccessError";
  }
}

type FindOwnedAsset = (where: { assetId: string; userId: string }) => Promise<{ storageKey: string } | null>;

/** Default lookup: the asset must belong to the user (query is scoped by userId). Moderation hidden content is strictly excluded. */
const findOwnedAssetInDb: FindOwnedAsset = async ({ assetId, userId }) => {
  const { prisma } = await import("@/lib/prisma");
  const asset = await prisma.generatedAsset.findFirst({
    where: { id: assetId, userId },
    select: { storageKey: true, isHidden: true, job: { select: { settings: true } } },
  });
  if (!asset) return null;
  if ((asset as any).isHidden) return null;
  if ((asset as any).job?.settings && ((asset as any).job.settings as any).contentHidden === true) return null;
  return { storageKey: asset.storageKey };
};

/**
 * Signed URL for an asset, only after ownership is verified against the database.
 * `userId` must come from the authenticated session, never from client input.
 * The storage key is read from the database record, never accepted from the caller.
 */
export async function getSignedAssetUrl(params: {
  userId: string;
  assetId: string;
  storage: ObjectStorage;
  findAsset?: FindOwnedAsset;
  expiresInSeconds?: number;
}): Promise<string> {
  const { userId, assetId, storage } = params;
  if (typeof assetId !== "string" || assetId.length === 0 || assetId.length > 64) throw new AssetAccessError();

  const asset = await (params.findAsset ?? findOwnedAssetInDb)({ assetId, userId });
  // Defence in depth: the stored key must also sit inside this user's prefix.
  if (!asset || !isImageKeyOwnedBy(asset.storageKey, userId)) throw new AssetAccessError();

  return storage.createSignedUrl(asset.storageKey, params.expiresInSeconds ?? SIGNED_URL_TTL_SECONDS);
}
