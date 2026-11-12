import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ROUTES } from "@/lib/constants";
import { utcDayRange } from "@/lib/utc";
import { getWalletSummary } from "@/features/credits/queries";
import { DAILY_USER_IMAGE_LIMIT } from "@/features/generations/config";
import { toJobView } from "@/features/generations/job-view";
import { countDailyImageJobs } from "@/features/generations/lifecycle";
import { getActiveImageJob, getRecentImageJobs } from "@/features/generations/queries";
import { PageHeader } from "@/components/dashboard/page-header";
import { RevealGroup, RevealItem } from "@/components/dashboard/reveal";
import { StudioNav } from "@/components/dashboard/studio-nav";
import { DailyUsage } from "@/components/image-generator/daily-usage";
import { ImageGenerator } from "@/components/image-generator/image-generator";

export const metadata: Metadata = { title: "AI Image Generator" };

const RECENT_IMAGES = 8;

export default async function AiImagePage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect(`${ROUTES.login}?callbackUrl=${encodeURIComponent(ROUTES.aiImage)}`);

  // Owner-scoped, independent reads in parallel. getWalletSummary is request-cached, so the
  // dashboard layout's balance lookup is reused rather than repeated.
  const [wallet, dailyUsed, activeJob, recentJobs] = await Promise.all([
    getWalletSummary(userId),
    countDailyImageJobs(prisma, userId, utcDayRange(new Date())),
    getActiveImageJob(userId),
    getRecentImageJobs(userId, RECENT_IMAGES),
  ]);

  return (
    <RevealGroup className="space-y-6">
      <RevealItem>
        <StudioNav className="mb-6" />
        {/* Aligned with the generator's centred single column below xl. */}
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 sm:flex-row sm:items-end sm:justify-between xl:max-w-none">
          <PageHeader title="AI Image Generator" description="Describe an image and generate it in seconds." />
          <DailyUsage used={dailyUsed} limit={DAILY_USER_IMAGE_LIMIT} />
        </div>
      </RevealItem>

      <RevealItem>
        <ImageGenerator
          userId={userId}
          balance={wallet.balance}
          dailyUsed={dailyUsed}
          dailyLimit={DAILY_USER_IMAGE_LIMIT}
          activeJob={activeJob ? toJobView(activeJob) : null}
          recentImages={recentJobs.map(toJobView)}
        />
      </RevealItem>
    </RevealGroup>
  );
}
