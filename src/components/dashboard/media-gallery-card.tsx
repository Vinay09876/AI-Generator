"use client";

import Link from "next/link";
import { ImageIcon, Video, Scissors, Download, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import type { UnifiedHistoryItem } from "@/features/generations/queries";
import { GENERATION_TYPE_META } from "@/features/generations/meta";
import { formatDateTime, formatFileSize, formatNumber, formatRelative } from "@/lib/format";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function MediaGalleryCard({ job }: { job: UnifiedHistoryItem }) {
  const meta = GENERATION_TYPE_META[job.type];
  const Icon = meta.icon;
  const isCompleted = job.status === "COMPLETED";
  const isPending = job.status === "PENDING" || job.status === "PROCESSING";
  const isFailed = job.status === "FAILED";
  const charged = job.chargedCredits > 0;
  const credits = charged ? job.chargedCredits : job.estimatedCredits;
  const primaryAsset = job.assets && job.assets.length > 0 ? job.assets[0] : null;

  // Determine media action destination
  let actionHref: string | null = null;
  let actionLabel = "View";
  let isDownload = false;

  if (job.type === "IMAGE" && primaryAsset) {
    actionHref = `/api/assets/${primaryAsset.id}`;
    actionLabel = "View Image";
  } else if (job.type === "VIDEO") {
    actionHref = ROUTES.aiVideo;
    actionLabel = "Open Video Studio";
  } else if (job.type === "VIDEO_CLIP" && primaryAsset) {
    actionHref = `/api/generations/clip/${job.id}/clips/${primaryAsset.id}/download`;
    actionLabel = "Download Clip";
    isDownload = true;
  }

  return (
    <article
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-surface/80 backdrop-blur-sm transition-all duration-300",
        "hover:border-white/20 hover:shadow-lg hover:shadow-violet/5",
      )}
    >
      {/* Media Preview Area */}
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-900/80 sm:aspect-[4/3]">
        {isCompleted && primaryAsset && job.type === "IMAGE" ? (
          <img
            src={`/api/assets/${primaryAsset.id}`}
            alt={job.prompt ?? "AI generated image"}
            loading="lazy"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : isCompleted && job.type === "VIDEO" ? (
          <div className="relative flex size-full flex-col items-center justify-center bg-gradient-to-br from-violet/20 via-zinc-900 to-fuchsia/10">
            <span className="grid size-12 place-items-center rounded-2xl bg-white/10 text-violet-200 ring-1 ring-white/15 backdrop-blur-md transition-transform duration-300 group-hover:scale-110">
              <Video className="size-6" aria-hidden />
            </span>
            <span className="mt-2 text-xs font-medium text-muted">720p 16 FPS Video</span>
          </div>
        ) : isCompleted && job.type === "VIDEO_CLIP" ? (
          <div className="relative flex size-full flex-col items-center justify-center bg-gradient-to-br from-cyan/20 via-zinc-900 to-violet/10">
            <span className="grid size-12 place-items-center rounded-2xl bg-white/10 text-cyan-200 ring-1 ring-white/15 backdrop-blur-md transition-transform duration-300 group-hover:scale-110">
              <Scissors className="size-6" aria-hidden />
            </span>
            <span className="mt-2 text-xs font-medium text-muted">
              {job.assets.length} Smart Clip{job.assets.length > 1 ? "s" : ""}
            </span>
          </div>
        ) : isPending ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 bg-zinc-900/60 p-4 text-center">
            <Loader2 className="size-7 animate-spin text-violet-400" aria-hidden />
            <p className="text-xs font-medium text-muted">
              {job.status === "PROCESSING" ? "Rendering in progress..." : "Queued in studio..."}
            </p>
          </div>
        ) : isFailed ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 bg-red-950/20 p-4 text-center">
            <AlertCircle className="size-6 text-red-400" aria-hidden />
            <p className="line-clamp-2 text-xs text-red-300/90">
              {job.errorMessage || "Generation failed"}
            </p>
          </div>
        ) : (
          <div className="flex size-full items-center justify-center bg-zinc-900/40 text-muted">
            <Icon className="size-8 opacity-40" aria-hidden />
          </div>
        )}

        {/* Media Overlay Badges (Resolution / Duration / Size) */}
        {primaryAsset && isCompleted && (
          <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-1 text-[10px] font-medium text-white drop-shadow-md">
            <div className="flex items-center gap-1">
              {primaryAsset.width && primaryAsset.height && (
                <span className="rounded bg-black/60 px-1.5 py-0.5 backdrop-blur-md">
                  {primaryAsset.width}×{primaryAsset.height}
                </span>
              )}
              {primaryAsset.durationSeconds !== null && primaryAsset.durationSeconds > 0 && (
                <span className="rounded bg-black/60 px-1.5 py-0.5 backdrop-blur-md">
                  {primaryAsset.durationSeconds.toFixed(1)}s
                </span>
              )}
            </div>

            {primaryAsset.fileSize !== null && (
              <span className="rounded bg-black/60 px-1.5 py-0.5 backdrop-blur-md">
                {formatFileSize(primaryAsset.fileSize)}
              </span>
            )}
          </div>
        )}

        {/* Type Icon Badge on Top-Left */}
        <span
          className={cn(
            "absolute top-2 left-2 grid size-7 place-items-center rounded-lg shadow-sm backdrop-blur-md",
            meta.iconClass,
          )}
          title={meta.label}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
      </div>

      {/* Card Body */}
      <div className="flex flex-1 flex-col justify-between p-3.5 sm:p-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted">{meta.label}</span>
            <StatusBadge status={job.status} />
          </div>

          <p
            className="mt-2 line-clamp-2 text-xs text-foreground/90 sm:text-sm"
            title={job.prompt ?? undefined}
          >
            {job.prompt?.trim() || <span className="italic text-muted">No prompt provided</span>}
          </p>
        </div>

        {/* Footer Meta & Action */}
        <div className="mt-3.5 border-t border-white/[0.06] pt-3">
          <div className="flex items-center justify-between text-xs text-muted">
            <time dateTime={job.createdAt.toISOString()} title={formatDateTime(job.createdAt)}>
              {formatRelative(job.createdAt)}
            </time>
            <span className="tabular-nums">
              {credits > 0 ? (
                <span>
                  {formatNumber(credits)} cr{!charged && <span className="text-muted/70"> est.</span>}
                </span>
              ) : (
                "—"
              )}
            </span>
          </div>

          {actionHref && (
            <div className="mt-2.5">
              <Link
                href={actionHref}
                target={isDownload || job.type === "IMAGE" ? "_blank" : undefined}
                rel={isDownload || job.type === "IMAGE" ? "noopener noreferrer" : undefined}
                className={cn(
                  "inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors",
                  "bg-white/[0.06] text-foreground hover:bg-white/[0.1] hover:text-white ring-1 ring-white/10",
                )}
              >
                {isDownload ? (
                  <Download className="size-3" aria-hidden />
                ) : (
                  <ExternalLink className="size-3" aria-hidden />
                )}
                <span>{actionLabel}</span>
              </Link>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
