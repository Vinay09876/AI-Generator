"use client";

import { Download, ImageOff } from "lucide-react";
import { clipDownloadHref, formatClock } from "@/features/clipper/client";
import type { ClipView } from "@/features/clipper/job-view";
import { cn } from "@/lib/utils";

const ASPECT_CLASS: Record<string, string> = { "9:16": "aspect-[9/16]", "1:1": "aspect-square", "16:9": "aspect-video" };

/**
 * One rendered clip. Plays from a short-lived signed URL; when it has expired (or fails to load)
 * onExpired asks the parent to fetch fresh links. Downloads go through the same-origin download
 * route, which checks ownership and redirects to a 60-second attachment link.
 */
export function ClipCard({
  jobId,
  clip,
  index,
  aspectRatio,
  onExpired,
}: {
  jobId: string;
  clip: ClipView;
  index: number;
  aspectRatio: string | null;
  onExpired: () => void;
}) {
  const label = clip.title || `Clip ${index + 1}`;
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-surface">
      <div className={cn("relative bg-black", ASPECT_CLASS[aspectRatio ?? ""] ?? "aspect-video")}>
        {clip.videoUrl ? (
          <video
            key={clip.videoUrl}
            src={clip.videoUrl}
            poster={clip.thumbnailUrl ?? undefined}
            controls
            playsInline
            preload="none"
            onError={onExpired}
            className="absolute inset-0 size-full object-contain"
            aria-label={`${label}, ${formatClock(clip.durationSeconds)}`}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-muted">
            <span>
              <ImageOff className="mx-auto mb-2 size-5" aria-hidden="true" />
              Preview unavailable.{" "}
              <button type="button" onClick={onExpired} className="text-violet-300 underline-offset-4 hover:underline">
                Retry
              </button>
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">{label}</h3>
          <p className="text-xs text-muted tabular-nums">
            {formatClock(clip.durationSeconds)}
            {clip.width && clip.height ? ` · ${clip.width}×${clip.height}` : ""}
          </p>
        </div>
        <a
          href={clipDownloadHref(jobId, clip.assetId)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-foreground ring-1 ring-white/10 transition-colors ring-inset hover:bg-white/[0.1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet"
          aria-label={`Download ${label}`}
        >
          <Download className="size-3.5" aria-hidden="true" />
          Download
        </a>
      </div>
    </article>
  );
}
