import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";

export function ClipperCostSummary({
  cost,
  balance,
  dailyUsed,
  dailyLimit,
}: {
  cost: number;
  balance: number;
  dailyUsed: number;
  dailyLimit: number;
}) {
  const short = balance < cost;
  return (
    <section aria-label="Cost" className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm">
      <dl className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <dt className="flex items-center gap-2 text-muted">
            <Coins className="size-4 text-violet-300" aria-hidden="true" />
            Cost
          </dt>
          <dd className="font-semibold text-foreground tabular-nums">{cost} credits</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted">Your balance</dt>
          <dd className={cn("tabular-nums", short ? "text-rose-300" : "text-foreground")}>{balance} credits</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted">Clipping jobs today</dt>
          <dd className="tabular-nums text-foreground">
            {Math.min(dailyUsed, dailyLimit)} / {dailyLimit}
          </dd>
        </div>
      </dl>
      <p className="mt-3 border-t border-white/[0.06] pt-3 text-xs text-muted">
        Credits are reserved when the job is created and refunded automatically if it fails or you cancel it before processing starts.
      </p>
    </section>
  );
}
