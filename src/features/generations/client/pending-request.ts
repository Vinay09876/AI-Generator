import { PROMPT_MAX_LENGTH, isImageQuality, type ImageQuality } from "../config";
import { isValidIdempotencyKey } from "../validation";

/*
 * The in-flight generation request, persisted in localStorage so a refresh (or a lost
 * response) can recover the job with the SAME idempotency key. A key is created only by
 * createPendingRequest (on a user's submit); recovery always reuses the stored key.
 *
 * Stored on the user's own device: the prompt is kept so a replay sends an identical body
 * (the server rejects a different body for the same key). Cleared when the job finishes.
 */

export const PENDING_REQUEST_VERSION = 1;

export type PendingRequest = {
  v: typeof PENDING_REQUEST_VERSION;
  key: string;
  prompt: string;
  quality: ImageQuality;
  /** Epoch milliseconds when the user submitted. */
  startedAt: number;
  /** Known once the server has acknowledged the job. */
  jobId?: string;
};

/** Minimal storage interface (window.localStorage in the browser, a fake in tests). */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Clock skew tolerated for a startedAt slightly in the future. */
const MAX_FUTURE_SKEW_MS = 60_000;

/** User-scoped storage key, so a shared browser never mixes accounts. */
export function pendingStorageKey(userId: string) {
  if (!USER_ID_PATTERN.test(userId)) throw new Error("Invalid user id for pending request storage.");
  return `yourai:image:pending:${userId}`;
}

/**
 * Create a new pending request for a user submit. This is the ONLY place a new
 * idempotency key is generated.
 */
export function createPendingRequest(
  input: { prompt: string; quality: ImageQuality },
  deps: { now?: number; randomId?: () => string } = {},
): PendingRequest {
  const key = (deps.randomId ?? (() => crypto.randomUUID()))();
  if (!isValidIdempotencyKey(key)) throw new Error("Generated idempotency key is invalid.");
  return { v: PENDING_REQUEST_VERSION, key, prompt: input.prompt, quality: input.quality, startedAt: deps.now ?? Date.now() };
}

/** Attach the acknowledged job id. The key is preserved unchanged. */
export function withJobId(pending: PendingRequest, jobId: string): PendingRequest {
  if (!JOB_ID_PATTERN.test(jobId)) return pending;
  return { ...pending, jobId };
}

/** Strict validation of restored data; anything unexpected is rejected (returns null). */
export function parsePendingRequest(value: unknown, now: number = Date.now()): PendingRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== PENDING_REQUEST_VERSION) return null;
  if (!isValidIdempotencyKey(r.key)) return null;
  if (typeof r.prompt !== "string" || r.prompt.trim().length === 0 || r.prompt.length > PROMPT_MAX_LENGTH) return null;
  if (!isImageQuality(r.quality)) return null;
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt) || r.startedAt <= 0) return null;
  if (r.startedAt > now + MAX_FUTURE_SKEW_MS) return null;
  if (r.jobId !== undefined && (typeof r.jobId !== "string" || !JOB_ID_PATTERN.test(r.jobId))) return null;
  const pending: PendingRequest = { v: PENDING_REQUEST_VERSION, key: r.key, prompt: r.prompt, quality: r.quality, startedAt: r.startedAt };
  if (typeof r.jobId === "string") pending.jobId = r.jobId;
  return pending;
}

/** Read and validate. Invalid or unreadable data is removed and treated as absent. */
export function loadPendingRequest(store: KeyValueStore | null, userId: string, now: number = Date.now()): PendingRequest | null {
  if (!store) return null;
  let key: string;
  try {
    key = pendingStorageKey(userId);
  } catch {
    return null;
  }
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null; // storage disabled (e.g. privacy mode)
  }
  if (raw === null) return null;
  let parsed: PendingRequest | null = null;
  try {
    parsed = parsePendingRequest(JSON.parse(raw), now);
  } catch {
    parsed = null;
  }
  if (!parsed) clearPendingRequest(store, userId);
  return parsed;
}

/** Persist; returns false if storage is unavailable (the request still proceeds). */
export function savePendingRequest(store: KeyValueStore | null, userId: string, pending: PendingRequest): boolean {
  if (!store) return false;
  try {
    store.setItem(pendingStorageKey(userId), JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingRequest(store: KeyValueStore | null, userId: string): void {
  if (!store) return;
  try {
    store.removeItem(pendingStorageKey(userId));
  } catch {
    // ignore: nothing else to do
  }
}

/** window.localStorage if usable, else null (SSR, disabled storage). */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
