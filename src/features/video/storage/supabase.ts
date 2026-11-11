import "server-only";
import type { StorageBucketApi, StorageClientLike } from "@/features/generations/storage/supabase";
import { VideoStorageError, type VideoObjectStorage } from "./types";

function errorStatus(error: unknown): number | null {
  const e = error as { statusCode?: unknown; status?: unknown };
  const raw = e?.statusCode ?? e?.status;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Supabase Storage adapter for private video assets and poster frames.
 * Supports both buffered and streaming uploads to the private bucket.
 * Never overwrites existing objects (upsert: false).
 */
export class SupabaseVideoObjectStorage implements VideoObjectStorage {
  constructor(
    private readonly client: StorageClientLike,
    private readonly bucket: string,
  ) {}

  private api(): StorageBucketApi {
    return this.client.storage.from(this.bucket);
  }

  async put(
    key: string,
    body: Buffer,
    options: { contentType: string; maxBytes: number },
  ): Promise<void> {
    if (body.length === 0 || body.length > options.maxBytes) {
      throw new VideoStorageError(
        "TOO_LARGE",
        `Object size ${body.length} bytes is outside the allowed range of 1 to ${options.maxBytes} bytes.`,
      );
    }

    const { error } = await this.api().upload(key, body, {
      contentType: options.contentType,
      upsert: false, // never overwrite an existing asset
      cacheControl: "3600",
    });

    if (error) {
      const status = errorStatus(error);
      const duplicate =
        status === 409 || /exists|duplicate/i.test(String((error as { message?: unknown }).message ?? ""));
      throw new VideoStorageError(
        duplicate ? "ALREADY_EXISTS" : "UPLOAD_FAILED",
        duplicate ? "Object already exists in storage." : "Upload failed.",
        status,
        { cause: error },
      );
    }
  }

  async putStream(
    key: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options: { contentType: string; maxBytes: number; contentLength?: number },
  ): Promise<{ sizeBytes: number }> {
    if (
      options.contentLength !== undefined &&
      (options.contentLength === 0 || options.contentLength > options.maxBytes)
    ) {
      throw new VideoStorageError(
        "TOO_LARGE",
        `Streamed object size (${options.contentLength} bytes) is outside the allowed range of 1 to ${options.maxBytes} bytes.`,
      );
    }

    const uploadOptions: Record<string, unknown> = {
      contentType: options.contentType,
      upsert: false, // never overwrite
      cacheControl: "3600",
      duplex: "half",
    };

    if (options.contentLength !== undefined) {
      uploadOptions.headers = { "content-length": String(options.contentLength) };
    }

    const { error } = await this.api().upload(key, stream as any, uploadOptions as any);

    if (error) {
      const status = errorStatus(error);
      const duplicate =
        status === 409 || /exists|duplicate/i.test(String((error as { message?: unknown }).message ?? ""));
      const tooLarge = status === 413 || /too large|payload too large/i.test(String((error as any).message ?? ""));

      throw new VideoStorageError(
        duplicate ? "ALREADY_EXISTS" : tooLarge ? "TOO_LARGE" : "UPLOAD_FAILED",
        duplicate
          ? "Object already exists in storage."
          : tooLarge
          ? "Object exceeds storage backend size limit."
          : "Streamed upload failed.",
        status,
        { cause: error },
      );
    }

    return { sizeBytes: options.contentLength ?? 0 };
  }

  async createSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.api().createSignedUrl(key, expiresInSeconds);
    if (error || !data?.signedUrl) {
      throw new VideoStorageError(
        "SIGN_FAILED",
        "Could not generate a signed URL for video asset.",
        errorStatus(error),
        { cause: error },
      );
    }
    return data.signedUrl;
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.api().remove([key]);
    if (error) {
      throw new VideoStorageError("DELETE_FAILED", `Failed to delete storage key '${key}'.`, errorStatus(error), {
        cause: error,
      });
    }
  }
}

let cachedVideoStorage: VideoObjectStorage | undefined;

export function getVideoObjectStorage(): VideoObjectStorage {
  if (cachedVideoStorage) return cachedVideoStorage;
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "generated-assets";
  if (!url || !secretKey) {
    throw new VideoStorageError("CONFIG", "Missing Supabase storage environment variables.");
  }
  const { createClient } = require("@supabase/supabase-js");
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  cachedVideoStorage = new SupabaseVideoObjectStorage(client, bucket);
  return cachedVideoStorage;
}
