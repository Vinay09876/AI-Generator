"use client";

import { CheckCircle2, Film, Gauge, ShieldCheck, Sparkles } from "lucide-react";

export function VideoSpecsBadge() {
  return (
    <div
      aria-label="Video Generation Specifications"
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.08] bg-black/40 px-3 py-2 text-xs backdrop-blur-md"
    >
      <div className="flex items-center gap-1.5 font-medium text-amber-300">
        <Sparkles className="size-3.5" />
        <span className="font-semibold tracking-wide">Wan 2.1</span>
      </div>

      <span className="h-3 w-px bg-white/10" aria-hidden="true" />

      <div className="flex items-center gap-1 text-muted" title="Output resolution: 720p HD">
        <Film className="size-3 text-cyan-400" />
        <span>720p HD</span>
      </div>

      <span className="h-3 w-px bg-white/10" aria-hidden="true" />

      <div className="flex items-center gap-1 text-muted" title="Native frame rate: 16 frames per second">
        <Gauge className="size-3 text-violet-400" />
        <span>16 FPS</span>
      </div>

      <span className="h-3 w-px bg-white/10" aria-hidden="true" />

      <div className="flex items-center gap-1 text-muted" title="Duration: 5 seconds (81 frames)">
        <CheckCircle2 className="size-3 text-emerald-400" />
        <span>5.0s</span>
      </div>

      <span className="h-3 w-px bg-white/10" aria-hidden="true" />

      <div className="flex items-center gap-1 text-muted" title="AI safety filters active">
        <ShieldCheck className="size-3 text-emerald-400" />
        <span>Safety Checked</span>
      </div>
    </div>
  );
}

