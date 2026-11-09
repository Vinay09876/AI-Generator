import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, Coins, ImageIcon, Scissors, Video } from "lucide-react";
import { auth } from "@/lib/auth";
import { ROUTES } from "@/lib/constants";
import { getWalletSummary } from "@/features/credits/queries";

export const metadata: Metadata = { title: "Dashboard" };

const TOOLS = [
  {
    href: ROUTES.aiImage,
    title: "AI Image Generator",
    description: "Turn prompts into polished visuals.",
    icon: ImageIcon,
    iconClass: "bg-violet/15 text-violet-300",
  },
  {
    href: ROUTES.aiVideo,
    title: "AI Video Generator",
    description: "Generate short videos from a prompt.",
    icon: Video,
    iconClass: "bg-fuchsia/15 text-fuchsia-300",
  },
  {
    href: ROUTES.videoClipper,
    title: "AI Video Clipper",
    description: "Turn long recordings into highlights.",
    icon: Scissors,
    iconClass: "bg-cyan/15 text-cyan-300",
  },
] as const;

const TRANSACTION_LABELS: Record<string, string> = {
  INITIAL_GRANT: "Welcome credits",
  PURCHASE: "Credit purchase",
  GENERATION_DEBIT: "Generation",
  REFUND: "Refund",
  ADMIN_ADJUSTMENT: "Adjustment",
};

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect(ROUTES.login);

  const { balance, recentTransactions } = await getWalletSummary(session.user.id);
  const firstName = session.user.name?.split(" ")[0];

  return (
    <div className="space-y-10">
      <section>
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          {firstName ? `Welcome, ${firstName}` : "Welcome"}
        </h1>
        <p className="mt-2 text-muted">Here is an overview of your YourAI workspace.</p>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="border-glow relative overflow-hidden rounded-3xl p-6 lg:col-span-1">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-16 -right-16 size-48 rounded-full bg-violet/20 blur-3xl"
          />
          <p className="flex items-center gap-2 text-sm text-muted">
            <Coins className="size-4 text-violet-300" /> Credit balance
          </p>
          <p className="mt-4 font-display text-5xl font-semibold tracking-tight tabular-nums">
            {balance.toLocaleString()}
          </p>
          <p className="mt-2 text-sm text-muted">Credits are shared across all tools.</p>
        </div>

        <div className="rounded-3xl border border-white/[0.08] bg-surface p-6 lg:col-span-2">
          <h2 className="text-sm font-medium">Recent credit activity</h2>
          {recentTransactions.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No credit activity yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-white/[0.06]">
              {recentTransactions.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate">{t.description || TRANSACTION_LABELS[t.type] || t.type}</p>
                    <p className="text-xs text-muted">{dateFormat.format(t.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <p className={t.amount >= 0 ? "font-medium text-emerald-300" : "font-medium text-rose-300"}>
                      {t.amount >= 0 ? "+" : ""}
                      {t.amount}
                    </p>
                    <p className="text-xs text-muted">Balance {t.balanceAfter}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold tracking-tight">Tools</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {TOOLS.map(({ href, title, description, icon: Icon, iconClass }) => (
            <Link
              key={href}
              href={href}
              className="group relative rounded-3xl border border-white/[0.08] bg-surface p-6 transition-[border-color,transform] duration-300 hover:-translate-y-1 hover:border-white/15"
            >
              <div className="flex items-start justify-between">
                <span
                  className={`grid size-10 place-items-center rounded-xl transition-transform duration-500 group-hover:-rotate-6 ${iconClass}`}
                >
                  <Icon className="size-5" />
                </span>
                <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-muted">
                  Coming soon
                </span>
              </div>
              <h3 className="mt-5 font-medium">{title}</h3>
              <p className="mt-1 text-sm text-muted">{description}</p>
              <ArrowUpRight className="absolute right-6 bottom-6 size-4 text-muted transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
