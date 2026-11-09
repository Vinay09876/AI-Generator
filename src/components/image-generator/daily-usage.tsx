import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "3 of 10 images today" with a slim bar. The text carries the meaning; the bar is decorative.
 * Counts follow the server's daily-limit rule (jobs whose provider ran or may have run).
 */
export function DailyUsage({ used, limit }: { used: number; limit: number }) {
  const clamped = Math.min(Math.max(used, 0), limit);
  const reached = clamped >= limit;
  const pct = limit > 0 ? (clamped / limit) * 100 : 0;

  return (
    <div className="w-full rounded-2xl border border-white/[0.08] bg-surface px-4 py-3 sm:w-64">
      <p className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted">Today</span>
        <span className={cn("font-medium tabular-nums", reached && "text-rose-200")}>
          {formatNumber(clamped)} of {formatNumber(limit)} images
        </span>
      </p>
      <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            reached ? "bg-rose-400/70" : "bg-gradient-to-r from-violet to-cyan",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {reached ? "Daily limit reached · resets at 00:00 UTC" : "Resets daily at 00:00 UTC"}
      </p>
    </div>
  );
}
