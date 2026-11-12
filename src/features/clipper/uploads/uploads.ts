/**
 * Clipper upload workflow (Batch 5): reservation, signed direct-to-storage upload, verification,
 * discard. Dependency-injected and free of Next.js / Supabase imports so it is testable offline.
 *
 * Quota model (no new tables / migrations):
 *   - Storage listing of `ephemeral/users/{userId}/uploads` is the source of truth.
 *   - Listing FAILS CLOSED: errors, timeouts, missing sizes, unexpected sub-folders, or reaching
 *     the object ceiling (cannot prove completeness) all reject with QUOTA_UNVERIFIABLE. An
 *     incomplete listing is never treated as zero usage.
 *   - Concurrency: the check-and-reserve runs inside `withUserLock` (the same `User` row lock
 *     that serialises job creation). Inside the lock an empty PLACEHOLDER object is written at the
 *     upload key before the signed URL is issued, so a concurrent or subsequent intent sees the
 *     reservation in its own listing even though the browser has not uploaded anything yet.
 *   - A placeholder (size 0) counts as one pending upload reserving the maximum upload size.
 */

import { randomUUID } from "node:crypto";
import {
  CLIPPER_CLIENT_UPLOAD_ID_REGEX,
  CLIPPER_STORAGE_OP_TIMEOUT_MS,
  CLIPPER_UPLOAD_INTENT_DEADLINE_MS,
  CLIPPER_UPLOAD_LISTING_MAX_OBJECTS,
  CLIPPER_UPLOAD_SIGNATURE_BYTES,
  CLIPPER_UPLOAD_USE_MARGIN_SECONDS,
  EPHEMERAL_UPLOAD_TTL_SECONDS,
  EPHEMERAL_USER_STAGING_QUOTA_BYTES,
  getClipperMaxUploadBytes,
  MAX_PENDING_UPLOADS_PER_USER,
  type AllowedClipperMimeType,
} from "../config";
import { assertSafeIdentifier, buildEphemeralUploadKey, isEphemeralUploadKeyOwnedBy, parseEphemeralUploadKey } from "../storage/keys";
import { withStorageTimeout, type ClipperStorage, type SignedUpload, type StoredObjectInfo } from "../storage/adapter";
import { inspectContainerMagicBytes, validateUploadMimeType, validateUploadSizeBytes } from "../validation";

export type ClipperUploadErrorCode =
  | "INVALID_INPUT"
  | "UPLOAD_PENDING_EXISTS"
  | "STAGING_QUOTA_EXCEEDED"
  | "QUOTA_UNVERIFIABLE"
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_INCOMPLETE"
  | "UPLOAD_TOO_LARGE"
  | "UPLOAD_INVALID_CONTAINER"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_IN_USE"
  | "UPLOAD_ALREADY_USED"
  | "STORAGE_UNAVAILABLE";

export const UPLOAD_ERROR_STATUS: Record<ClipperUploadErrorCode, number> = {
  INVALID_INPUT: 400,
  UPLOAD_PENDING_EXISTS: 409,
  STAGING_QUOTA_EXCEEDED: 409,
  QUOTA_UNVERIFIABLE: 503,
  UPLOAD_NOT_FOUND: 404,
  UPLOAD_INCOMPLETE: 409,
  UPLOAD_TOO_LARGE: 413,
  UPLOAD_INVALID_CONTAINER: 415,
  UPLOAD_EXPIRED: 410,
  UPLOAD_IN_USE: 409,
  UPLOAD_ALREADY_USED: 409,
  STORAGE_UNAVAILABLE: 503,
};

export class ClipperUploadError extends Error {
  constructor(public readonly code: ClipperUploadErrorCode, message: string) {
    super(message);
    this.name = "ClipperUploadError";
  }
  get httpStatus(): number {
    return UPLOAD_ERROR_STATUS[this.code];
  }
}

/** Queries that must run inside the per-user lock (bound to the locking transaction). */
export interface UploadLockScope {
  /** sourceKeys of this user's PENDING/PROCESSING VIDEO_CLIP jobs. */
  activeSourceKeys(): Promise<string[]>;
}

