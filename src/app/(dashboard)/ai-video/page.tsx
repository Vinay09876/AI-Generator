import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ROUTES } from "@/lib/constants";
import { utcDayRange } from "@/lib/utc";
import { getWalletSummary } from "@/features/credits/queries";
import { PageHeader } from "@/components/dashboard/page-header";
import { RevealGroup, RevealItem } from "@/components/dashboard/reveal";
import { getVideoCreditCost } from "@/features/video/config";
import { resolveUserVideoEntitlement } from "@/features/video/auth";
import { countDailyVideoJobs } from "@/features/video/lifecycle";
import {
  getActiveVideoJob,
  getRecentVideoJobsWithUrls,
} from "@/features/video/queries";
import { toVideoJobView } from "@/features/video/job-view";
import { getVideoObjectStorage } from "@/features/video/storage/supabase";
import { VideoDailyUsage } from "@/components/video-generator/video-daily-usage";
import { VideoGenerator } from "@/components/video-generator/video-generator";

export const metadata: Metadata = {
  title: "AI Video Generator — Cinematic 720p Studio",
  description: "Generate cinematic 720p 16 FPS video from text prompts using the Wan 2.1 model.",
};

const RECENT_VIDEOS_LIMIT = 8;

export default async function AiVideoPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect(`${ROUTES.login}?callbackUrl=${encodeURIComponent(ROUTES.aiVideo)}`);
  }

  // 1. Resolve authoritative server-side video entitlements and pricing
  const entitlement = resolveUserVideoEntitlement({
    user: session.user,
    nodeEnv: process.env.NODE_ENV,
  });
  const dailyLimit = entitlement.dailyLimit;
  const creditCost = getVideoCreditCost();

  // 2. Parallel owner-scoped reads
  const storage = getVideoObjectStorage();
  const [wallet, dailyUsed, activeJobRecord, recentVideos] = await Promise.all([
    getWalletSummary(userId),
    countDailyVideoJobs(prisma, userId, utcDayRange(new Date())),
    getActiveVideoJob(userId),
    getRecentVideoJobsWithUrls(userId, storage, RECENT_VIDEOS_LIMIT),
  ]);

  const activeJob = activeJobRecord ? toVideoJobView(activeJobRecord) : null;

  return (
    <RevealGroup className="space-y-6">
      <RevealItem>
        {/* Header Bar */}
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 sm:flex-row sm:items-end sm:justify-between xl:max-w-none">
          <PageHeader
            title="AI Video Generator"
            description="Turn your prompt into cinematic 720p 16 FPS video with Wan 2.1."
          />
          <VideoDailyUsage used={dailyUsed} limit={dailyLimit} />
        </div>
      </RevealItem>

      <RevealItem>
        <VideoGenerator
          userId={userId}
          balance={wallet.balance}
          dailyUsed={dailyUsed}
          dailyLimit={dailyLimit}
          creditCost={creditCost}
          activeJob={activeJob}
          recentVideos={recentVideos}
        />
      </RevealItem>
    </RevealGroup>
  );
}
