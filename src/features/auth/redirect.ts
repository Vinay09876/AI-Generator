import { AUTH_ROUTES, DEFAULT_LOGIN_REDIRECT } from "@/lib/constants";

/**
 * Only allow same-site relative paths as post-login destinations
 * (prevents open redirects such as `//evil.com` or `https://evil.com`).
 */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return DEFAULT_LOGIN_REDIRECT;
  }
  const pathname = value.split(/[?#]/)[0];
  if ((AUTH_ROUTES as readonly string[]).includes(pathname)) return DEFAULT_LOGIN_REDIRECT;
  return value;
}
