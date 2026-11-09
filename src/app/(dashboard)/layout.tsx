import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ROUTES } from "@/lib/constants";
import { getWalletSummary } from "@/features/credits/queries";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { MotionProvider } from "@/components/ui/motion-provider";

/**
 * Authoritative guard for every (dashboard) route. proxy.ts redirects early,
 * but this server-side check still runs even if the proxy is bypassed or misconfigured.
 */
export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  if (!session?.user?.id) redirect(ROUTES.login);

  const { balance } = await getWalletSummary(session.user.id);

  return (
    <MotionProvider>
      <div className="relative isolate min-h-dvh">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28rem] bg-[radial-gradient(ellipse_60%_60%_at_50%_0%,rgb(139_92_246/0.14),transparent)]"
        />
        <DashboardHeader user={session.user} balance={balance} />
        <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">{children}</main>
      </div>
    </MotionProvider>
  );
}
