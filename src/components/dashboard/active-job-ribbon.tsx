"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, ArrowRight, X, ImageIcon, Video, Scissors } from "lucide-react";
import { ROUTES } from "@/lib/constants";
import type { ActiveStudioJobSummary } from "@/features/generations/queries";
import { cn } from "@/lib/utils";

const TOOL_CONFIG = {
  IMAGE: {
    label: "AI Image Generation",
    href: ROUTES.aiImage,
    icon: ImageIcon,
    badge: "FLUX.1 Schnell",
  },
  VIDEO: {
    label: "AI Video Generation",
    href: ROUTES.aiVideo,
    icon: Video,
    badge: "Wan 2.1 · 720p",
  },
  VIDEO_CLIP: {
    label: "Video Clipper",
    href: ROUTES.videoClipper,
    icon: Scissors,
    badge: "Smart Scene Detect",
  },
} as const;

export function ActiveJobRibbon({ job }: { job: ActiveStudioJobSummary | null }) {
  const [dismissed, setDismissed] = useState(false);

  if (!job || dismissed) return null;

  const config = TOOL_CONFIG[job.type] ?? TOOL_CONFIG.IMAGE;
  const Icon = config.icon;
  const isProcessing = job.status === "PROCESSING";

  return (
    <aside
      aria-label="Active studio generation job"
      className="relative mb-6 overflow-hidden rounded-2xl border border-violet/30 bg-gradient-to-r from-violet/15 via-fuchsia/10 to-cyan/10 p-3.5 shadow-lg backdrop-blur-md sm:p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet/20 text-violet-300 ring-1 ring-violet/40">
            <Icon className="size-4" aria-hidden />
            <span
              className={cn(
                "absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-zinc-950",
                isProcessing ? "bg-cyan-400 animate-ping" : "bg-amber-400 animate-pulse",
              )}
            />
            <span
              className={cn(
                "absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-zinc-950",
                isProcessing ? "bg-cyan-400" : "bg-amber-400",
              )}
            />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-sm text-foreground/95">{config.label}</span>
              <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-medium text-muted uppercase tracking-wider">
                {config.badge}
              </span>
              <span className="rounded-full bg-violet/20 px-2 py-0.5 text-[10px] font-semibold text-violet-200">
                {isProcessing ? "Rendering" : "Queued"}
              </span>
            </div>

            <p className="mt-0.5 truncate text-xs text-muted">
              {job.prompt ? (
                <span>&ldquo;{job.prompt}&rdquo;</span>
              ) : (
                <span>Processing media pipeline...</span>
              )}{" "}
              <span className="hidden sm:inline text-muted/70">· 1 active job concurrency limit enforced</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
          <Link
            href={config.href}
            className="group inline-flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-3 text-xs font-medium text-foreground ring-1 ring-white/15 transition-all hover:bg-white/15 hover:ring-white/25"
          >
            <Loader2 className="size-3 animate-spin text-violet-300" aria-hidden />
            <span>Open Studio</span>
            <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </Link>

          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss banner"
            className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </aside>
  );
}
