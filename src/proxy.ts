import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";
import { AUTH_ROUTES, DEFAULT_LOGIN_REDIRECT, PROTECTED_ROUTE_PREFIXES, ROUTES } from "@/lib/constants";

const { auth } = NextAuth(authConfig);

const matchesPrefix = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Optimistic route protection based on the session cookie.
 * The (dashboard) layout re-checks the session on the server as the authoritative guard.
 */
export const proxy = auth((req) => {
  const { pathname, search } = req.nextUrl;
  const isSignedIn = Boolean(req.auth?.user);

  if (!isSignedIn && PROTECTED_ROUTE_PREFIXES.some((p) => matchesPrefix(pathname, p))) {
    const loginUrl = new URL(ROUTES.login, req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (isSignedIn && (AUTH_ROUTES as readonly string[]).includes(pathname)) {
    return NextResponse.redirect(new URL(DEFAULT_LOGIN_REDIRECT, req.nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/ai-image/:path*",
    "/ai-video/:path*",
    "/video-clipper/:path*",
    "/history/:path*",
    "/settings/:path*",
    "/login",
    "/register",
  ],
};
