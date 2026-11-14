"use client";

import { Download, Film, Play, Sparkles } from "lucide-react";
import type { PreviewVideoItem } from "./video-preview-stage";
import { cn } from "@/lib/utils";

interface RecentVideosProps {
  items: PreviewVideoItem[];
  selectedJobId?: string | null;
  onSelectItem: (item: PreviewVideoItem) => void;
}

export function RecentVideos({ items, selectedJobId, onSelectItem }: RecentVideosProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-3xl border border-white/[0.08] bg-surface/40 p-8 text-center backdrop-blur-xl">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-muted">
          <Film className="size-5 text-violet-400" />
        </div>
        <h4 className="mt-3 font-semibold text-sm text-foreground">No Videos Generated Yet</h4>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted/80 leading-relaxed">
          Your generated videos will appear here. Choose a prompt above and generate your first
          cinematic 720p video.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h3 className="flex items-center gap-2 font-display font-semibold text-base text-foreground tracking-tight">
          <Film className="size-4 text-violet-400" /> Recent Videos
        </h3>
        <span className="font-mono text-xs text-muted/60">
          {items.length} {items.length === 1 ? "video" : "videos"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {items.map((item) => {
          const isSelected = selectedJobId === item.job.id;
          const hasThumbnail = Boolean(item.asset?.thumbnailUrl);

          return (
            <div
              key={item.job.id}
              onClick={() => onSelectItem(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectItem(item);
                }
              }}
              className={cn(
                "group relative flex flex-col overflow-hidden rounded-2xl border bg-black/40 text-left transition-all duration-300 cursor-pointer",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
                isSelected
                  ? "border-violet ring-2 ring-violet/40 shadow-[0_0_25px_rgba(139,92,246,0.4)]"
                  : "border-white/[0.08] hover:border-white/20 hover:bg-black/60",
              )}
            >
              {/* Media Thumbnail Container */}
              <div className="relative aspect-video w-full overflow-hidden bg-black/60">
                {hasThumbnail ? (
                  <img
                    src={item.asset!.thumbnailUrl!}
                    alt={item.job.prompt ?? "Video thumbnail"}
                    className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
                    loading="lazy"
                  />
                ) : (
                  /* Fallback when thumbnail is absent (e.g. video element poster preview) */
                  <video
                    src={item.asset?.videoUrl}
                    preload="metadata"
                    muted
                    playsInline
                    className="size-full object-cover opacity-80"
                  />
                )}

                {/* Hover Play Overlay */}
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                  <div className="flex size-9 items-center justify-center rounded-full bg-white/20 text-white shadow-lg backdrop-blur-md">
                    <Play className="ml-0.5 size-4 fill-white" />
                  </div>
                </div>

                {/* Aspect Ratio & Duration Badges */}
                <div className="absolute top-2 left-2 flex items-center gap-1 font-mono text-[10px]">
                  <span className="rounded-md bg-black/70 px-1.5 py-0.5 font-medium text-white/90 backdrop-blur-sm">
                    {item.job.aspectRatio ?? "16:9"}
                  </span>
                  <span className="rounded-md bg-black/70 px-1.5 py-0.5 font-medium text-white/90 backdrop-blur-sm">
                    5s
                  </span>
                </div>

                {/* Quick Download Button on Thumbnail */}
                {item.asset?.videoUrl && (
                  <a
                    href={item.asset.videoUrl}
                    download={`pixora-video-${item.job.id.slice(0, 8)}.mp4`}
                    onClick={(e) => e.stopPropagation()}
                    title="Download video"
                    className="absolute top-2 right-2 rounded-md bg-black/70 p-1 text-white/80 opacity-0 transition-all hover:bg-black hover:text-white group-hover:opacity-100"
                  >
                    <Download className="size-3.5" />
                  </a>
                )}
              </div>

              {/* Caption */}
              <div className="p-2.5">
                <p className="line-clamp-2 text-xs text-foreground/90 transition-colors group-hover:text-foreground">
                  {item.job.prompt ?? "Untitled Video"}
                </p>
                <div className="mt-1 flex items-center justify-between text-[10px] text-muted/60">
                  <span>16 FPS</span>
                  <span>720p</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

