import { StorageError } from "./types";

/**
 * User-scoped object keys: users/{userId}/images/{jobId}/{assetId}.webp
 * Every segment is validated so a key can never escape its user's prefix.
 */
const SEGMENT = /^[A-Za-z0-9_-]{8,64}$/;

function assertSegment(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !SEGMENT.test(value)) {
    throw new StorageError("INVALID_KEY", `Invalid ${name} for storage key.`);
  }
}

export function buildImageObjectKey(params: { userId: string; jobId: string; assetId: string }) {
  assertSegment("userId", params.userId);
  assertSegment("jobId", params.jobId);
  assertSegment("assetId", params.assetId);
  return `users/${params.userId}/images/${params.jobId}/${params.assetId}.webp`;
}

/** True only if the key is a well-formed image key inside this user's prefix. */
export function isImageKeyOwnedBy(key: string, userId: string) {
  if (!SEGMENT.test(userId)) return false;
  const match = /^users\/([A-Za-z0-9_-]{8,64})\/images\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]{8,64})\.webp$/.exec(key);
  return match !== null && match[1] === userId;
}
