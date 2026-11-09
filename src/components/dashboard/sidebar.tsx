import { Coins } from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { APP_ROUTES } from "@/lib/constants";
import { formatNumber } from "@/lib/format";
import { LogoutButton } from "./logout-button";
import { SidebarNav } from "./sidebar-nav";
import { UserSummary, type UserSummaryData } from "./user-summary";

/** Desktop sidebar (lg and up). Data comes from the server layout. */
export function Sidebar({ user, balance }: { user: UserSummaryData; balance: number }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[264px] shrink-0 flex-col border-r border-white/[0.06] bg-surface/40 px-4 py-5 backdrop-blur-xl lg:flex">
      <div className="px-2">
        <Logo />
      </div>

      <div className="mt-8 flex-1 overflow-y-auto">
        <SidebarNav layoutGroup="sidebar" />
      </div>

      <div className="space-y-3 border-t border-white/[0.06] pt-4">
        <Link
          href={APP_ROUTES.settings}
          className="group relative block overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-violet/15 via-transparent to-cyan/10 p-4 transition-colors hover:border-white/15"
        >
          <p className="flex items-center gap-2 text-xs text-muted">
            <Coins className="size-3.5 text-violet-300" /> Credit balance
          </p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-tight tabular-nums">
            {formatNumber(balance)}
          </p>
        </Link>
        <div className="flex items-center justify-between gap-2 rounded-2xl px-2 py-1">
          <UserSummary user={user} />
          <LogoutButton showLabel={false} className="shrink-0 px-2.5" />
        </div>
      </div>
    </aside>
  );
}
