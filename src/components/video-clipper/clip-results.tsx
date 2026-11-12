"use client";

import type { ClipJobView } from "@/features/clipper/job-view";
import { ClipCard } from "./clip-card";

export function ClipResults({ job, onExpired, heading = "Your clips" }: { job: ClipJobView; onExpired: (jobId: string) => void; heading?: string }) {
  const portrait = job.aspectRatio === "9:16";
  return (
    <section aria-label={heading}>
      <div
        className={
          portrait ? "grid grid-cols-2 gap-3 sm:grid-cols-3" : job.aspectRatio === "1:1" ? "grid grid-cols-2 gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2"
        }
      >
        {job.clips.map((clip, i) => (
          <ClipCard key={clip.assetId} jobId={job.id} clip={clip} index={i} aspectRatio={job.aspectRatio} onExpired={() => onExpired(job.id)} />
        ))}
      </div>
    </section>
  );
}
