import "server-only";
/**
 * Production wiring for the clipper HTTP API and maintenance cron (Batch 5).
 * Route files only delegate here. Not executed against live services in Batch 5.
 */

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveTrustedOrigins } from "@/lib/api";
import { defaultRateLimiter, RATE_LIMITS } from "@/lib/rate-limit";
import { AccountingError } from "@/features/generations/errors";
import { CLIPPER_SIGNED_URL_EXPIRY_SECONDS } from "./config";
import { createClipperHandlers } from "./http";
import { createClipperJob, getClipperJobCleanupState, reconcileStaleClipperJobs, recordClipperCleanupResults } from "./lifecycle";
import { createClipperCronHandler, type ClipperMaintenanceDeps } from "./maintenance";
import {
  findClipJobIdByIdempotencyKey,
  findClipJobsWithPendingCleanups,
  getActiveClipSourceKeys,
  getClipAssetKeys,
  getClipJobForUser,
  getPlatformVideoAsset,
  isClipSourceKeyReferenced,
  isUploadKeyInActiveClipJob,
} from "./queries";
import { isClipKeyOwnedBy, isClipThumbnailKeyOwnedBy } from "./storage/keys";
import { getClipperStorage } from "./storage/supabase-clipper";
import type { ClipperUploadDeps } from "./uploads/uploads";

let trustedOrigins: string[] | undefined;

/**
 * Serialises upload reservation per user with the same `User` row lock used by job creation.
 * NOTE: the lock is held across bounded storage calls (list + placeholder, each ≤5 s); this is
 * deliberate so concurrent intents cannot both pass the one-pending-upload check.
 */
const withUserLock: ClipperUploadDeps["withUserLock"] = (userId, fn) =>
  prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (locked.length === 0) throw new AccountingError("USER_NOT_FOUND");
      return fn({ activeSourceKeys: () => getActiveClipSourceKeys(userId, tx) });
    },
    { maxWait: 5_000, timeout: 20_000 },
  );

function uploadDeps(): ClipperUploadDeps {
  return {
    storage: getClipperStorage(),
    withUserLock,
    isSourceKeyReferenced: (userId, key) => isClipSourceKeyReferenced(userId, key),
  };
}

async function signClipAsset(userId: string, assetId: string, kind: "video" | "thumbnail"): Promise<string> {
  const asset = await getClipAssetKeys(userId, assetId);
  const key = kind === "video" ? asset?.storageKey : asset?.thumbnailKey;
  const owned = key && (kind === "video" ? isClipKeyOwnedBy(key, userId) : isClipThumbnailKeyOwnedBy(key, userId));
  if (!key || !owned) throw new Error("NOT_FOUND");
  return getClipperStorage().createSignedUrl(key, CLIPPER_SIGNED_URL_EXPIRY_SECONDS);
}

let handlers: ReturnType<typeof createClipperHandlers> | undefined;

export function getClipperHandlers() {
  if (handlers) return handlers;
  const uploads = uploadDeps();
  handlers = createClipperHandlers({
    getUserId: async () => (await auth())?.user?.id ?? null,
    trustedOrigins: () => (trustedOrigins ??= resolveTrustedOrigins()),
    checkRateLimit: (key) => defaultRateLimiter.check(key, RATE_LIMITS.GENERATION_BURST),
    uploads,
    jobs: {
      uploads,
      loadPlatformVideoAsset: (userId, assetId) => getPlatformVideoAsset(userId, assetId),
      findJobByIdempotencyKey: (userId, key) => findClipJobIdByIdempotencyKey(userId, key),
      createJob: (input, overrides) => createClipperJob(input, overrides),
    },
    loadJob: (userId, jobId) => getClipJobForUser(userId, jobId),
    loadBalance: async (userId) =>
      (await prisma.creditWallet.findUnique({ where: { userId }, select: { balance: true } }))?.balance ?? null,
    signAsset: signClipAsset,
  });
  return handlers;
}

export function clipperMaintenanceDeps(): ClipperMaintenanceDeps {
  const storage = getClipperStorage();
  return {
    reconcileStale: (p) => reconcileStaleClipperJobs(p),
    findJobsWithPendingCleanups: (limit) => findClipJobsWithPendingCleanups(limit),
    lifecycle: {
      getCleanupState: (jobId) => getClipperJobCleanupState(jobId),
      recordCleanup: (p) => recordClipperCleanupResults(p),
    },
    storage,
    isUploadKeyInActiveJob: (key) => isUploadKeyInActiveClipJob(key),
  };
}

export const clipperCronGET = createClipperCronHandler({
  env: () => ({ CRON_SECRET: process.env.CRON_SECRET, NODE_ENV: process.env.NODE_ENV }),
  maintenance: clipperMaintenanceDeps,
});
