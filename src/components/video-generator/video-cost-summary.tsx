"use client";

import Link from "next/link";
import { AlertCircle, Clock, Coins, Info } from "lucide-react";
import { APP_ROUTES } from "@/lib/constants";
import { formatNumber } from "@/lib/format";

interface VideoCostSummaryProps {
  creditCost: number;
  balance: number;
  dailyUsed: number;
  dailyLimit: number;
  hasActiveJob: boolean;
}

export function VideoCostSummary({
  creditCost,
  balance,
  dailyUsed,
  dailyLimit,
  hasActiveJob,
}: VideoCostSummaryProps) {
  const hasInsufficientCredits = balance < creditCost;
  const isDailyLimitReached = dailyUsed >= dailyLimit;

  return (
    <div className="space-y-3">
      {/* Cost & Balance Pill */}
      <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-black/40 p-3.5 text-xs backdrop-blur-md">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-xl bg-violet/20 text-violet-300">
            <Coins className="size-4" />
          </div>
          <div>
            <p className="font-medium text-foreground">Generation Cost</p>
            <p className="text-muted/70">Charged only after inference starts</p>
          </div>
        </div>

        <div className="text-right">
          <p className="font-semibold text-sm text-foreground tabular-nums">
            {creditCost} Credits
          </p>
          <p className="text-[11px] text-muted tabular-nums">
            Balance: {formatNumber(balance)}
          </p>
        </div>
      </div>

      {/* Warning: Insufficient Credits */}
      {hasInsufficientCredits && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="font-medium text-amber-100">Insufficient Credits</p>
            <p className="text-amber-200/80 leading-relaxed">
              This generation requires {creditCost} credits, but you currently have{" "}
              {formatNumber(balance)}.
            </p>
            <Link
              href={APP_ROUTES.settings}
              className="inline-block pt-1 font-semibold text-amber-300 underline underline-offset-2 transition-colors hover:text-amber-100"
            >
              View your credits in Settings &rarr;
            </Link>
          </div>
        </div>
      )}

      {/* Warning: Daily Limit Reached */}
      {!hasInsufficientCredits && isDailyLimitReached && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200"
        >
          <Clock className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="font-medium text-amber-100">Daily Limit Reached</p>
            <p className="text-amber-200/80 leading-relaxed">
              You have used all {dailyLimit} promotional video generations for today.
              Your daily quota resets at 00:00 UTC.
            </p>
          </div>
        </div>
      )}

      {/* Info: In-progress job */}
      {hasActiveJob && (
        <div className="flex items-start gap-3 rounded-2xl border border-violet-500/30 bg-violet-500/10 p-3.5 text-xs text-violet-200">
          <Info className="mt-0.5 size-4 shrink-0 text-violet-400" />
          <p className="leading-relaxed">
            A video generation is currently synthesizing in the background. It will appear
            in the preview stage once complete.
          </p>
        </div>
      )}
    </div>
  );
}

