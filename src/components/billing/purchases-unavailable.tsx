import { Clock } from "lucide-react";

/** Shown instead of "Buy Credits" while credit purchases are disabled (see features/billing/availability). */
export function PurchasesUnavailableBadge() {
  return (
    <span
      role="note"
      title="Credit purchases are not available yet. Your existing credits are unaffected."
      className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-3 py-1 text-xs font-medium text-muted ring-1 ring-white/10"
    >
      <Clock className="size-3.5" aria-hidden />
      <span>Purchases coming soon</span>
    </span>
  );
}
