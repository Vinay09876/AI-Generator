"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

/** Error boundary for dashboard pages. Shows no internal error details to the user. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[dashboard] render failed", error.digest ?? "");
  }, [error]);

  return (
    <div role="alert" className="flex flex-col items-center rounded-3xl border border-white/[0.08] bg-surface px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-2xl border border-rose-400/20 bg-rose-500/10 text-rose-200">
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <h1 className="mt-4 font-display text-xl font-semibold">Something went wrong</h1>
      <p className="mt-1 max-w-sm text-sm text-muted">
        We couldn&apos;t load this page. Please try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex h-10 items-center gap-2 rounded-full bg-white px-5 text-sm font-medium text-zinc-950 transition-transform active:scale-[0.97]"
      >
        <RotateCw className="size-4" aria-hidden /> Try again
      </button>
    </div>
  );
}