export interface ClipperUploadDeps {
  storage: ClipperStorage;
  /** Serialises upload reservation/discard per user (production: User row FOR UPDATE). */
  withUserLock<T>(userId: string, fn: (scope: UploadLockScope) => Promise<T>): Promise<T>;
  /** True if ANY clip job (any status) already used this key as its source. */
  isSourceKeyReferenced(userId: string, key: string): Promise<boolean>;
  now?: () => Date;
  storageTimeoutMs?: number;
}

const MIME_EXTENSION: Record<AllowedClipperMimeType, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export function uploadFolder(userId: string): string {
  assertSafeIdentifier("userId", userId);
  return `ephemeral/users/${userId}/uploads`;
}

// ---------------------------------------------------------------------------
// Strict (fail-closed) listing & pure quota evaluation
// ---------------------------------------------------------------------------
export async function listUserUploadsStrict(
  storage: ClipperStorage,
  userId: string,
  options: { timeoutMs?: number; maxObjects?: number; pageSize?: number } = {},
): Promise<StoredObjectInfo[]> {
  const prefix = uploadFolder(userId);
  const timeoutMs = options.timeoutMs ?? CLIPPER_STORAGE_OP_TIMEOUT_MS;
  const maxObjects = options.maxObjects ?? CLIPPER_UPLOAD_LISTING_MAX_OBJECTS;
  const pageSize = options.pageSize ?? 10;
  const objects: StoredObjectInfo[] = [];

  for (let offset = 0; ; offset += pageSize) {
    let page;
    try {
      page = await withStorageTimeout("list", timeoutMs, storage.listFolder(prefix, { limit: pageSize, offset }));
    } catch {
      throw new ClipperUploadError("QUOTA_UNVERIFIABLE", "Upload quota could not be verified. Please try again shortly.");
    }
    if (!page || !Array.isArray(page.objects) || !Array.isArray(page.folders)) {
      throw new ClipperUploadError("QUOTA_UNVERIFIABLE", "Upload quota could not be verified. Please try again shortly.");
    }
    if (page.folders.length > 0) {
      // Unexpected nesting: usage below it cannot be measured.
      throw new ClipperUploadError("QUOTA_UNVERIFIABLE", "Upload quota could not be verified. Please try again shortly.");
    }
    for (const obj of page.objects) {
      if (obj.sizeBytes === null || !Number.isFinite(obj.sizeBytes) || obj.sizeBytes < 0) {
        throw new ClipperUploadError("QUOTA_UNVERIFIABLE", "Upload quota could not be verified. Please try again shortly.");
      }
      objects.push(obj);
    }
    if (objects.length >= maxObjects) {
      // Cannot prove the listing is complete within bounds — fail closed.
      throw new ClipperUploadError("QUOTA_UNVERIFIABLE", "Upload quota could not be verified. Please try again shortly.");
    }
    const entries = page.objects.length + page.folders.length;
    if (entries < pageSize) break;
  }
  return objects;
}

export interface QuotaEvaluation {
  pendingKeys: string[];
  reservedBytes: number;
}

/** Pure. Throws UPLOAD_PENDING_EXISTS / STAGING_QUOTA_EXCEEDED. */
export function evaluateUploadQuota(params: {
  objects: StoredObjectInfo[];
  activeSourceKeys: string[];
  declaredSizeBytes: number;
  maxUploadBytes?: number;
  maxPending?: number;
  stagingQuotaBytes?: number;
}): QuotaEvaluation {
  const maxUpload = params.maxUploadBytes ?? getClipperMaxUploadBytes();
  const maxPending = params.maxPending ?? MAX_PENDING_UPLOADS_PER_USER;
  const quota = params.stagingQuotaBytes ?? EPHEMERAL_USER_STAGING_QUOTA_BYTES;
  const active = new Set(params.activeSourceKeys);

  let reserved = 0;
  const pendingKeys: string[] = [];
  for (const obj of params.objects) {
    const size = obj.sizeBytes ?? maxUpload;
    // An empty placeholder is an in-flight reservation: assume the maximum upload size.
    reserved += size === 0 ? maxUpload : size;
    if (!active.has(obj.key)) pendingKeys.push(obj.key);
  }

  if (pendingKeys.length >= maxPending) {
    throw new ClipperUploadError(
      "UPLOAD_PENDING_EXISTS",
      "You already have an upload waiting. Use it to create clips or discard it first.",
    );
  }
  if (reserved + params.declaredSizeBytes > quota) {
    throw new ClipperUploadError("STAGING_QUOTA_EXCEEDED", "Your temporary upload storage is full. Please try again later.");
  }
  return { pendingKeys, reservedBytes: reserved };
}

