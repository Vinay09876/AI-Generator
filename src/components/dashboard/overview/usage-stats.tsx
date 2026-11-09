import { CheckCircle2, Layers, Loader2, XCircle } from "lucide-react";
import type { UsageStats as UsageStatsData } from "@/features/generations/queries";
import { GENERATION_TYPE_META } from "@/features/generations/meta";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export function UsageStats({ stats }: { stats: UsageStatsData }) {
  const success = stats.successRate === null ? "—" : `${Math.round(stats.successRate * 100)}%`;

  return (
    <section
      aria-labelledby="usage-heading"
      className="flex h-full flex-col rounded-3xl border border-white/[0.08] bg-surface p-6"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="usage-heading" className="text-sm font-medium">
          Usage
        </h2>
        <span className="text-xs text-muted">All time</span>
      </div>

      <div className="mt-4 flex items-end gap-3">
        <span className="grid size-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-violet-200">
          <Layers className="size-5" aria-hidden />
        </span>
        <div>
          <p className="font-display text-4xl font-semibold tracking-tight tabular-nums">
            {formatNumber(stats.total)}
          </p>
          <p className="text-xs text-muted">Total generations</p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-3 gap-2">
        {(Object.keys(GENERATION_TYPE_META) as (keyof typeof GENERATION_TYPE_META)[]).map((type) => {
          const meta = GENERATION_TYPE_META[type];
          const Icon = meta.icon;
          return (
            <div key={type} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
              <dt className="flex items-center gap-1.5 text-xs text-muted">
                <span className={cn("grid size-5 place-items-center rounded-md", meta.iconClass)}>
                  <Icon className="size-3" aria-hidden />
                </span>
                {meta.plural}
              </dt>
              <dd className="mt-1.5 text-lg font-semibold tabular-nums">{formatNumber(stats.byType[type])}</dd>
            </div>
          );
        })}
      </dl>

      <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-white/[0.06] pt-4 text-sm sm:grid-cols-4">
        <Stat icon={CheckCircle2} iconClass="text-emerald-300" label="Completed" value={formatNumber(stats.completed)} />
        <Stat icon={Loader2} iconClass="text-sky-300" label="In progress" value={formatNumber(stats.inProgress)} />
        <Stat icon={XCircle} iconClass="text-rose-300" label="Failed" value={formatNumber(stats.failed)} />
        <div>
          <dt className="text-xs text-muted">Success rate</dt>
          <dd className="font-medium tabular-nums" title={stats.successRate === null ? "No finished generations yet" : undefined}>
            {success}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Stat({
  icon: Icon,
  iconClass,
  label,
  value,
}: {
  icon: typeof CheckCircle2;
  iconClass: string;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-muted">
        <Icon className={cn("size-3.5", iconClass)} aria-hidden />
        {label}
      </dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
