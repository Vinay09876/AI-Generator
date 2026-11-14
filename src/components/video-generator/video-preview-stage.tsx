"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Download,
  Film,
  RotateCcw,
  Sparkles,
  StopCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VideoAspectRatio } from "@/features/video/config";
import type { VideoAssetView, VideoJobView } from "@/features/video/job-view";
import type { VideoClientError, VideoGenerationPhase } from "@/features/video/client/types";
import { cn } from "@/lib/utils";
import { VideoPlayer } from "./video-player";

export interface PreviewVideoItem {
  job: VideoJobView;
  asset: VideoAssetView | null;
}

interface VideoPreviewStageProps {
  phase: VideoGenerationPhase;
  aspectRatio: VideoAspectRatio;
  liveJob: VideoJobView | null;
  liveAsset: VideoAssetView | null;
  selectedHistoryItem: PreviewVideoItem | null;
  error: VideoClientError | null;
  startedAt?: number;
  outcomeUnknown?: boolean;
  onStop: () => void;
  onReset: () => void;
  onClearHistorySelection: () => void;
  onReusePrompt?: (prompt: string, ar: VideoAspectRatio) => void;
}

export function VideoPreviewStage({
  phase,
  aspectRatio,
  liveJob,
  liveAsset,
  selectedHistoryItem,
  error,
  startedAt,
  outcomeUnknown,
  onStop,
  onReset,
  onClearHistorySelection,
  onReusePrompt,
}: VideoPreviewStageProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [copied, setCopied] = useState(false);

  // Live timer during active generation
  useEffect(() => {
    if (phase !== "submitting" && phase !== "polling") {
      setElapsedSeconds(0);
      return;
    }

    const start = startedAt ?? Date.now();
    const interval = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    }, 1000);

    return () => clearInterval(interval);
  }, [phase, startedAt]);

  const formatElapsed = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = sec % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}s`;
  };

  const handleCopyPrompt = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Determine which item is being displayed:
  // 1. If an earlier history item is selected, display it
  // 2. Otherwise display live generation (idle, submitting, polling, completed, failed)
  const isHistoryView = Boolean(selectedHistoryItem);
  const activeDisplayItem = selectedHistoryItem ?? (liveJob ? { job: liveJob, asset: liveAsset } : null);

  const effectiveAspectRatio: VideoAspectRatio =
    activeDisplayItem?.job.aspectRatio ?? aspectRatio;

  const aspectClass =
    effectiveAspectRatio === "9:16"
      ? "aspect-[9/16] max-h-[560px]"
      : effectiveAspectRatio === "1:1"
      ? "aspect-square max-h-[500px]"
      : "aspect-video max-h-[500px]";

  return (
    <div className="space-y-4">
      {/* View Switcher Header (when viewing history item) */}
      {isHistoryView && (
        <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-black/40 px-4 py-2.5 text-xs backdrop-blur-md">
          <div className="flex items-center gap-2 text-muted">
            <Film className="size-3.5 text-violet-400" />
            <span>Viewing previously generated video</span>
          </div>
          <button
            type="button"
            onClick={onClearHistorySelection}
            className="flex items-center gap-1.5 font-medium text-violet-300 transition-colors hover:text-violet-100"
          >
            <ArrowLeft className="size-3.5" /> Back to Generator
          </button>
        </div>
      )}

      {/* Main Viewport Container */}
      <div className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-surface/50 p-2 sm:p-4 backdrop-blur-xl">
        {/* State A: Completed (Live or History View) */}
        {activeDisplayItem?.asset ? (
          <div className="space-y-4">
            <VideoPlayer
              src={activeDisplayItem.asset.videoUrl}
              poster={activeDisplayItem.asset.thumbnailUrl}
              aspectRatio={effectiveAspectRatio}
              autoPlay={!isHistoryView}
              filename={`pixora-video-${activeDisplayItem.job.id.slice(0, 8)}.mp4`}
            />

            {/* Video Details & Action Toolbar */}
            <div className="rounded-2xl border border-white/[0.06] bg-black/30 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="line-clamp-2 text-sm text-foreground">
                    {activeDisplayItem.job.prompt}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-muted/70">
                    <span>{effectiveAspectRatio}</span>
                    <span>•</span>
                    <span>16 FPS</span>
                    <span>•</span>
                    <span>5.0s</span>
                    {activeDisplayItem.asset.sizeBytes && (
                      <>
                        <span>•</span>
                        <span>
                          {(activeDisplayItem.asset.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {/* Copy Prompt */}
                  {activeDisplayItem.job.prompt && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleCopyPrompt(activeDisplayItem.job.prompt!)}
                      title="Copy prompt"
                    >
                      {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                      <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
                    </Button>
                  )}

                  {/* Reuse in Editor */}
                  {onReusePrompt && activeDisplayItem.job.prompt && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        onReusePrompt(activeDisplayItem.job.prompt!, effectiveAspectRatio)
                      }
                      title="Reuse prompt and settings in composer"
                    >
                      <RotateCcw className="size-3.5" />
                      <span className="hidden sm:inline">Reuse</span>
                    </Button>
                  )}

                  {/* Direct Download Link */}
                  <a
                    href={activeDisplayItem.asset.videoUrl}
                    download={`pixora-video-${activeDisplayItem.job.id.slice(0, 8)}.mp4`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-white px-4 text-xs font-semibold text-zinc-950 shadow-md transition-all hover:bg-white/90 active:scale-95"
                  >
                    <Download className="size-3.5" />
                    Download
                  </a>
                </div>
              </div>
            </div>
          </div>
        ) : phase === "submitting" || phase === "polling" ? (
          /* State B: In-Progress (Submitting or Polling) */
          <div
            className={cn(
              "relative mx-auto flex w-full flex-col items-center justify-center overflow-hidden rounded-2xl border border-violet/30 bg-black/60 p-8 text-center shadow-[0_0_50px_-10px_rgba(139,92,246,0.3)] backdrop-blur-md",
              aspectClass,
            )}
          >
            {/* Viewfinder Corner Overlays */}
            <div className="pointer-events-none absolute inset-4">
              <span className="absolute top-0 left-0 size-4 border-t-2 border-l-2 border-violet-400/80" />
              <span className="absolute top-0 right-0 size-4 border-t-2 border-r-2 border-violet-400/80" />
              <span className="absolute bottom-0 left-0 size-4 border-b-2 border-l-2 border-violet-400/80" />
              <span className="absolute bottom-0 right-0 size-4 border-b-2 border-r-2 border-violet-400/80" />
            </div>

            {/* Anamorphic Scanning Laser Beam */}
            <div
              className="pointer-events-none absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-violet-400 to-transparent shadow-[0_0_20px_rgb(139_92_246)] animate-pulse motion-reduce:animate-none"
              style={{ top: "45%" }}
            />

            {/* Center Loading Status */}
            <div className="relative z-10 max-w-sm space-y-4">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-violet/40 bg-violet/10 shadow-[0_0_30px_rgba(139,92,246,0.5)]">
                <Film className="size-6 animate-pulse text-violet-300 motion-reduce:animate-none" />
              </div>

              <div className="space-y-1">
                <h3 className="font-display font-semibold text-lg text-foreground tracking-tight">
                  {phase === "submitting"
                    ? "Dispatching to GPU Cluster..."
                    : outcomeUnknown
                    ? "Reconciling Generation..."
                    : "Synthesizing Cinematic Video..."}
                </h3>
                <p className="text-xs text-muted/80 leading-relaxed">
                  {outcomeUnknown
                    ? "Your generation is running on the GPU queue. Debits are preserved while awaiting results."
                    : "Rendering 81 frames at native 16 FPS with Wan 2.1 720p model."}
                </p>
              </div>

              {/* Monospace Elapsed Timer */}
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1 font-mono text-xs text-violet-200">
                <Clock className="size-3 text-violet-400" />
                <span>Elapsed: {formatElapsed(elapsedSeconds)}</span>
              </div>

              {/* Stop Client Polling Action */}
              <div className="pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onStop}
                  className="text-xs text-muted hover:text-foreground"
                >
                  <StopCircle className="size-3.5" /> Stop checking in browser
                </Button>
                <p className="pt-1 text-[10px] text-muted/50">
                  Generation continues on the server. Your video will appear in History when finished.
                </p>
              </div>
            </div>
          </div>
        ) : phase === "failed" ? (
          /* State C: Failed State */
          <div
            className={cn(
              "relative mx-auto flex w-full flex-col items-center justify-center overflow-hidden rounded-2xl border border-rose-500/30 bg-black/60 p-8 text-center backdrop-blur-md",
              aspectClass,
            )}
          >
            <div className="max-w-md space-y-4">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-rose-500/30 bg-rose-500/10">
                <AlertCircle className="size-7 text-rose-400" />
              </div>

              <div className="space-y-1">
                <h3 className="font-display font-semibold text-lg text-rose-200">
                  Generation Incomplete
                </h3>
                <p className="text-xs text-rose-200/80 leading-relaxed">
                  {error?.message ??
                    "We encountered an issue communicating with the video provider. Your credits have been automatically refunded."}
                </p>
              </div>

              <div className="pt-2">
                <Button variant="secondary" size="sm" onClick={onReset}>
                  <RotateCcw className="size-3.5" /> Try Again
                </Button>
              </div>
            </div>
          </div>
        ) : (
          /* State D: Idle / Empty State */
          <div
            className={cn(
              "relative mx-auto flex w-full flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-white/15 bg-black/40 p-8 text-center transition-all",
              aspectClass,
            )}
          >
            {/* Viewfinder Corner Overlays */}
            <div className="pointer-events-none absolute inset-4">
              <span className="absolute top-0 left-0 size-4 border-t border-l border-white/20" />
              <span className="absolute top-0 right-0 size-4 border-t border-r border-white/20" />
              <span className="absolute bottom-0 left-0 size-4 border-b border-l border-white/20" />
              <span className="absolute bottom-0 right-0 size-4 border-b border-r border-white/20" />
            </div>

            <div className="relative z-10 max-w-sm space-y-3">
              <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-white/10 bg-white/5 text-muted">
                <Sparkles className="size-5 text-violet-400" />
              </div>

              <div className="space-y-1">
                <h3 className="font-display font-semibold text-base text-foreground tracking-tight">
                  Cinematic Viewfinder
                </h3>
                <p className="text-xs text-muted/70 leading-relaxed">
                  Enter your prompt and select an aspect ratio to generate a high-definition
                  video at 16 FPS.
                </p>
              </div>

              <div className="flex items-center justify-center gap-2 pt-1 font-mono text-[11px] text-muted/50">
                <span>{effectiveAspectRatio} Frame</span>
                <span>•</span>
                <span>720p HD</span>
                <span>•</span>
                <span>5.0s</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

