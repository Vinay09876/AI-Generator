import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Coins, FileText, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { auth } from "@/lib/auth";
import { ROUTES } from "@/lib/constants";
import { formatDate, formatNumber } from "@/lib/format";
import { getCreditUsage, getWalletSummary } from "@/features/credits/queries";
import { getProfile, getSignInMethods } from "@/features/users/queries";
import { Avatar } from "@/components/dashboard/user-summary";
import { LogoutButton } from "@/components/dashboard/logout-button";
import { PageHeader } from "@/components/dashboard/page-header";
import { RevealGroup, RevealItem } from "@/components/dashboard/reveal";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect(ROUTES.login);

  const [profile, methods, wallet, usage] = await Promise.all([
    getProfile(userId),
    getSignInMethods(userId),
    getWalletSummary(userId),
    getCreditUsage(userId),
  ]);
  // Missing account is handled by the layout (redirecting to /login here would loop).
  if (!profile) return null;

  return (
    <RevealGroup className="space-y-6">
      <RevealItem>
        <PageHeader title="Settings" description="Your account details. Profile editing is coming soon." />
      </RevealItem>

      <RevealItem>
        <Panel icon={UserRound} title="Profile">
          <div className="flex items-center gap-4">
            <Avatar user={profile} className="size-14 text-xl" />
            <div className="min-w-0">
              <p className="truncate text-lg font-medium">{profile.name || "No name set"}</p>
              <p className="truncate text-sm text-muted">{profile.email}</p>
            </div>
          </div>
          <dl className="mt-6 grid gap-4 border-t border-white/[0.06] pt-5 sm:grid-cols-3">
            <Field label="Name" value={profile.name || "—"} />
            <Field label="Email" value={profile.email} />
            <Field label="Member since" value={formatDate(profile.createdAt)} />
          </dl>
        </Panel>
      </RevealItem>

      <RevealItem>
        <Panel icon={Coins} title="Credits">
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Current balance" value={`${formatNumber(wallet.balance)} credits`} emphasis />
            <Field
              label="Used"
              value={`${formatNumber(usage.usedThisMonth)} this month`}
              sub={`${formatNumber(usage.usedAllTime)} all time`}
            />
            <Field
              label="Refunded"
              value={`${formatNumber(usage.refundedThisMonth)} this month`}
              sub={`${formatNumber(usage.refundedAllTime)} all time`}
            />
          </dl>
        </Panel>
      </RevealItem>

      <RevealItem>
        <Panel icon={ShieldCheck} title="Security & session">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Sign-in methods</dt>
              <dd className="mt-1.5 flex flex-wrap gap-2">
                {methods.password && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs">
                    <KeyRound className="size-3.5" aria-hidden /> Email &amp; password
                  </span>
                )}
                {methods.providers.map((p) => (
                  <span key={p} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs capitalize">
                    {p}
                  </span>
                ))}
                {!methods.password && methods.providers.length === 0 && <span className="text-sm text-muted">—</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Session</dt>
              <dd className="mt-1.5 text-sm text-foreground/90">Signed in on this device</dd>
            </div>
          </dl>
          <div className="mt-6 flex justify-end border-t border-white/[0.06] pt-5">
            <LogoutButton className="border border-white/10 px-4" />
          </div>
        </Panel>
      </RevealItem>

      <RevealItem>
        <Panel icon={FileText} title="Data, Privacy & Legal">
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Review our grounded policies governing data governance, platform usage, and credit accounting:
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href={ROUTES.terms}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-foreground/90 transition-colors hover:border-violet/40 hover:text-white"
              >
                Terms of Service
              </Link>
              <Link
                href={ROUTES.privacy}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-foreground/90 transition-colors hover:border-violet/40 hover:text-white"
              >
                Privacy Policy
              </Link>
              <Link
                href={ROUTES.acceptableUse}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-foreground/90 transition-colors hover:border-violet/40 hover:text-white"
              >
                Acceptable Use Policy
              </Link>
            </div>

            <div className="mt-4 space-y-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs leading-relaxed text-muted">
              <p>
                <strong>Asset Storage:</strong> Generated images are stored in a private Supabase Storage bucket in Tokyo (AWS ap-northeast-1). Access is restricted to 10-minute HMAC-signed URLs issued only after session ownership verification.
              </p>
              <p>
                <strong>Account Deletion:</strong> Self-service account deletion is currently unsupported in software. Active budget reservations and relational credit ledger constraints prevent automated cascading deletion. Official operator contact and manual deletion procedures will be published prior to public launch.
              </p>
            </div>
          </div>
        </Panel>
      </RevealItem>
    </RevealGroup>
  );
}

function Panel({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof UserRound;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-white/[0.08] bg-surface p-6" aria-label={title}>
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-violet-300" aria-hidden /> {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({ label, value, sub, emphasis }: { label: string; value: string; sub?: string; emphasis?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={emphasis ? "mt-1 font-display text-2xl font-semibold tabular-nums" : "mt-1 truncate text-sm"}>
        {value}
      </dd>
      {sub && <dd className="text-xs text-muted">{sub}</dd>}
    </div>
  );
}
