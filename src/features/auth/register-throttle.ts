import { authRateLimiter, RATE_LIMITS, type InMemoryRateLimiter, type RateLimitConfig } from "@/lib/rate-limit";

export type RegistrationThrottleResult<T> = { ok: true; value: T } | { ok: false; retryAfterSeconds: number };

/**
 * Registration budget that counts ONLY successfully created accounts.
 *
 * Buckets: per client IP (only when a trusted proxy supplies one) and a site-wide cap. All are
 * checked (peek) before `create` runs; they are recorded only after `create` resolves. Invalid
 * input never reaches this function (validated first by the caller), and a duplicate email or any
 * other creation error throws before anything is recorded, so junk requests cannot exhaust the
 * budget. Best effort: concurrent requests may overshoot a cap by the number in flight.
 */
export async function createAccountWithThrottle<T>(
  trustedIp: string | null,
  create: () => Promise<T>,
  limiter: Pick<InMemoryRateLimiter, "peek" | "check"> = authRateLimiter,
): Promise<RegistrationThrottleResult<T>> {
  const buckets: [string, RateLimitConfig][] = [
    ...(trustedIp ? [[`register:ip:${trustedIp}`, RATE_LIMITS.REGISTER_IP] as [string, RateLimitConfig]] : []),
    ["register:global", RATE_LIMITS.REGISTER_GLOBAL],
  ];
  const blocked = buckets.map(([key, cfg]) => limiter.peek(key, cfg)).find((r) => !r.allowed);
  if (blocked) return { ok: false, retryAfterSeconds: blocked.retryAfterSeconds };

  const value = await create();
  for (const [key, cfg] of buckets) limiter.check(key, cfg);
  return { ok: true, value };
}
