import { Coins, LogOut } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { logoutAction } from "@/features/auth/actions";
import { DashboardNav } from "./dashboard-nav";

type DashboardHeaderProps = {
  user: { name?: string | null; email?: string | null };
  balance: number;
};

export function DashboardHeader({ user, balance }: DashboardHeaderProps) {
  const displayName = user.name || user.email || "Account";
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-background/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Logo />

        <div className="flex items-center gap-2 sm:gap-3">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm"
            title="Credit balance"
          >
            <Coins className="size-4 text-violet-300" />
            <span className="font-medium tabular-nums">{balance.toLocaleString()}</span>
            <span className="hidden text-muted sm:inline">credits</span>
          </span>

          <div className="hidden items-center gap-2.5 md:flex">
            <span className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-violet to-fuchsia text-sm font-semibold text-white">
              {initial}
            </span>
            <div className="max-w-[180px] leading-tight">
              <p className="truncate text-sm font-medium">{user.name || "Your account"}</p>
              {user.email && <p className="truncate text-xs text-muted">{user.email}</p>}
            </div>
          </div>

          <form action={logoutAction}>
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm text-muted transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Log out</span>
            </button>
          </form>
        </div>
      </div>
      <DashboardNav />
    </header>
  );
}
