import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveTrustedOrigins } from "@/lib/api";
import { defaultRateLimiter, RATE_LIMITS } from "@/lib/rate-limit";
import { createVideoGenerationHandlers } from "./http";
import { claimVideoIngestionLease, reconcileStaleVideoJobs } from "./lifecycle";
import { getFalVideoProvider } from "./providers/fal-provider";
import { getVideoJobForUser } from "./queries";
import { getSignedVideoAssetUrl, ingestVideoOutput } from "./storage/ingestion";
import { getVideoObjectStorage } from "./storage/supabase";
import { processPendingWebhookBatch } from "./webhooks/process-event";

let trustedOrigins: string[] | undefined;

export const videoGenerationHandlers = createVideoGenerationHandlers({
  getUserId: async () => (await auth())?.user?.id ?? null,
  getUser: async (userId: string) => {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerified: true },
    });
  },
  trustedOrigins: () => (trustedOrigins ??= resolveTrustedOrigins()),
  getProvider: () => getFalVideoProvider(),
  loadJob: (userId, jobId) => getVideoJobForUser(userId, jobId, prisma),
  loadBalance: async (userId) =>
    (await prisma.creditWallet.findUnique({ where: { userId }, select: { balance: true } }))?.balance ?? null,
  signAssetUrl: (userId, assetId, kind = "video") =>
    getSignedVideoAssetUrl({ userId, assetId, storage: getVideoObjectStorage(), kind, db: prisma }),
  reconcileForUser: (userId) => reconcileStaleVideoJobs({ userId, limit: 5 }, prisma),
  scheduleBackground: (task) =>
    after(async () => {
      try {
        await task();
      } catch (error) {
        console.error("[api/generations/video] background task failed", {
          name: (error as Error | null)?.name,
          message: (error as Error | null)?.message,
        });
      }
    }),
  triggerPendingIngestion: async (jobId: string) => {
    // 1. Check if the job has providerResult in settings and needs ingestion
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        userId: true,
        status: true,
        settings: true,
        ingestionToken: true,
        ingestionLeaseExpiresAt: true,
      },
    });
    if (!job || job.status !== "PROCESSING") return;

    // 2. Check if an active lease is already held
    if (job.ingestionToken && job.ingestionLeaseExpiresAt && job.ingestionLeaseExpiresAt > new Date()) {
      return; // Already being ingested by another active worker
    }

    const providerResult = (job.settings as Record<string, unknown> | null)?.providerResult as
      | { payload?: { video?: { url?: string }; thumbnail?: { url?: string } } }
      | undefined;
    const videoUrl = providerResult?.payload?.video?.url;

    if (!videoUrl) {
      // If no providerResult recorded directly on job, check durable webhook outbox
      await processPendingWebhookBatch({
        limit: 5,
        storage: getVideoObjectStorage(),
        db: prisma,
      });
      return;
    }

    // 3. Atomically claim ingestion lease
    const token = randomUUID();
    const lease = await claimVideoIngestionLease({ jobId: job.id, customToken: token }, prisma);
    if (!lease.claimed || !lease.token) return;

    // 4. Ingest video output
    await ingestVideoOutput({
      jobId: job.id,
      userId: job.userId,
      ingestionToken: token,
      videoUrl,
      posterUrl: providerResult?.payload?.thumbnail?.url,
      width: 1280,
      height: 720,
      durationSeconds: 5.0,
      storage: getVideoObjectStorage(),
      db: prisma,
    });
  },
  checkRateLimit: (key) => defaultRateLimiter.check(key, RATE_LIMITS.GENERATION_BURST),
});
