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
