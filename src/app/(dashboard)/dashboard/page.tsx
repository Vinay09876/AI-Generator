import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ROUTES } from "@/lib/constants";
import { firstName, formatDate } from "@/lib/format";
import { getCreditUsage, getWalletSummary } from "@/features/credits/queries";
import { getDailyActivity, getRecentJobs, getUsageStats } from "@/features/generations/queries";
import { getProfile } from "@/features/users/queries";
import { RevealGroup, RevealItem } from "@/components/dashboard/reveal";
import { CreditCard } from "@/components/dashboard/overview/credit-card";
import { UsageStats } from "@/components/dashboard/overview/usage-stats";
import { ActivityChart } from "@/components/dashboard/overview/activity-chart";
import { QuickActions } from "@/components/dashboard/overview/quick-actions";
import { RecentGenerations } from "@/components/dashboard/overview/recent-generations";

export const metadata: Metadata = { title: "Overview" };

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect(ROUTES.login);

  // Independent, user-scoped queries run in parallel.
  const [profile, wallet, usage, stats, activity, recentJobs] = await Promise.all([
    getProfile(userId),
    getWalletSummary(userId),
    getCreditUsage(userId),
    getUsageStats(userId),
    getDailyActivity(userId, 14),
    getRecentJobs(userId, 6),
  ]);

  const name = firstName(profile?.name);

  return (
    <RevealGroup className="space-y-6">
      <RevealItem>
        <header className="pb-2">
          <p className="text-sm text-muted">Overview</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {name ? (
              <>
                Welcome back, <span className="text-gradient">{name}</span>
              </>
            ) : (
              "Welcome back"
            )}
          </h1>
          <p className="mt-2 text-muted">
            {stats.total === 0
              ? "Your studio is ready. Pick a tool below to create your first piece."
              : "Here is what is happening in your studio."}
            {profile && (
              <span className="block text-muted/70 sm:inline">
                <span className="hidden sm:inline"> · </span>Member since {formatDate(profile.createdAt)}
              </span>
            )}
          </p>
        </header>
      </RevealItem>

      <div className="grid gap-4 lg:grid-cols-5">
        <RevealItem className="lg:col-span-2">
          <CreditCard balance={wallet.balance} usage={usage} />
        </RevealItem>
        <RevealItem className="lg:col-span-3">
          <UsageStats stats={stats} />
        </RevealItem>
      </div>

      <RevealItem>
        <ActivityChart data={activity} />
      </RevealItem>

      <RevealItem>
        <QuickActions counts={stats.byType} />
      </RevealItem>

      <RevealItem>
        <RecentGenerations jobs={recentJobs} />
      </RevealItem>
    </RevealGroup>
  );
}
