/** Skeleton shown while dashboard pages stream their database queries. */
export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Loading" className="space-y-6">
      <div className="space-y-3 pb-2">
        <div className="shimmer h-4 w-24 rounded-md bg-white/[0.05]" />
        <div className="shimmer h-9 w-72 max-w-full rounded-lg bg-white/[0.06]" />
        <div className="shimmer h-4 w-96 max-w-full rounded-md bg-white/[0.04]" />
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="shimmer h-64 rounded-3xl border border-white/[0.06] bg-white/[0.03] lg:col-span-2" />
        <div className="shimmer h-64 rounded-3xl border border-white/[0.06] bg-white/[0.03] lg:col-span-3" />
      </div>
      <div className="shimmer h-60 rounded-3xl border border-white/[0.06] bg-white/[0.03]" />
      <span className="sr-only">Loading your dashboard…</span>
    </div>
  );
}
