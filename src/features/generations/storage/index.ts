import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SupabaseObjectStorage } from "./supabase";
import { StorageError, type ObjectStorage } from "./types";

/**
 * Server-only factory: the only place the Supabase secret key is read. The resulting
 * client has administrative access (bypasses RLS), so it must never reach the browser.
 */
let cached: ObjectStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim();
  const missing = [!url && "SUPABASE_URL", !secretKey && "SUPABASE_SECRET_KEY", !bucket && "SUPABASE_STORAGE_BUCKET"].filter(Boolean);
  if (missing.length > 0) {
    // Names only, never values.
    throw new StorageError("CONFIG", `Missing environment variables: ${missing.join(", ")}.`);
  }
  const client = createClient(url!, secretKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  cached = new SupabaseObjectStorage(client, bucket!);
  return cached;
}

export * from "./types";
export { buildImageObjectKey, isImageKeyOwnedBy } from "./keys";
