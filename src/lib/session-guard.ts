import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ROUTES } from "@/lib/constants";
import { hasSessionCookieName } from "@/lib/session-cookie";

/**
 * Use instead of redirect(ROUTES.login) when auth() returned no session on a protected page.
 *
 * A session can be rejected server-side (account suspended/deleted, see src/lib/auth.ts) while the
 * browser still holds a validly signed cookie. The proxy only checks the cookie and would send that
 * browser from /login straight back to the dashboard — a redirect loop. In that case the user is
 * sent to /session-ended, which is outside the proxy matcher and offers an explicit sign-out.
 */
export async function redirectSignedOut(): Promise<never> {
  const jar = await cookies();
  if (hasSessionCookieName(jar.getAll().map((c) => c.name))) redirect(ROUTES.sessionEnded);
  redirect(ROUTES.login);
}
