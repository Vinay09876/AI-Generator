"use client";

import { AlertTriangle, X } from "lucide-react";
import type { ApiErrorCode } from "@/features/generations/client/api";

/** Local wall-clock time of a UTC reset instant, e.g. "05:30". */
function localResetTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const TITLES: Partial<Record<ApiErrorCode, string>> = {
  INSUFFICIENT_CREDITS: "Not enough credits",
  DAILY_LIMIT_REACHED: "Daily limit reached",
  CAPACITY_EXHAUSTED: "Capacity used up for today",
  ACTIVE_JOB_EXISTS: "A generation is already running",
  UNAUTHENTICATED: "Session expired",
  SERVICE_UNAVAILABLE: "Temporarily unavailable",
  NOT_FOUND: "Generation not found",
};

/**
 * For limits with a reset time the UI states the time itself (local + UTC) instead of the server
 * sentence that already ends with "resets at 00:00 UTC", so the time is not repeated.
 */
const RESET_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  DAILY_LIMIT_REACHED: "You've used all of today's images.",
  CAPACITY_EXHAUSTED: "Today's generation capacity is used up.",
};

/** A request that was rejected before any job existed. The message comes from the server contract. */
export function GenerationAlert({
  code,
  message,
  resetAt,
  onDismiss,
}: {
  code: ApiErrorCode;
  message: string;
  resetAt: string | null;
  onDismiss: () => void;
}) {
  const reset = resetAt ? localResetTime(resetAt) : null;
  const text = reset && RESET_MESSAGES[code] ? RESET_MESSAGES[code] : message;
  return (
    <div role="alert" className="flex gap-3 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-4 py-3 text-sm text-rose-100">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-300" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{TITLES[code] ?? "Couldn't start the generation"}</p>
        <p className="mt-0.5 text-rose-100/80">
          {text}
          {reset && <> Resets at {reset} your time (00:00 UTC).</>}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className="-m-2 grid size-11 shrink-0 place-items-center rounded-full text-rose-200/70 transition-colors hover:bg-white/[0.06] hover:text-rose-100 focus-visible:outline-2 focus-visible:outline-violet"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
