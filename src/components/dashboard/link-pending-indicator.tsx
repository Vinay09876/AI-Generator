"use client";

import { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline spinner for a nav <Link>, shown from the click until the destination route renders.
 *
 * Dashboard routes are dynamic: their loading.tsx skeleton appears instantly only once Next.js has
 * prefetched the route. On a slow server or network the click can land before that prefetch
 * finishes, and the browser would otherwise wait with no feedback. useLinkStatus covers that gap.
 * Must be rendered inside the <Link> it reports on.
 */
export function LinkPendingIndicator({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span role="status" className={cn("inline-flex", className)}>
      <Loader2 className="size-4 animate-spin text-violet-200 motion-reduce:animate-none" aria-hidden />
      <span className="sr-only">Loading…</span>
    </span>
  );
}
