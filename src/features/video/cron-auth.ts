import { timingSafeEqual } from "node:crypto";

export interface VideoCronAuthEnv {
  CRON_SECRET?: string;
  NODE_ENV?: string;
}

/**
 * Authorization for GET /api/cron/video-webhooks.
 *
 * Production FAILS CLOSED: a request is accepted only when CRON_SECRET is configured
 * (non-blank) AND the request carries `Authorization: Bearer <CRON_SECRET>` (timing-safe compare).
 * Outside production the endpoint stays open, preserving the original local-development behavior.
 */
export function isVideoCronRequestAuthorized(request: Request, env: VideoCronAuthEnv): boolean {
  if (env.NODE_ENV !== "production") return true;
  const secret = env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
