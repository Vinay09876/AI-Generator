import type { JobListItem } from "@/features/generations/queries";
import { GENERATION_TYPE_META } from "@/features/generations/meta";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./status-badge";

/** One generation job. Used by the overview's recent list and the history page. */
export function JobRow({ job }: { job: JobListItem }) {
  const type = GENERATION_TYPE_META[job.type];
  const Icon = type.icon;
  const charged = job.chargedCredits > 0;
  const credits = charged ? job.chargedCredits : job.estimatedCredits;

  return (
    <li className="group flex items-center gap-4 rounded-2xl px-3 py-3 transition-colors hover:bg-white/[0.03] sm:px-4">
      <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", type.iconClass)}>
        <Icon className="size-[18px]" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground/95" title={job.prompt ?? undefined}>
          {job.prompt?.trim() || <span className="text-muted italic">No prompt</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span>{type.label}</span>
          <span aria-hidden>·</span>
          <time dateTime={job.createdAt.toISOString()} title={formatDateTime(job.createdAt)}>
            {formatRelative(job.createdAt)}
          </time>
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-4">
        <StatusBadge status={job.status} />
        <span className="text-xs text-muted tabular-nums sm:w-20 sm:text-right">
          {credits > 0 ? (
            <>
              {formatNumber(credits)} cr{!charged && <span className="text-muted/70"> est.</span>}
            </>
          ) : (
            "—"
          )}
        </span>
      </div>
    </li>
  );
}
