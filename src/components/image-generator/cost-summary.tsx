import { Coins } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const credits = (n: number) => `${formatNumber(n)} credit${n === 1 ? "" : "s"}`;

/** Cost of the selected quality and the balance left afterwards. */
export function CostSummary({ id, cost, balance }: { id?: string; cost: number; balance: number }) {
  const affordable = balance >= cost;
  return (
    <div id={id} className="rounded-2xl border border-white/[0.06] bg-black/20 px-4 py-3">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Cost</dt>
          <dd className="mt-0.5 flex items-center gap-1.5 font-medium tabular-nums">
            <Coins className="size-3.5 text-violet-300" aria-hidden />
            {credits(cost)}
          </dd>
        </div>
        <div className="text-right">
          <dt className="text-xs text-muted">Balance after</dt>
          <dd className={cn("mt-0.5 font-medium tabular-nums", !affordable && "text-rose-200")}>
            {affordable ? credits(balance - cost) : "—"}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted">
        You have {credits(balance)}. Failed generations are refunded automatically.
      </p>
    </div>
  );
}
