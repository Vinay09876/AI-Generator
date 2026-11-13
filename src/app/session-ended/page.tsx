import type { Metadata } from "next";
import { LogoutButton } from "@/components/dashboard/logout-button";

export const metadata: Metadata = { title: "Session ended", robots: { index: false } };

/**
 * Reached when the browser still holds a signed session cookie but the server rejected the session
 * (account suspended or deleted, or its status could not be verified). Signing out clears the cookie.
 */
export default function SessionEndedPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="font-display text-2xl font-semibold">Your session has ended</h1>
      <p className="max-w-sm text-muted">
        This account is no longer available or your session could not be verified. Please sign out, then log in
        again. If you think this is a mistake, contact support.
      </p>
      <LogoutButton className="border border-white/10" />
    </main>
  );
}
