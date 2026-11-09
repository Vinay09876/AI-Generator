import "server-only";
import { IMAGE_MODEL } from "../config";
import { createCloudflareImageProvider } from "./cloudflare";
import { ProviderError, type ImageProvider } from "./types";

/**
 * Server-only factory: the only place provider credentials are read. Importing this
 * module from client code fails the build (server-only).
 */
let cached: ImageProvider | undefined;

export function getImageProvider(): ImageProvider {
  if (cached) return cached;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN?.trim();
  const missing = [!accountId && "CLOUDFLARE_ACCOUNT_ID", !apiToken && "CLOUDFLARE_AI_API_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    // Names only, never values.
    throw new ProviderError({ code: "CONFIG", outcome: "not_run", message: `Missing environment variables: ${missing.join(", ")}.` });
  }
  cached = createCloudflareImageProvider({ accountId: accountId!, apiToken: apiToken!, model: IMAGE_MODEL });
  return cached;
}

export * from "./types";