// ---------------------------------------------------------------------------
// Intent (reservation + signed URL)
// ---------------------------------------------------------------------------
export interface UploadIntentResult {
  uploadKey: string;
  uploadId: string;
  /** Batch 7: true when this answered a retry of an existing reservation (same uploadId). */
  regranted: boolean;
  signedUrl: string;
  contentType: AllowedClipperMimeType;
  maxBytes: number;
  expiresAt: string;
}

/** Batch 7: optional browser-chosen upload id (strict format; always placed in the caller's folder). */
export function parseClientUploadId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !CLIPPER_CLIENT_UPLOAD_ID_REGEX.test(value)) {
    throw new ClipperUploadError("INVALID_INPUT", "Invalid upload id.");
  }
  return value;
}

export function validateUploadIntentInput(input: unknown): { mimeType: AllowedClipperMimeType; sizeBytes: number; uploadId: string | null } {
  const body = (input ?? {}) as Record<string, unknown>;
  const mime = validateUploadMimeType(body.mimeType);
  if (!mime.valid) throw new ClipperUploadError("INVALID_INPUT", "Only MP4, MOV or WebM videos are supported.");
  const size = validateUploadSizeBytes(body.sizeBytes);
  if (!size.valid) {
    throw new ClipperUploadError(
      size.code === "FILE_TOO_LARGE" ? "UPLOAD_TOO_LARGE" : "INVALID_INPUT",
      size.code === "FILE_TOO_LARGE"
        ? `Videos must be ${Math.floor(getClipperMaxUploadBytes() / (1024 * 1024))} MB or smaller.`
        : "A valid file size is required.",
    );
  }
  return { mimeType: mime.data, sizeBytes: size.data, uploadId: parseClientUploadId(body.uploadId) };
}

