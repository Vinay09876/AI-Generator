"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VideoAspectRatio } from "@/features/video/config";
import type { VideoAssetView, VideoJobView } from "@/features/video/job-view";
import { useVideoGeneration } from "@/features/video/client/use-video-generation";
import { AspectRatioSelector } from "./aspect-ratio-selector";
import { RecentVideos } from "./recent-videos";
import { VideoCostSummary } from "./video-cost-summary";
import { type PreviewVideoItem, VideoPreviewStage } from "./video-preview-stage";
import { VideoPromptEditor } from "./video-prompt-editor";
import { VideoSpecsBadge } from "./video-specs-badge";

export interface VideoGeneratorProps {
  userId: string;
  balance: number;
  dailyUsed: number;
  dailyLimit: number;
  creditCost?: number;
  activeJob: { job: VideoJobView; asset: VideoAssetView | null } | null;
  recentVideos: PreviewVideoItem[];
}

export function VideoGenerator({
  userId,
  balance,
  dailyUsed,
  dailyLimit,
  creditCost = 10,
  activeJob,
  recentVideos: initialRecentVideos,
}: VideoGeneratorProps) {
  const {
    state,
    phase,
    isSubmitting,
    isPolling,
    activeJob: liveJob,
    completedAsset: liveAsset,
    error,
    submit,
    poll,
    stop,
    reset,
  } = useVideoGeneration();

  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>("16:9");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<PreviewVideoItem | null>(null);
  const [recentVideos, setRecentVideos] = useState<PreviewVideoItem[]>(initialRecentVideos);
  const [announcement, setAnnouncement] = useState("");

  const formRef = useRef<HTMLFormElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const busy = isSubmitting || isPolling;

  // 1. Resume active in-progress job from server upon mount / page reload
  useEffect(() => {
    if (activeJob && (activeJob.job.status === "PENDING" || activeJob.job.status === "PROCESSING")) {
      if (activeJob.job.prompt) setPrompt(activeJob.job.prompt);
      if (activeJob.job.aspectRatio) setAspectRatio(activeJob.job.aspectRatio);
      poll(activeJob.job.id, { prompt: activeJob.job.prompt ?? undefined });
    }
  }, [activeJob, poll]);

  // 2. When a live generation completes, prepend it to recent videos
  useEffect(() => {
    if (phase === "completed" && liveJob && liveAsset) {
      const newItem: PreviewVideoItem = { job: liveJob, asset: liveAsset };
      setRecentVideos((prev) => {
        if (prev.some((item) => item.job.id === liveJob.id)) return prev;
        return [newItem, ...prev.slice(0, 7)];
      });
      setSelectedHistoryItem(null);
    }
  }, [phase, liveJob, liveAsset]);

  // 3. Screen-reader announcements
  useEffect(() => {
    if (phase === "submitting") {
      setAnnouncement("Dispatching video generation to GPU cluster.");
    } else if (phase === "polling") {
      setAnnouncement("Synthesizing cinematic video frames at 16 frames per second.");
    } else if (phase === "completed") {
      setAnnouncement("Video generation complete. Your video is ready to play and download.");
    } else if (phase === "failed") {
      setAnnouncement(`Video generation failed. ${error?.message ?? "Credits refunded."}`);
    }
  }, [phase, error]);

  // Blocked conditions
  const hasInsufficientCredits = balance < creditCost;
  const isDailyLimitReached = dailyUsed >= dailyLimit;
  const isBlocked = busy || hasInsufficientCredits || isDailyLimitReached;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isBlocked) return;

    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      setPromptError("Please enter a description for your video.");
      formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      return;
    }

    setPromptError(null);
    setSelectedHistoryItem(null);

    // Scroll to preview on mobile/tablet
    if (window.innerWidth < 1280 && previewRef.current) {
      previewRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    await submit({
      prompt: trimmed,
      aspectRatio,
      durationSeconds: 5,
      resolution: "720p",
      frameRate: 16,
    });
  };

  const handleSelectHistoryItem = (item: PreviewVideoItem) => {
    setSelectedHistoryItem(item);
    if (window.innerWidth < 1280 && previewRef.current) {
      previewRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleReusePrompt = (reusedPrompt: string, reusedAr: VideoAspectRatio) => {
    setPrompt(reusedPrompt);
    setAspectRatio(reusedAr);
    setSelectedHistoryItem(null);
    formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  };

  return (
    <div className="space-y-8">
      {/* Screen Reader Announcements */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {/* Main Grid: Composer (Left) & Preview Stage (Right) */}
      <div className="mx-auto grid w-full grid-cols-1 gap-8 xl:grid-cols-12 xl:items-start">
        {/* Left Column: Form & Controls */}
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          noValidate
          aria-label="Create AI Video"
          className="min-w-0 space-y-6 rounded-3xl border border-white/[0.08] bg-surface/60 p-5 sm:p-6 backdrop-blur-xl xl:col-span-5"
        >
          {/* Specs Telemetry Badge */}
          <VideoSpecsBadge />

          {/* Prompt Editor */}
          <VideoPromptEditor
            value={prompt}
            maxLength={2048}
            error={promptError}
            readOnly={busy}
            onChange={(val) => {
              setPrompt(val);
              if (promptError && val.trim()) setPromptError(null);
            }}
          />

          {/* Aspect Ratio Selector */}
          <AspectRatioSelector
            value={aspectRatio}
            onChange={setAspectRatio}
            disabled={busy}
          />

          {/* Cost & Account Quota Summary */}
          <VideoCostSummary
            creditCost={creditCost}
            balance={balance}
            dailyUsed={dailyUsed}
            dailyLimit={dailyLimit}
            hasActiveJob={Boolean(activeJob && (activeJob.job.status === "PENDING" || activeJob.job.status === "PROCESSING"))}
          />

          {/* Submit Action */}
          <div className="pt-2">
            <Button
              type="submit"
              size="lg"
              loading={busy}
              disabled={isBlocked || prompt.trim().length === 0}
              className="w-full text-base font-semibold shadow-lg shadow-violet/25"
            >
              {busy ? (
                <>
                  <Sparkles className="size-4 animate-spin text-violet-300 motion-reduce:animate-none" />
                  <span>Synthesizing Video...</span>
                </>
              ) : (
                <>
                  <Video className="size-4" />
                  <span>Generate Video ({creditCost} Credits)</span>
                </>
              )}
            </Button>
          </div>
        </form>

        {/* Right Column: Viewfinder / Video Preview Stage */}
        <div ref={previewRef} className="min-w-0 xl:col-span-7">
          <VideoPreviewStage
            phase={phase}
            aspectRatio={aspectRatio}
            liveJob={liveJob}
            liveAsset={liveAsset}
            selectedHistoryItem={selectedHistoryItem}
            error={error}
            startedAt={state.phase === "polling" || state.phase === "submitting" ? state.startedAt : undefined}
            outcomeUnknown={state.phase === "polling" ? state.outcomeUnknown : false}
            onStop={stop}
            onReset={reset}
            onClearHistorySelection={() => setSelectedHistoryItem(null)}
            onReusePrompt={handleReusePrompt}
          />
        </div>
      </div>

      {/* Bottom Section: Recent Videos Gallery */}
      <div className="pt-4">
        <RecentVideos
          items={recentVideos}
          selectedJobId={selectedHistoryItem?.job.id ?? (phase === "completed" ? liveJob?.id : null)}
          onSelectItem={handleSelectHistoryItem}
        />
      </div>
    </div>
  );
}

