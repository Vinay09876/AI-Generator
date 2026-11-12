import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ROUTES } from "@/lib/constants";
import { getWalletSummary } from "@/features/credits/queries";
import { getProfile } from "@/features/users/queries";
import { getActiveStudioJob } from "@/features/generations/queries";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { Sidebar } from "@/components/dashboard/sidebar";
import { LogoutButton } from "@/components/dashboard/logout-button";
import { MotionProvider } from "@/components/ui/motion-provider";
import { ActiveJobRibbon } from "@/components/dashboard/active-job-ribbon";

/**
 * Authoritative guard for every (dashboard) route. proxy.ts redirects early,
 * but this server-side check still runs even if the proxy is bypassed or misconfigured.
 */
export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect(ROUTES.login);

  const [profile, { balance }, activeJob] = await Promise.all([
    getProfile(userId),
    getWalletSummary(userId),
    getActiveStudioJob(userId),
  ]);

  // Valid session cookie but the account no longer exists. Redirecting to /login would
  // loop (the proxy sends signed-in users back here), so offer an explicit sign-out.
  if (!profile) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="font-display text-2xl font-semibold">Your session has expired</h1>
        <p className="max-w-sm text-muted">This account could not be found. Please sign out and log in again.</p>
        <LogoutButton className="border border-white/10" />
      </main>
    );
  }

  const user = { name: profile.name, email: profile.email };

  return (
    <MotionProvider>
      <div className="relative isolate flex min-h-dvh">
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[32rem] bg-[radial-gradient(ellipse_55%_60%_at_60%_0%,rgb(139_92_246/0.13),transparent)]"
        />
        <Sidebar user={user} balance={balance} />
        <div className="min-w-0 flex-1">
          <MobileNav user={user} balance={balance} />
          <main id="main-content" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
            <ActiveJobRibbon job={activeJob} />
            {children}
          </main>
        </div>
      </div>
    </MotionProvider>
  );
}
