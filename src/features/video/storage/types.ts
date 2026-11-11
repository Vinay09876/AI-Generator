import type { ObjectStorage } from "@/features/generations/storage/types";

export type VideoStorageErrorCode =
  | "CONFIG"
  | "INVALID_KEY"
  | "TOO_LARGE"
  | "INVALID_SIGNATURE"
  | "INVALID_MIME"
  | "ALREADY_EXISTS"
  | "UPLOAD_FAILED"
  | "STREAM_ERROR"
  | "SIGN_FAILED"
  | "DELETE_FAILED"
  | "NOT_FOUND";

export class VideoStorageError extends Error {
  constructor(
    public readonly code: VideoStorageErrorCode,
    message: string,
    public readonly httpStatus: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "VideoStorageError";
  }
}

export class VideoAssetPersistenceError extends Error {
  constructor(
    message: string,
    /** Any uploaded storage keys that could not be removed and are now orphaned. */
    public readonly orphanedKeys: string[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "VideoAssetPersistenceError";
  }
}

export interface VideoObjectStorage extends ObjectStorage {
  /**
   * Upload a streamed object without buffering the entire body into memory.
   * Enforces maxBytes and never overwrites an existing key.
   */
  putStream(
    key: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options: { contentType: string; maxBytes: number; contentLength?: number },
  ): Promise<{ sizeBytes: number }>;
}

