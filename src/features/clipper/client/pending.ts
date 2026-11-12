/**
 * Persisted pending clip request (survives reloads). The idempotency key is created ONCE, at
 * submit time, and stored BEFORE the POST is sent, so recovery replays the same key and can
 * never create a second job or a second debit.
 */

import type { ClipJobOptions, ClipJobSource } from "./api";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingClipRequest {
  v: 1;
  idempotencyKey: string;
  source: ClipJobSource;
  options: ClipJobOptions;
  hints?: { durationSeconds: number; width?: number; height?: number };
  createdAt: number;
  jobId?: string;
}

/** Replays of an unconfirmed POST are allowed within this window. */
export const CLIP_REPLAY_WINDOW_MS = 10 * 60 * 1000;
/** A known job is polled for at most this long after creation. */
export const CLIP_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const pendingKey = (userId: string) => `yourai:clipper:pending:${userId}`;

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function newIdempotencyKey(random: () => string = () => crypto.randomUUID()): string {
  return `clip-${random().replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 100);
}

function isValid(v: unknown): v is PendingClipRequest {
  const r = v as Partial<PendingClipRequest> | null;
  if (!r || r.v !== 1 || typeof r.idempotencyKey !== "string" || !KEY_RE.test(r.idempotencyKey)) return false;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return false;
  if (r.jobId !== undefined && (typeof r.jobId !== "string" || !KEY_RE.test(r.jobId))) return false;
  const s = r.source as ClipJobSource | undefined;
  if (!s || (s.type === "upload" ? typeof s.uploadKey !== "string" : s.type === "platform_asset" ? typeof s.assetId !== "string" : true)) return false;
  return typeof r.options === "object" && r.options !== null;
}

export function readPending(storage: StorageLike | null, userId: string, now = Date.now()): PendingClipRequest | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingKey(userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValid(parsed) || now - parsed.createdAt > CLIP_RECOVERY_WINDOW_MS || parsed.createdAt > now + 60_000) {
      storage.removeItem(pendingKey(userId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePending(storage: StorageLike | null, userId: string, record: PendingClipRequest): boolean {
  if (!storage) return false;
  try {
    storage.setItem(pendingKey(userId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearPending(storage: StorageLike | null, userId: string): void {
  try {
    storage?.removeItem(pendingKey(userId));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Batch 6: upload reservation record (Fix A)
// ---------------------------------------------------------------------------
/**
 * Persisted as soon as the server grants an upload reservation, and cleared once the upload is
 * either released (discard) or handed over to a created job. A record found on page load belongs
 * to an interrupted upload (tab closed, crash) and is released so the one-pending-upload slot
 * does not stay blocked until the 2-hour sweep.
 */
export interface UploadReservationRecord {
  v: 1;
  /** Known once the server answered the reservation request. */
  uploadKey?: string;
  /** Batch 7: browser-chosen id + type, persisted BEFORE the request is sent. */
  uploadId?: string;
  mimeType?: string;
  /** When the (last) reservation request was sent, or when the key was received (ms). */
  createdAt: number;
}

const UPLOAD_ID_RE = /^upl_[a-f0-9]{32}$/;

/** Batch 7: `upl_` + 32 lowercase hex, from the browser's CSPRNG. */
export function newUploadId(random: () => string = () => crypto.randomUUID()): string {
  return `upl_${random().replace(/[^a-f0-9]/gi, "").toLowerCase().slice(0, 32).padEnd(32, "0")}`;
}

export const reservationKey = (userId: string) => `yourai:clipper:reservation:${userId}`;

export function readReservation(storage: StorageLike | null, userId: string): UploadReservationRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(reservationKey(userId));
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<UploadReservationRecord> | null;
    const hasKey = typeof r?.uploadKey === "string" && r.uploadKey.length > 0 && r.uploadKey.length <= 200;
    const hasId = typeof r?.uploadId === "string" && UPLOAD_ID_RE.test(r.uploadId) && typeof r?.mimeType === "string" && r.mimeType.length <= 100;
    if (!r || r.v !== 1 || (!hasKey && !hasId) || typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) {
      storage.removeItem(reservationKey(userId));
      return null;
    }
    return r as UploadReservationRecord;
  } catch {
    return null;
  }
}

export function writeReservation(storage: StorageLike | null, userId: string, record: UploadReservationRecord): boolean {
  if (!storage) return false;
  try {
    storage.setItem(reservationKey(userId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Clears the record only if it still refers to `ref` (an upload key or upload id; another tab may have replaced it). */
export function clearReservation(storage: StorageLike | null, userId: string, ref: string): void {
  try {
    const r = readReservation(storage, userId);
    if (r && (r.uploadKey === ref || r.uploadId === ref)) storage?.removeItem(reservationKey(userId));
  } catch {
    // ignore
  }
}
