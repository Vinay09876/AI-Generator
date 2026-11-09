import { Coins, RotateCcw, TrendingDown } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { CountUp } from "../count-up";

type CreditCardProps = {
  balance: number;
  usage: { usedThisMonth: number; usedAllTime: number; refundedThisMonth: number; refundedAllTime: number };
};

export function CreditCard({ balance, usage }: CreditCardProps) {
  return (
    <section
      aria-labelledby="credits-heading"
      className="border-glow relative flex h-full flex-col overflow-hidden rounded-3xl p-6"
    >
      <div aria-hidden className="pointer-events-none absolute -top-20 -right-20 size-56 rounded-full bg-violet/20 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 size-48 rounded-full bg-cyan/10 blur-3xl" />

      <h2 id="credits-heading" className="relative flex items-center gap-2 text-sm text-muted">
        <Coins className="size-4 text-violet-300" aria-hidden /> Credit balance
      </h2>
      <p className="relative mt-3 font-display text-5xl font-semibold tracking-tight sm:text-6xl">
        <CountUp value={balance} />
      </p>
      <p className="relative mt-1 text-sm text-muted">Shared across Image, Video and Clipper.</p>

      <dl className="relative mt-auto grid grid-cols-2 gap-3 pt-6">
        <div className="rounded-2xl border border-white/[0.06] bg-black/20 p-3.5">
          <dt className="flex items-center gap-1.5 text-xs text-muted">
            <TrendingDown className="size-3.5" aria-hidden /> Used this month
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(usage.usedThisMonth)}</dd>
          <dd className="text-[11px] text-muted">{formatNumber(usage.usedAllTime)} all time</dd>
        </div>
        <div className="rounded-2xl border border-white/[0.06] bg-black/20 p-3.5">
          <dt className="flex items-center gap-1.5 text-xs text-muted">
            <RotateCcw className="size-3.5" aria-hidden /> Refunded this month
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(usage.refundedThisMonth)}</dd>
          <dd className="text-[11px] text-muted">{formatNumber(usage.refundedAllTime)} all time</dd>
        </div>
      </dl>
    </section>
  );
}
