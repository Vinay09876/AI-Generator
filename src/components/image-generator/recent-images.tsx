"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ImageIcon, ImageOff } from "lucide-react";
import { isViewable, promptExcerpt, type GalleryItem } from "@/features/generations/client/gallery";
import { APP_ROUTES } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const HISTORY_IMAGES = `${APP_ROUTES.history}?type=image`;

/**
 * The user's most recent completed images (server-provided, owner-scoped). Selecting one shows
 * it in the main preview; nothing is generated and the live generation is untouched.
 */
export function RecentImages({
  items,
  selectedJobId,
  onSelect,
}: {
  items: GalleryItem[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
}) {
  const viewable = items.filter(isViewable);

  return (
    <section aria-labelledby="recent-images-heading" className="rounded-3xl border border-white/[0.08] bg-surface p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id="recent-images-heading" className="text-sm font-medium">
          Recent images
        </h2>
        <Link
          href={HISTORY_IMAGES}
          className="group inline-flex min-h-11 items-center gap-1 rounded-full px-2 text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-violet"
        >
          View all history
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
        </Link>
      </div>

      {viewable.length === 0 ? (
        <EmptyGallery />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {viewable.map((item) => (
            <li key={item.job.id} className="min-w-0">
              <Thumbnail item={item} selected={item.job.id === selectedJobId} onSelect={() => onSelect(item.job.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Thumbnail({
  item,
  selected,
  onSelect,
}: {
  item: { job: GalleryItem["job"]; asset: NonNullable<GalleryItem["asset"]> };
  selected: boolean;
  onSelect: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const { job, asset } = item;
  const excerpt = promptExcerpt(job.prompt);
  const quality = job.quality === "detailed" ? "Detailed" : "Fast";
  const created = new Date(job.createdAt);
  const date = Number.isNaN(created.getTime()) ? null : formatDate(created);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${selected ? "Viewing" : "View"} image: ${excerpt}`}
      className={cn(
        "group block w-full rounded-2xl border p-1.5 text-left transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
        selected ? "border-violet/60 bg-violet/10" : "border-white/[0.06] bg-black/20 hover:border-white/15 hover:bg-white/[0.03]",
      )}
    >
      <span className="relative block aspect-square overflow-hidden rounded-xl bg-white/[0.03]">
        {failed ? (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center text-[11px] text-muted">
            <ImageOff className="size-5" aria-hidden />
            Preview unavailable
          </span>
        ) : (
          // Same-origin asset route (ownership check → short-lived signed URL); never the storage URL.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={asset.url}
            alt=""
            width={asset.width ?? 1024}
            height={asset.height ?? 1024}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          />
        )}
        {selected && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-violet px-2 py-0.5 text-[11px] font-medium text-white shadow">
            <Check className="size-3" aria-hidden /> Viewing
          </span>
        )}
      </span>
      <span className="block px-1.5 pt-2 pb-1">
        <span className="line-clamp-2 text-xs leading-snug break-words text-foreground/90" title={job.prompt ?? undefined}>
          {excerpt}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted">
          <span>{quality}</span>
          {date && (
            <>
              <span aria-hidden>·</span>
              <time dateTime={job.createdAt}>{date}</time>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

function EmptyGallery() {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-violet/20 to-cyan/10 text-violet-200">
        <ImageIcon className="size-5" aria-hidden />
      </span>
      <p className="mt-4 font-medium">No images yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted">Your completed images will appear here so you can view, download or reuse their prompts.</p>
      <Link
        href={HISTORY_IMAGES}
        className="mt-5 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-4 text-sm transition-colors hover:border-white/20 hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-violet"
      >
        Open history
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}
