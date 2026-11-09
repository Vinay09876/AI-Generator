import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import type { JobListItem } from "@/features/generations/queries";
import { GENERATION_TYPE_META } from "@/features/generations/meta";
import { APP_ROUTES } from "@/lib/constants";
import { JobRow } from "../job-row";

export function RecentGenerations({ jobs }: { jobs: JobListItem[] }) {
  return (
    <section aria-labelledby="recent-heading" className="rounded-3xl border border-white/[0.08] bg-surface p-3 sm:p-4">
      <div className="flex items-center justify-between gap-4 px-3 pt-2 pb-3 sm:px-4">
        <h2 id="recent-heading" className="text-sm font-medium">
          Recent generations
        </h2>
        {jobs.length > 0 && (
          <Link
            href={APP_ROUTES.history}
            className="group inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
          >
            View all
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </Link>
        )}
      </div>

      {jobs.length === 0 ? <EmptyRecent /> : (
        <ul className="divide-y divide-white/[0.04]">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyRecent() {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-violet/20 to-cyan/10 text-violet-200">
        <Sparkles className="size-5" aria-hidden />
      </span>
      <p className="mt-4 font-medium">No generations yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted">
        Your images, videos and clips will appear here as soon as you create them.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {Object.values(GENERATION_TYPE_META).map((meta) => (
          <Link
            key={meta.href}
            href={meta.href}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-foreground/90 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
          >
            <meta.icon className="size-3.5" aria-hidden />
            {meta.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
