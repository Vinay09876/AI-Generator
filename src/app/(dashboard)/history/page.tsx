import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, History as HistoryIcon } from "lucide-react";
import type { GenerationType } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { APP_ROUTES, ROUTES } from "@/lib/constants";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getJobsPage, getUsageStats } from "@/features/generations/queries";
import { GENERATION_TYPE_META, parseTypeFilter } from "@/features/generations/meta";
import { JobRow } from "@/components/dashboard/job-row";
import { PageHeader } from "@/components/dashboard/page-header";
import { RevealGroup, RevealItem } from "@/components/dashboard/reveal";

export const metadata: Metadata = { title: "History" };

// Job ids are cuids; anything else in the URL is ignored rather than sent to the database.
const CURSOR_PATTERN = /^[a-z0-9]{20,40}$/i;

function historyHref(params: { type?: GenerationType; cursor?: string }) {
  const search = new URLSearchParams();
  if (params.type) search.set("type", GENERATION_TYPE_META[params.type].filter);
  if (params.cursor) search.set("cursor", params.cursor);
  const qs = search.toString();
  return qs ? `${APP_ROUTES.history}?${qs}` : APP_ROUTES.history;
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string | string[]; cursor?: string | string[] }>;
}) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect(ROUTES.login);

  const params = await searchParams;
  const type = parseTypeFilter(Array.isArray(params.type) ? params.type[0] : params.type);
  const rawCursor = Array.isArray(params.cursor) ? params.cursor[0] : params.cursor;
  const cursor = rawCursor && CURSOR_PATTERN.test(rawCursor) ? rawCursor : undefined;

  const [stats, page] = await Promise.all([getUsageStats(userId), getJobsPage(userId, { type, cursor })]);

  const tabs: { label: string; type?: GenerationType; count: number }[] = [
    { label: "All", count: stats.total },
    ...(Object.keys(GENERATION_TYPE_META) as GenerationType[]).map((t) => ({
      label: GENERATION_TYPE_META[t].plural,
      type: t,
      count: stats.byType[t],
    })),
  ];

  return (
    <RevealGroup className="space-y-6">
      <RevealItem>
        <PageHeader title="History" description="Every image, video and clip you have generated, newest first." />
      </RevealItem>

      <RevealItem>
        <nav aria-label="Filter by type" className="-mx-1 overflow-x-auto px-1">
          <ul className="flex w-max gap-1 rounded-2xl border border-white/[0.08] bg-surface p-1">
            {tabs.map((tab) => {
              const active = tab.type === type;
              return (
                <li key={tab.label}>
                  <Link
                    href={historyHref({ type: tab.type })}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-xl px-3.5 text-sm transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-violet",
                      active
                        ? "bg-white/[0.08] text-foreground shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
                        : "text-muted hover:text-foreground",
                    )}
                  >
                    {tab.label}
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-[11px] tabular-nums",
                        active ? "bg-violet/25 text-violet-100" : "bg-white/[0.06] text-muted",
                      )}
                    >
                      {formatNumber(tab.count)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </RevealItem>

      <RevealItem>
        <section aria-label="Generations" className="rounded-3xl border border-white/[0.08] bg-surface p-3 sm:p-4">
          {page.items.length === 0 ? (
            <HistoryEmpty hasAny={stats.total > 0} filtered={Boolean(type)} paged={Boolean(cursor)} type={type} />
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {page.items.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          )}
        </section>
      </RevealItem>

      {(cursor || page.nextCursor) && (
        <RevealItem>
          <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
            {cursor ? (
              <Link
                href={historyHref({ type })}
                className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm text-muted ring-1 ring-white/10 transition-colors hover:bg-white/[0.05] hover:text-foreground"
              >
                <ArrowLeft className="size-4" aria-hidden /> Back to newest
              </Link>
            ) : (
              <span />
            )}
            {page.nextCursor && (
              <Link
                href={historyHref({ type, cursor: page.nextCursor })}
                className="group inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.06] px-4 text-sm text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.1]"
              >
                Older generations
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            )}
          </nav>
        </RevealItem>
      )}
    </RevealGroup>
  );
}

function HistoryEmpty({
  hasAny,
  filtered,
  paged,
  type,
}: {
  hasAny: boolean;
  filtered: boolean;
  paged: boolean;
  type?: GenerationType;
}) {
  const meta = type ? GENERATION_TYPE_META[type] : undefined;
  let title = "No generations yet";
  let body = "When you generate images, videos or clips, they will be listed here with their status and credit cost.";
  if (paged) {
    title = "No older generations";
    body = "You have reached the end of your history.";
  } else if (hasAny && filtered && meta) {
    title = `No ${meta.plural.toLowerCase()} yet`;
    body = `You haven't created any ${meta.plural.toLowerCase()}. Other types are under the "All" tab.`;
  }

  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-violet/20 to-cyan/10 text-violet-200">
        <HistoryIcon className="size-5" aria-hidden />
      </span>
      <p className="mt-4 font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>
      {!paged && (
        <Link
          href={meta?.href ?? ROUTES.dashboard}
          className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm transition-colors hover:border-white/20 hover:bg-white/[0.06]"
        >
          {meta ? `Open ${meta.label}` : "Go to overview"}
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      )}
    </div>
  );
}
