"use client";

import type { ClipJobView } from "@/features/clipper/job-view";
import { ClipResults } from "./clip-results";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function RecentClips({ jobs, onExpired }: { jobs: ClipJobView[]; onExpired: (jobId: string) => void }) {
  if (jobs.length === 0) return null;
  return (
    <section aria-labelledby="recent-clips-heading" className="space-y-5">
      <h2 id="recent-clips-heading" className="font-display text-xl font-semibold tracking-tight text-foreground">
        Recent clips
      </h2>
      {jobs.map((job) => (
        <div key={job.id} className="space-y-2">
          <p className="text-xs text-muted" suppressHydrationWarning>
            {dateFmt.format(new Date(job.createdAt))} · {job.aspectRatio ?? "—"} · {job.clips.length} clip{job.clips.length === 1 ? "" : "s"}
          </p>
          <ClipResults job={job} onExpired={onExpired} heading="Clips from an earlier job" />
        </div>
      ))}
    </section>
  );
}
