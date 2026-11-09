/**
 * Storage-independent contract for private generated assets. Implementations must keep
 * objects private: reads happen only through short-lived signed URLs.
 */

export type StorageErrorCode = "CONFIG" | "INVALID_KEY" | "TOO_LARGE" | "ALREADY_EXISTS" | "UPLOAD_FAILED" | "SIGN_FAILED" | "DELETE_FAILED";

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface ObjectStorage {
  /** Upload a new object. Never overwrites an existing key. */
  put(key: string, body: Buffer, options: { contentType: string; maxBytes: number }): Promise<void>;
  /** Short-lived URL for a private object. Callers must verify ownership first. */
  createSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Remove an object (idempotent: deleting a missing object is not an error). */
  delete(key: string): Promise<void>;
}
