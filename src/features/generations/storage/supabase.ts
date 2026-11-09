import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StorageError, type ObjectStorage } from "./types";

/**
 * Supabase Storage adapter for a PRIVATE bucket. It receives an administrative client
 * (secret key) from the server-only factory in storage/index.ts and must never be used
 * from client code. Ownership is enforced by callers before any read/sign operation.
 */

/** Minimal surface of the Supabase storage client we use (lets tests inject a fake). */
export type StorageBucketApi = Pick<ReturnType<SupabaseClient["storage"]["from"]>, "upload" | "createSignedUrl" | "remove">;
export type StorageClientLike = { storage: { from(bucket: string): StorageBucketApi } };

function errorStatus(error: unknown): number | null {
  const e = error as { statusCode?: unknown; status?: unknown };
  const raw = e?.statusCode ?? e?.status;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export class SupabaseObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: StorageClientLike,
    private readonly bucket: string,
  ) {}

  private api() {
    return this.client.storage.from(this.bucket);
  }

  async put(key: string, body: Buffer, options: { contentType: string; maxBytes: number }) {
    // Enforced here as well as by the bucket's own file-size limit.
    if (body.length === 0 || body.length > options.maxBytes) {
      throw new StorageError("TOO_LARGE", `Object size ${body.length} bytes is outside the allowed range.`);
    }
    const { error } = await this.api().upload(key, body, {
      contentType: options.contentType,
      upsert: false, // never overwrite an existing object
      cacheControl: "3600",
    });
    if (error) {
      const status = errorStatus(error);
      const duplicate = status === 409 || /exists|duplicate/i.test(String((error as { message?: unknown }).message ?? ""));
      throw new StorageError(duplicate ? "ALREADY_EXISTS" : "UPLOAD_FAILED", duplicate ? "Object already exists." : "Upload failed.", status);
    }
  }

  async createSignedUrl(key: string, expiresInSeconds: number) {
    const { data, error } = await this.api().createSignedUrl(key, expiresInSeconds);
    if (error || !data?.signedUrl) throw new StorageError("SIGN_FAILED", "Could not create a signed URL.", errorStatus(error));
    return data.signedUrl;
  }

  async delete(key: string) {
    const { error } = await this.api().remove([key]);
    if (error) throw new StorageError("DELETE_FAILED", "Delete failed.", errorStatus(error));
  }
}
