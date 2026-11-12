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
import { utcDayRange } from "@/lib/utc";
import { getWalletSummary } from "@/features/credits/queries";
import { cancelQueuedClipJob } from "./cancel";
import {
  CLIPPER_ANALYSIS_CAPABILITIES,
  CLIPPER_CLIP_DURATION_INFO,
  CLIPPER_DOWNLOAD_URL_EXPIRY_SECONDS,
  CLIPPER_QUEUE_WAIT_STALE_MS,
  CLIPPER_SIGNED_URL_EXPIRY_SECONDS,
  DEFAULT_CREDIT_COST_PER_CLIP,
  DEFAULT_MAX_SOURCE_LONG_EDGE,
  DEFAULT_MAX_SOURCE_PIXELS,
  DEFAULT_MAX_SOURCE_SHORT_EDGE,
  DEFAULT_MIN_SOURCE_LONG_EDGE,
  DEFAULT_MIN_SOURCE_SHORT_EDGE,
  ALLOWED_CLIPPER_MIME_TYPES,
  ALLOWED_FILE_EXTENSIONS,
  getClipperMaxClipsPerJob,
  getClipperMaxSourceDurationSeconds,
  getClipperMaxUploadBytes,
  getClipperMinSourceDurationSeconds,
  getDailyUserClipLimit,
  resolveClipperSubmissionsSwitch,
} from "./config";
import { createClipperHandlers } from "./http";
import { toClipJobView, type ClipJobRecord, type ClipJobView } from "./job-view";
import type { ClipperLimitsView } from "./client/view-state";
import {
  cancelQueuedClipperJobForUser,
  countDailyClipJobs,
  createClipperJob,
  getClipperJobCleanupState,
  reconcileStaleClipperJobs,
  recordClipperCleanupResults,
} from "./lifecycle";
import { createClipperCronHandler, type ClipperMaintenanceDeps } from "./maintenance";
import {
  findClipJobIdByIdempotencyKey,
  findClipJobsWithPendingCleanups,
  getActiveClipJobForUser,
  getActiveClipSourceKeys,
  getClipAssetForDownload,
  getClipAssetKeys,
  getClipJobForUser,
  getPlatformVideoAsset,
  getRecentCompletedClipJobsForUser,
  isClipSourceKeyReferenced,
  isUploadKeyInActiveClipJob,
} from "./queries";
import { isClipKeyOwnedBy, isClipThumbnailKeyOwnedBy } from "./storage/keys";
import { getClipperStorage } from "./storage/supabase-clipper";
import { createPrismaUserLock } from "./user-lock";
import type { ClipperUploadDeps } from "./uploads/uploads";

let trustedOrigins: string[] | undefined;

/** Same `User` row lock as job creation (see ./user-lock.ts). */
const withUserLock: ClipperUploadDeps["withUserLock"] = createPrismaUserLock(prisma);

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
    submissionsEnabled: () => resolveClipperSubmissionsSwitch(process.env).enabled,
    cancelJob: (userId, jobId) =>
      cancelQueuedClipJob(
        {
          cancelInDb: (p) => cancelQueuedClipperJobForUser(p),
          storage: getClipperStorage(),
          recordCleanup: (p) => recordClipperCleanupResults(p),
        },
        { userId, jobId },
      ),
    signDownload: signClipDownload,
  });
  return handlers;
}

async function signClipDownload(userId: string, jobId: string, assetId: string): Promise<string | null> {
  const asset = await getClipAssetForDownload(userId, jobId, assetId);
  if (!asset || !isClipKeyOwnedBy(asset.storageKey, userId)) return null;
  // Rendered clips are always MP4 (H.264/AAC).
  return getClipperStorage().createSignedUrl(asset.storageKey, CLIPPER_DOWNLOAD_URL_EXPIRY_SECONDS, {
    download: `yourai-clip-${assetId.slice(0, 12)}.mp4`,
  });
}

// ---------------------------------------------------------------------------
// Batch 6: server data for the /video-clipper page (read-only)
// ---------------------------------------------------------------------------
export type ClipperPageLimits = ClipperLimitsView;

export interface ClipperPageData {
  submissions: { enabled: boolean; source: "explicit" | "default" | "invalid" };
  limits: ClipperPageLimits;
  analysis: typeof CLIPPER_ANALYSIS_CAPABILITIES;
  balance: number;
  dailyUsed: number;
  dailyLimit: number;
  activeJob: ClipJobView | null;
  recentJobs: ClipJobView[];
}

export function getClipperPageLimits(): ClipperPageLimits {
  return {
    maxUploadBytes: getClipperMaxUploadBytes(),
    minSourceSeconds: getClipperMinSourceDurationSeconds(),
    maxSourceSeconds: getClipperMaxSourceDurationSeconds(),
    minLongEdge: DEFAULT_MIN_SOURCE_LONG_EDGE,
    minShortEdge: DEFAULT_MIN_SOURCE_SHORT_EDGE,
    maxLongEdge: DEFAULT_MAX_SOURCE_LONG_EDGE,
    maxShortEdge: DEFAULT_MAX_SOURCE_SHORT_EDGE,
    maxPixels: DEFAULT_MAX_SOURCE_PIXELS,
    maxClips: getClipperMaxClipsPerJob(),
    creditsPerClip: DEFAULT_CREDIT_COST_PER_CLIP,
    mimeTypes: ALLOWED_CLIPPER_MIME_TYPES,
    extensions: ALLOWED_FILE_EXTENSIONS,
    clipDuration: CLIPPER_CLIP_DURATION_INFO,
    queueTimeoutMinutes: Math.round(CLIPPER_QUEUE_WAIT_STALE_MS / 60_000),
  };
}

async function signedViewsFor(userId: string, record: ClipJobRecord): Promise<ClipJobView> {
  const signed = new Map<string, { videoUrl: string | null; thumbnailUrl: string | null }>();
  if (record.status === "COMPLETED") {
    await Promise.all(
      record.assets.map(async (a) => {
        const [videoUrl, thumbnailUrl] = await Promise.all([
          signClipAsset(userId, a.id, "video").catch(() => null),
          a.thumbnailKey ? signClipAsset(userId, a.id, "thumbnail").catch(() => null) : Promise.resolve(null),
        ]);
        signed.set(a.id, { videoUrl, thumbnailUrl });
      }),
    );
  }
  return toClipJobView(record, signed);
}

/** Owner-scoped reads for the page. Signing failures degrade to null URLs, never throw. */
export async function loadClipperPageData(userId: string, recentLimit = 6): Promise<ClipperPageData> {
  const [wallet, dailyUsed, active, recent] = await Promise.all([
    getWalletSummary(userId),
    countDailyClipJobs(prisma, userId, utcDayRange(new Date())),
    getActiveClipJobForUser(userId),
    getRecentCompletedClipJobsForUser(userId, recentLimit),
  ]);
  const sw = resolveClipperSubmissionsSwitch(process.env);
  return {
    submissions: { enabled: sw.enabled, source: sw.source },
    limits: getClipperPageLimits(),
    analysis: CLIPPER_ANALYSIS_CAPABILITIES,
    balance: wallet.balance,
    dailyUsed,
    // The job API does not pass a tier, so every user gets the promotional limit (same as createClipperJob).
    dailyLimit: getDailyUserClipLimit(),
    activeJob: active ? toClipJobView(active) : null,
    recentJobs: await Promise.all(recent.map((r) => signedViewsFor(userId, r))),
  };
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
