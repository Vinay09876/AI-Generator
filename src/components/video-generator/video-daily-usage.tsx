"use client";

import { Video } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface VideoDailyUsageProps {
  used: number;
  limit: number;
}

export function VideoDailyUsage({ used, limit }: VideoDailyUsageProps) {
  const clamped = Math.min(Math.max(used, 0), limit);
  const reached = clamped >= limit;
  const pct = limit > 0 ? (clamped / limit) * 100 : 0;

  return (
    <div className="w-full rounded-2xl border border-white/[0.08] bg-surface/80 px-4 py-3 backdrop-blur-md sm:w-64">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
          <Video className="size-3.5 text-violet-400" /> Daily Videos
        </span>
        <span className={cn("font-medium text-xs tabular-nums", reached ? "text-amber-300" : "text-foreground")}>
          {formatNumber(clamped)} of {formatNumber(limit)} used
        </span>
      </div>

      <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            reached ? "bg-amber-400/80" : "bg-gradient-to-r from-violet via-fuchsia to-cyan",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="mt-1.5 text-[11px] text-muted/70">
        {reached ? "Daily limit reached · resets 00:00 UTC" : "Resets daily at 00:00 UTC"}
      </p>
    </div>
  );
}

