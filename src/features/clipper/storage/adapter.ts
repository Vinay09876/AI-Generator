/**
 * Clipper storage contract (Batch 5). Implemented by the Supabase adapter in production and by
 * in-memory fakes in tests. Every method THROWS on failure — callers decide fail-open/closed.
 */

import type { Readable } from "node:stream";

export interface StoredObjectInfo {
  /** Full object key. */
  key: string;
  /** Size in bytes, or null when the backend did not report it. */
  sizeBytes: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface FolderListing {
  objects: StoredObjectInfo[];
  /** Immediate sub-folder names (not full keys). */
  folders: string[];
}

export interface SignedUpload {
  /** Absolute URL the browser PUTs the file to (contains a short-lived token). */
  signedUrl: string;
  /** Storage key the URL is bound to. */
  key: string;
}

export interface ClipperStorage {
  /** Lists ONE folder level. `limit`/`offset` paginate. */
  listFolder(prefix: string, page: { limit: number; offset: number }): Promise<FolderListing>;
  /** Creates an empty placeholder object (reservation marker). Never overwrites. */
  putPlaceholder(key: string, contentType: string): Promise<void>;
  /** Signed browser upload URL for `key`, allowed to overwrite the placeholder. */
  createSignedUploadUrl(key: string): Promise<SignedUpload>;
  /** Object metadata, or null when the object does not exist. */
  info(key: string): Promise<StoredObjectInfo | null>;
  /** Reads bytes [0, length) — only for small signature checks. */
  readPrefix(key: string, length: number): Promise<Buffer>;
  /** Streams an object with a hard byte cap (never buffers the whole object). */
  openDownloadStream(key: string, maxBytes: number): Promise<Readable>;
  /**
   * Short-lived signed GET URL. With `download`, the storage server is asked to send
   * Content-Disposition: attachment with that filename (Batch 6 download route).
   */
  createSignedUrl(key: string, expiresInSeconds: number, options?: { download?: string }): Promise<string>;
  putStream(
    key: string,
    stream: NodeJS.ReadableStream,
    options: { contentType: string; maxBytes: number; contentLength: number },
  ): Promise<{ sizeBytes: number }>;
  delete(key: string): Promise<void>;
}

export class ClipperStorageTimeoutError extends Error {
  readonly code = "STORAGE_TIMEOUT";
  constructor(operation: string, ms: number) {
    super(`Storage operation '${operation}' timed out after ${ms}ms.`);
    this.name = "ClipperStorageTimeoutError";
  }
}

/** Rejects if `promise` does not settle within `ms`. The underlying call may still complete. */
export async function withStorageTimeout<T>(operation: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ClipperStorageTimeoutError(operation, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
