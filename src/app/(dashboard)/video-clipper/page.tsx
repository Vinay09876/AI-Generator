import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ROUTES } from "@/lib/constants";
import { PageHeader } from "@/components/dashboard/page-header";
import { RevealGroup, RevealItem } from "@/components/dashboard/reveal";
import { StudioNav } from "@/components/dashboard/studio-nav";
import { VideoClipper } from "@/components/video-clipper/video-clipper";
import { loadClipperPageData } from "@/features/clipper/service";

export const metadata: Metadata = {
  title: "AI Video Clipper",
  description: "Turn a longer video into short vertical, square or landscape clips chosen from scene changes and pacing.",
};

export default async function VideoClipperPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect(`${ROUTES.login}?callbackUrl=${encodeURIComponent(ROUTES.videoClipper)}`);
  }

  const data = await loadClipperPageData(userId);

  return (
    <RevealGroup className="space-y-6">
      <RevealItem>
        <StudioNav className="mb-6" />
        <PageHeader
          title="AI Video Clipper"
          description="Upload a video and get short clips cut at scene changes, reframed for vertical, square or landscape."
        />
      </RevealItem>
      <RevealItem>
        <VideoClipper
          userId={userId}
          submissionsEnabled={data.submissions.enabled}
          limits={data.limits}
          analysis={data.analysis}
          balance={data.balance}
          dailyUsed={data.dailyUsed}
          dailyLimit={data.dailyLimit}
          activeJobId={data.activeJob?.id ?? null}
          recentJobs={data.recentJobs}
        />
      </RevealItem>
    </RevealGroup>
  );
}
