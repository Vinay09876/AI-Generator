import { VideoStorageError } from "./types";

/**
 * User-scoped object keys for video generations:
 *   Video:     users/{userId}/videos/{jobId}/{assetId}.mp4
 *   Thumbnail: users/{userId}/videos/{jobId}/{assetId}-thumb.webp
 *
 * Every segment is strictly validated to prevent path traversal, prefix injection,
 * or escaping the user's isolated storage namespace.
 */
const SEGMENT = /^[A-Za-z0-9_-]{8,64}$/;

export function assertStorageKeySegment(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !SEGMENT.test(value)) {
    throw new VideoStorageError("INVALID_KEY", `Invalid ${name} for video storage key.`);
  }
}

export function buildVideoObjectKey(params: { userId: string; jobId: string; assetId: string }): string {
  assertStorageKeySegment("userId", params.userId);
  assertStorageKeySegment("jobId", params.jobId);
  assertStorageKeySegment("assetId", params.assetId);
  return `users/${params.userId}/videos/${params.jobId}/${params.assetId}.mp4`;
}

export function buildVideoThumbnailObjectKey(params: { userId: string; jobId: string; assetId: string }): string {
  assertStorageKeySegment("userId", params.userId);
  assertStorageKeySegment("jobId", params.jobId);
  assertStorageKeySegment("assetId", params.assetId);
  return `users/${params.userId}/videos/${params.jobId}/${params.assetId}-thumb.webp`;
}

const VIDEO_KEY_PATTERN = /^users\/([A-Za-z0-9_-]{8,64})\/videos\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]{8,64})\.mp4$/;
const THUMBNAIL_KEY_PATTERN = /^users\/([A-Za-z0-9_-]{8,64})\/videos\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]{8,64})-thumb\.webp$/;

/** True only if the key is a well-formed video MP4 key inside this user's prefix. */
export function isVideoKeyOwnedBy(key: string, userId: string): boolean {
  if (!SEGMENT.test(userId)) return false;
  const match = VIDEO_KEY_PATTERN.exec(key);
  return match !== null && match[1] === userId;
}

/** True only if the key is a well-formed video thumbnail WebP key inside this user's prefix. */
export function isVideoThumbnailKeyOwnedBy(key: string, userId: string): boolean {
  if (!SEGMENT.test(userId)) return false;
  const match = THUMBNAIL_KEY_PATTERN.exec(key);
  return match !== null && match[1] === userId;
}

/** True if the key is either a video or thumbnail key owned by this user. */
export function isVideoAssetKeyOwnedBy(key: string, userId: string): boolean {
  return isVideoKeyOwnedBy(key, userId) || isVideoThumbnailKeyOwnedBy(key, userId);
}

