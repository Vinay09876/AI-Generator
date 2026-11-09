import Link from "next/link";
import { Coins } from "lucide-react";
import { APP_ROUTES } from "@/lib/constants";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export function CreditPill({ balance, className }: { balance: number; className?: string }) {
  return (
    <Link
      href={APP_ROUTES.settings}
      aria-label={`${formatNumber(balance)} credits available`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm transition-colors hover:border-white/20",
        className,
      )}
    >
      <Coins className="size-4 text-violet-300" />
      <span className="font-medium tabular-nums">{formatNumber(balance)}</span>
    </Link>
  );
}