export async function createUploadIntent(
  deps: ClipperUploadDeps,
  params: { userId: string; input: unknown },
): Promise<UploadIntentResult> {
  const { userId } = params;
  assertSafeIdentifier("userId", userId);
  const { mimeType, sizeBytes, uploadId: clientUploadId } = validateUploadIntentInput(params.input);
  const timeoutMs = deps.storageTimeoutMs ?? CLIPPER_STORAGE_OP_TIMEOUT_MS;
  const clock = () => deps.now?.() ?? new Date();
  const now = clock();
  const arrivedAt = now.getTime();

  const uploadId = clientUploadId ?? `upl_${randomUUID().replace(/-/g, "")}`;
  const uploadKey = buildEphemeralUploadKey({ userId, uploadId, extension: MIME_EXTENSION[mimeType] });
  const pastDeadline = () => clock().getTime() - arrivedAt > CLIPPER_UPLOAD_INTENT_DEADLINE_MS;

  let regranted = false;
  await deps.withUserLock(userId, async (scope) => {
    const [activeSourceKeys, objects] = await Promise.all([
      scope.activeSourceKeys(),
      listUserUploadsStrict(deps.storage, userId, { timeoutMs }),
    ]);

    const existing = clientUploadId ? objects.find((o) => o.key === uploadKey) : undefined;
    if (existing) {
      // Retry of a reservation this user already holds (lost response). Never a second slot.
      if (activeSourceKeys.includes(uploadKey) || (await deps.isSourceKeyReferenced(userId, uploadKey))) {
        throw new ClipperUploadError("UPLOAD_ALREADY_USED", "This upload was already used. Please upload the video again.");
      }
      const born = existing.createdAt ?? existing.updatedAt;
      if (!born) throw new ClipperUploadError("QUOTA_UNVERIFIABLE", "Upload quota could not be verified. Please try again shortly.");
      if (clock().getTime() > born.getTime() + (EPHEMERAL_UPLOAD_TTL_SECONDS - CLIPPER_UPLOAD_USE_MARGIN_SECONDS) * 1000) {
        throw new ClipperUploadError("UPLOAD_EXPIRED", "This upload has expired. Please upload the video again.");
      }
      // Quota is evaluated WITHOUT this object (it is the reservation being re-granted), so every
      // other pending upload still counts exactly as before.
      evaluateUploadQuota({ objects: objects.filter((o) => o.key !== uploadKey), activeSourceKeys, declaredSizeBytes: sizeBytes });
      regranted = true;
      return;
    }

    evaluateUploadQuota({ objects, activeSourceKeys, declaredSizeBytes: sizeBytes });
    if (pastDeadline()) {
      // Never write a reservation the browser may already have given up on (see config).
      throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Uploads are temporarily unavailable. Please try again.");
    }
    try {
      await withStorageTimeout("placeholder", timeoutMs, deps.storage.putPlaceholder(uploadKey, mimeType));
    } catch {
      // A timed-out placeholder may still land; the abandoned-upload sweep removes it after the TTL.
      throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Uploads are temporarily unavailable. Please try again.");
    }
  });

  let signed: SignedUpload;
  try {
    signed = await withStorageTimeout("sign-upload", timeoutMs, deps.storage.createSignedUploadUrl(uploadKey));
  } catch {
    // Release a reservation created by THIS request (sweep is the backstop). A re-granted one may
    // already hold the user's bytes, so it is left for the user to retry or discard.
    if (!regranted) await deps.storage.delete(uploadKey).catch(() => {});
    throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Uploads are temporarily unavailable. Please try again.");
  }
  if (signed.key !== uploadKey) {
    if (!regranted) await deps.storage.delete(uploadKey).catch(() => {});
    throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Uploads are temporarily unavailable. Please try again.");
  }

  return {
    uploadKey,
    uploadId,
    regranted,
    signedUrl: signed.signedUrl,
    contentType: mimeType,
    maxBytes: getClipperMaxUploadBytes(),
    // Uploads must be turned into a job before the sweep window closes.
    expiresAt: new Date(now.getTime() + (EPHEMERAL_UPLOAD_TTL_SECONDS - CLIPPER_UPLOAD_USE_MARGIN_SECONDS) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Verification (stateless; re-run at job creation)
// ---------------------------------------------------------------------------
export interface VerifiedUpload {
  uploadKey: string;
  sizeBytes: number;
  container: "mp4" | "quicktime" | "webm";
}

export function assertOwnedUploadKey(userId: string, uploadKey: unknown): string {
  if (typeof uploadKey !== "string" || !isEphemeralUploadKeyOwnedBy(uploadKey, userId)) {
    throw new ClipperUploadError("UPLOAD_NOT_FOUND", "Upload not found.");
  }
  return uploadKey;
}

const EXT_CONTAINERS: Record<string, ReadonlyArray<VerifiedUpload["container"]>> = {
  mp4: ["mp4", "quicktime"],
  mov: ["quicktime", "mp4"],
  webm: ["webm"],
};

export async function verifyUpload(
  deps: Pick<ClipperUploadDeps, "storage" | "now" | "storageTimeoutMs">,
  params: { userId: string; uploadKey: unknown },
): Promise<VerifiedUpload> {
  const key = assertOwnedUploadKey(params.userId, params.uploadKey);
  const parsed = parseEphemeralUploadKey(key)!;
  const timeoutMs = deps.storageTimeoutMs ?? CLIPPER_STORAGE_OP_TIMEOUT_MS;
  const now = deps.now?.() ?? new Date();

  let info: StoredObjectInfo | null;
  try {
    info = await withStorageTimeout("info", timeoutMs, deps.storage.info(key));
  } catch {
    throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Upload could not be checked. Please try again.");
  }
  if (!info) throw new ClipperUploadError("UPLOAD_NOT_FOUND", "Upload not found.");
  if (info.sizeBytes === null) throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Upload could not be checked. Please try again.");
  if (info.sizeBytes === 0) throw new ClipperUploadError("UPLOAD_INCOMPLETE", "The upload has not finished yet.");
  if (info.sizeBytes > getClipperMaxUploadBytes()) throw new ClipperUploadError("UPLOAD_TOO_LARGE", "The uploaded video is too large.");

  // The reservation time (createdAt) bounds the upload's life; missing timestamps fail closed.
  const born = info.createdAt ?? info.updatedAt;
  if (!born) throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Upload could not be checked. Please try again.");
  const usableUntil = born.getTime() + (EPHEMERAL_UPLOAD_TTL_SECONDS - CLIPPER_UPLOAD_USE_MARGIN_SECONDS) * 1000;
  if (now.getTime() > usableUntil) throw new ClipperUploadError("UPLOAD_EXPIRED", "This upload has expired. Please upload the video again.");

  let header: Buffer;
  try {
    header = await withStorageTimeout("read-prefix", timeoutMs, deps.storage.readPrefix(key, CLIPPER_UPLOAD_SIGNATURE_BYTES));
  } catch {
    throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Upload could not be checked. Please try again.");
  }
  const inspection = inspectContainerMagicBytes(header);
  if (!inspection.valid || !EXT_CONTAINERS[parsed.extension]?.includes(inspection.data.format)) {
    throw new ClipperUploadError("UPLOAD_INVALID_CONTAINER", "The file is not a supported MP4, MOV or WebM video.");
  }

  return { uploadKey: key, sizeBytes: info.sizeBytes, container: inspection.data.format };
}

// ---------------------------------------------------------------------------
// Discard (user-initiated release of a pending upload)
// ---------------------------------------------------------------------------
/**
 * Resolves the upload to discard: an explicit key, or (Batch 7) a browser-chosen uploadId plus its
 * MIME type, built inside the caller's own folder. Never accepts a path from another namespace.
 */
export function resolveDiscardTarget(userId: string, params: { uploadKey?: unknown; uploadId?: unknown; mimeType?: unknown }): string {
  if (params.uploadKey !== undefined && params.uploadKey !== null) return assertOwnedUploadKey(userId, params.uploadKey);
  const uploadId = parseClientUploadId(params.uploadId);
  const mime = validateUploadMimeType(params.mimeType);
  if (!uploadId || !mime.valid) throw new ClipperUploadError("INVALID_INPUT", "An upload key, or an upload id and type, is required.");
  return buildEphemeralUploadKey({ userId, uploadId, extension: MIME_EXTENSION[mime.data] });
}

export async function discardUpload(
  deps: ClipperUploadDeps,
  params: { userId: string; uploadKey?: unknown; uploadId?: unknown; mimeType?: unknown },
): Promise<{ deleted: true }> {
  const key = resolveDiscardTarget(params.userId, params);
  await deps.withUserLock(params.userId, async (scope) => {
    const active = await scope.activeSourceKeys();
    if (active.includes(key)) {
      throw new ClipperUploadError("UPLOAD_IN_USE", "This upload is being processed and cannot be discarded.");
    }
    try {
      await withStorageTimeout("delete", deps.storageTimeoutMs ?? CLIPPER_STORAGE_OP_TIMEOUT_MS, deps.storage.delete(key));
    } catch {
      throw new ClipperUploadError("STORAGE_UNAVAILABLE", "The upload could not be discarded. Please try again.");
    }
  });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Batch 7: release every pending upload of the caller (cross-device / cleared-storage recovery)
// ---------------------------------------------------------------------------
/**
 * User-initiated. Under the same per-user lock as reservations, deletes the caller's own uploads
 * that no ACTIVE clip job uses. It only ever removes objects, so it cannot be used to exceed the
 * quota. Listing fails closed (nothing is deleted when completeness cannot be proven).
 */
export async function releasePendingUploads(
  deps: ClipperUploadDeps,
  params: { userId: string },
): Promise<{ released: number; kept: number }> {
  const { userId } = params;
  assertSafeIdentifier("userId", userId);
  const timeoutMs = deps.storageTimeoutMs ?? CLIPPER_STORAGE_OP_TIMEOUT_MS;
  return deps.withUserLock(userId, async (scope) => {
    const [activeSourceKeys, objects] = await Promise.all([
      scope.activeSourceKeys(),
      listUserUploadsStrict(deps.storage, userId, { timeoutMs }),
    ]);
    const active = new Set(activeSourceKeys);
    let released = 0;
    let kept = 0;
    for (const obj of objects) {
      if (active.has(obj.key) || !isEphemeralUploadKeyOwnedBy(obj.key, userId)) {
        kept++;
        continue;
      }
      try {
        await withStorageTimeout("delete", timeoutMs, deps.storage.delete(obj.key));
        released++;
      } catch {
        throw new ClipperUploadError("STORAGE_UNAVAILABLE", "Pending uploads could not be released. Please try again.");
      }
    }
    return { released, kept };
  });
}
