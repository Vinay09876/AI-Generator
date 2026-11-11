import "server-only";
/**
 * Supabase implementation of ClipperStorage (private bucket, server-side secret key).
 *
 * NOT VERIFIED against a live bucket (₹0 / no live calls). Staging must verify: signed upload
 * URLs with upsert over a 0-byte placeholder, `info()` size/timestamps, Range reads on signed
 * URLs, streamed downloads, and the project's per-object size limit (expected 50 MB on Free).
 *
 * Downloads use a signed URL + fetch so the body is streamed (storage-js `download()` returns a
 * Blob, which would buffer the whole video in memory). Fetches are restricted to the configured
 * SUPABASE_URL origin.
 */

import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { StorageClientLike } from "@/features/generations/storage/supabase";
import { getVideoObjectStorage } from "@/features/video/storage/supabase";
import type { ClipperStorage, FolderListing, SignedUpload, StoredObjectInfo } from "./adapter";

type BucketApi = {
  list(prefix: string, options: { limit: number; offset: number; sortBy?: { column: string; order: string } }): Promise<{ data: any[] | null; error: unknown }>;
  upload(key: string, body: unknown, options: Record<string, unknown>): Promise<{ error: unknown }>;
  createSignedUploadUrl(key: string, options?: { upsert?: boolean }): Promise<{ data: { signedUrl: string; path: string; token: string } | null; error: unknown }>;
  info(key: string): Promise<{ data: any | null; error: unknown }>;
  createSignedUrl(key: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
};

class SupabaseStorageOpError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number | null = null) {
    super(message);
    this.name = "SupabaseStorageOpError";
  }
}

function statusOf(error: unknown): number | null {
  const e = error as { statusCode?: unknown; status?: unknown };
  const n = Number(e?.statusCode ?? e?.status);
  return Number.isFinite(n) ? n : null;
}

function toDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class SupabaseClipperStorage implements ClipperStorage {
  private readonly origin: string;

  constructor(
    private readonly client: StorageClientLike,
    private readonly bucket: string,
    supabaseUrl: string,
  ) {
    this.origin = new URL(supabaseUrl).origin;
  }

  private api(): BucketApi {
    return this.client.storage.from(this.bucket) as unknown as BucketApi;
  }

  private assertOwnOrigin(url: string): string {
    const parsed = new URL(url, this.origin);
    if (parsed.origin !== this.origin) throw new SupabaseStorageOpError("UNTRUSTED_URL", "Signed URL origin mismatch.");
    return parsed.toString();
  }

  async listFolder(prefix: string, page: { limit: number; offset: number }): Promise<FolderListing> {
    const { data, error } = await this.api().list(prefix, {
      limit: page.limit,
      offset: page.offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error || !Array.isArray(data)) throw new SupabaseStorageOpError("LIST_FAILED", "Listing failed.", statusOf(error));
    const listing: FolderListing = { objects: [], folders: [] };
    for (const entry of data) {
      if (typeof entry?.name !== "string") throw new SupabaseStorageOpError("LIST_MALFORMED", "Malformed listing entry.");
      // Folders are returned without an id / metadata.
      if (entry.id === null || entry.id === undefined) {
        listing.folders.push(entry.name);
        continue;
      }
      const size = Number(entry.metadata?.size);
      listing.objects.push({
        key: `${prefix}/${entry.name}`,
        sizeBytes: Number.isFinite(size) && size >= 0 ? size : null,
        createdAt: toDate(entry.created_at),
        updatedAt: toDate(entry.updated_at),
      });
    }
    return listing;
  }

  async putPlaceholder(key: string, contentType: string): Promise<void> {
    const { error } = await this.api().upload(key, new Uint8Array(0), { contentType, upsert: false, cacheControl: "60" });
    if (error) {
      const status = statusOf(error);
      throw new SupabaseStorageOpError(status === 409 ? "ALREADY_EXISTS" : "PLACEHOLDER_FAILED", "Upload reservation failed.", status);
    }
  }

  async createSignedUploadUrl(key: string): Promise<SignedUpload> {
    const { data, error } = await this.api().createSignedUploadUrl(key, { upsert: true });
    if (error || !data?.signedUrl) throw new SupabaseStorageOpError("SIGN_UPLOAD_FAILED", "Could not create upload URL.", statusOf(error));
    return { signedUrl: this.assertOwnOrigin(data.signedUrl), key };
  }

  async info(key: string): Promise<StoredObjectInfo | null> {
    const { data, error } = await this.api().info(key);
    if (error) {
      if (statusOf(error) === 404 || /not.?found/i.test(String((error as { message?: unknown })?.message ?? ""))) return null;
      throw new SupabaseStorageOpError("INFO_FAILED", "Object metadata lookup failed.", statusOf(error));
    }
    if (!data) return null;
    const size = Number(data.size ?? data.metadata?.size);
    return {
      key,
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : null,
      createdAt: toDate(data.created_at ?? data.createdAt),
      updatedAt: toDate(data.updated_at ?? data.updatedAt ?? data.last_modified),
    };
  }

  async createSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.api().createSignedUrl(key, expiresInSeconds);
    if (error || !data?.signedUrl) throw new SupabaseStorageOpError("SIGN_FAILED", "Could not sign URL.", statusOf(error));
    return this.assertOwnOrigin(data.signedUrl);
  }

  async readPrefix(key: string, length: number): Promise<Buffer> {
    if (!Number.isInteger(length) || length <= 0 || length > 4096) throw new RangeError("readPrefix length out of range");
    const url = await this.createSignedUrl(key, 60);
    const res = await fetch(url, { headers: { Range: `bytes=0-${length - 1}` }, redirect: "error" });
    if (res.status !== 206 && res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new SupabaseStorageOpError("RANGE_READ_FAILED", "Could not read object header.", res.status);
    }
    // Read at most `length` bytes even if the server ignored the Range header.
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < length) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => {});
    return Buffer.concat(chunks).subarray(0, length);
  }

  async openDownloadStream(key: string, maxBytes: number): Promise<Readable> {
    const url = await this.createSignedUrl(key, 300);
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new SupabaseStorageOpError("DOWNLOAD_FAILED", "Source download failed.", res.status);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new SupabaseStorageOpError("TOO_LARGE", "Source exceeds the size limit.");
    }
    let seen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > maxBytes) return cb(new SupabaseStorageOpError("TOO_LARGE", "Source exceeds the size limit."));
        cb(null, chunk);
      },
    });
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    body.on("error", (err) => meter.destroy(err));
    return body.pipe(meter);
  }

  async putStream(key: string, stream: NodeJS.ReadableStream, options: { contentType: string; maxBytes: number; contentLength: number }) {
    // Delegates to the Stage 8 streaming uploader (unchanged behaviour; contentLength always passed).
    return getVideoObjectStorage().putStream(key, stream, options);
  }

  async delete(key: string): Promise<void> {
    await getVideoObjectStorage().delete(key);
  }
}

let cached: SupabaseClipperStorage | undefined;

export function getClipperStorage(): SupabaseClipperStorage {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "generated-assets";
  if (!url || !secretKey) throw new SupabaseStorageOpError("CONFIG", "Missing Supabase storage configuration.");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@supabase/supabase-js");
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  cached = new SupabaseClipperStorage(client, bucket, url);
  return cached;
}
