/**
 * User-Scoped Storage Key Helpers & Namespace Security for Video Clipper.
 *
 * Implements strict user isolation and path traversal defense:
 *   Ephemeral uploads:  ephemeral/users/{userId}/uploads/{uploadId}.mp4
 *   Permanent clips:    users/{userId}/clips/{jobId}/{clipId}.mp4
 *   Thumbnails:         users/{userId}/clips/{jobId}/{clipId}-thumb.webp
 *
 * Every identifier (userId, uploadId, jobId, clipId) is rigorously validated
 * against a strict alphanumeric whitelist to prevent directory traversal or prefix injection.
 */

export class ClipperStorageKeyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ClipperStorageKeyError";
  }
}

/**
 * Strict segment pattern: 8 to 64 alphanumeric characters, underscores, or hyphens.
 * Prevents directory traversal (`..`), path separators (`/`, `\`), and control characters.
 */
export const SEGMENT_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Validates that an identifier strictly conforms to safe storage segment criteria.
 */
export function assertSafeIdentifier(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !SEGMENT_REGEX.test(value)) {
    throw new ClipperStorageKeyError(
      "INVALID_IDENTIFIER",
      `Invalid ${name}: must be 8-64 alphanumeric characters, underscores or hyphens.`,
    );
  }
}

const ALLOWED_EXTENSIONS = new Set(["mp4", "mov", "webm", "webp"]);

/**
 * Sanitizes and validates a file extension against allowed clipper media extensions.
 */
export function sanitizeExtension(ext: string): string {
  const cleaned = ext.replace(/^\./, "").toLowerCase().trim();
  if (!ALLOWED_EXTENSIONS.has(cleaned)) {
    throw new ClipperStorageKeyError(
      "INVALID_EXTENSION",
      `Invalid or unsupported extension: '${ext}'. Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}.`,
    );
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Storage Key Builders
// ---------------------------------------------------------------------------
export function buildEphemeralUploadKey(params: {
  userId: string;
  uploadId: string;
  extension?: string;
}): string {
  assertSafeIdentifier("userId", params.userId);
  assertSafeIdentifier("uploadId", params.uploadId);
  const ext = sanitizeExtension(params.extension ?? "mp4");
  return `ephemeral/users/${params.userId}/uploads/${params.uploadId}.${ext}`;
}

export function buildClipStorageKey(params: {
  userId: string;
  jobId: string;
  clipId: string;
  extension?: string;
}): string {
  assertSafeIdentifier("userId", params.userId);
  assertSafeIdentifier("jobId", params.jobId);
  assertSafeIdentifier("clipId", params.clipId);
  const ext = sanitizeExtension(params.extension ?? "mp4");
  return `users/${params.userId}/clips/${params.jobId}/${params.clipId}.${ext}`;
}

export function buildClipThumbnailKey(params: {
  userId: string;
  jobId: string;
  clipId: string;
  extension?: string;
}): string {
  assertSafeIdentifier("userId", params.userId);
  assertSafeIdentifier("jobId", params.jobId);
  assertSafeIdentifier("clipId", params.clipId);
  const ext = sanitizeExtension(params.extension ?? "webp");
  return `users/${params.userId}/clips/${params.jobId}/${params.clipId}-thumb.${ext}`;
}

// ---------------------------------------------------------------------------
// Key Matching & Ownership Verification
// ---------------------------------------------------------------------------
const EPHEMERAL_KEY_PATTERN = /^ephemeral\/users\/([A-Za-z0-9_-]{8,64})\/uploads\/([A-Za-z0-9_-]{8,64})\.([a-z0-9]{2,6})$/;
const CLIP_KEY_PATTERN = /^users\/([A-Za-z0-9_-]{8,64})\/clips\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]{8,64})\.([a-z0-9]{2,6})$/;
const CLIP_THUMBNAIL_KEY_PATTERN = /^users\/([A-Za-z0-9_-]{8,64})\/clips\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]{8,64})-thumb\.([a-z0-9]{2,6})$/;

/** True only if the key is a well-formed ephemeral upload owned by this user. */
export function isEphemeralUploadKeyOwnedBy(key: string, userId: string): boolean {
  if (!SEGMENT_REGEX.test(userId)) return false;
  const match = EPHEMERAL_KEY_PATTERN.exec(key);
  return match !== null && match[1] === userId;
}

/** True only if the key is a well-formed clip video asset owned by this user. */
export function isClipKeyOwnedBy(key: string, userId: string): boolean {
  if (!SEGMENT_REGEX.test(userId)) return false;
  const match = CLIP_KEY_PATTERN.exec(key);
  return match !== null && match[1] === userId;
}

/** True only if the key is a well-formed clip thumbnail owned by this user. */
export function isClipThumbnailKeyOwnedBy(key: string, userId: string): boolean {
  if (!SEGMENT_REGEX.test(userId)) return false;
  const match = CLIP_THUMBNAIL_KEY_PATTERN.exec(key);
  return match !== null && match[1] === userId;
}

/** True if the key is any valid clipper asset (ephemeral, clip, or thumb) owned by this user. */
export function isClipperKeyOwnedBy(key: string, userId: string): boolean {
  return (
    isEphemeralUploadKeyOwnedBy(key, userId) ||
    isClipKeyOwnedBy(key, userId) ||
    isClipThumbnailKeyOwnedBy(key, userId)
  );
}

// ---------------------------------------------------------------------------
// Key Parsers
// ---------------------------------------------------------------------------
export function parseEphemeralUploadKey(key: string): {
  userId: string;
  uploadId: string;
  extension: string;
} | null {
  const match = EPHEMERAL_KEY_PATTERN.exec(key);
  if (!match) return null;
  return {
    userId: match[1],
    uploadId: match[2],
    extension: match[3],
  };
}

export function parseClipStorageKey(key: string): {
  userId: string;
  jobId: string;
  clipId: string;
  extension: string;
  isThumbnail: boolean;
} | null {
  const thumbMatch = CLIP_THUMBNAIL_KEY_PATTERN.exec(key);
  if (thumbMatch) {
    return {
      userId: thumbMatch[1],
      jobId: thumbMatch[2],
      clipId: thumbMatch[3],
      extension: thumbMatch[4],
      isThumbnail: true,
    };
  }

  const clipMatch = CLIP_KEY_PATTERN.exec(key);
  if (clipMatch) {
    return {
      userId: clipMatch[1],
      jobId: clipMatch[2],
      clipId: clipMatch[3],
      extension: clipMatch[4],
      isThumbnail: false,
    };
  }

  return null;
}
