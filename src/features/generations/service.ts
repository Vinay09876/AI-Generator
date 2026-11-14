import "server-only";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveTrustedOrigins } from "@/lib/api";
import { defaultRateLimiter, RATE_LIMITS } from "@/lib/rate-limit";
import { getSignedAssetUrl } from "./assets";
import { runImageGeneration, type GenerationDeps } from "./generate-image";
import { createGenerationHandlers } from "./http";
import { convertProviderImageToWebp } from "./image-processing";
import * as lifecycle from "./lifecycle";
import { getImageProvider } from "./providers";
import { getImageJobForUser } from "./queries";
import { getObjectStorage } from "./storage";

/**
 * Production wiring for the Stage 5 generation API: real lifecycle (Stage 3), Cloudflare
 * provider and Supabase storage (Stage 4), Auth.js session. Route files only delegate here.
 */

const generationDeps: GenerationDeps = {
  lifecycle,
  getProvider: getImageProvider,
  getStorage: getObjectStorage,
  convertImage: (bytes) => convertProviderImageToWebp(bytes),
};

let trustedOrigins: string[] | undefined;

export const generationHandlers = createGenerationHandlers({
  getUserId: async () => (await auth())?.user?.id ?? null,
  trustedOrigins: () => (trustedOrigins ??= resolveTrustedOrigins()),
  generate: (input) => runImageGeneration(input, generationDeps),
  loadJob: getImageJobForUser,
  loadBalance: async (userId) =>
    (await prisma.creditWallet.findUnique({ where: { userId }, select: { balance: true } }))?.balance ?? null,
  reconcileForUser: (userId) => lifecycle.reconcileStaleJobs({ userId, limit: 5 }),
  // after() runs once the response has been sent. It is BEST EFFORT: if the process stops,
  // the task is lost. Correctness never depends on it — stale jobs are also settled
  // whenever their owner calls POST or GET (see PROJECT_CONTEXT.md).
  scheduleBackground: (task) =>
    after(async () => {
      try {
        await task();
      } catch (error) {
        console.error("[api/generations] background reconciliation failed", { name: (error as Error | null)?.name });
      }
    }),
  reconcileGlobal: () => lifecycle.reconcileStaleJobs({ limit: 10 }),
  signAssetUrl: (userId, assetId) => getSignedAssetUrl({ userId, assetId, storage: getObjectStorage() }),
  checkRateLimit: (key) => defaultRateLimiter.check(key, RATE_LIMITS.GENERATION_USER),
});
