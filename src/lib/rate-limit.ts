/**
 * Process-local best-effort in-memory sliding window rate limiter.
 *
 * ARCHITECTURAL CONTEXT & LIMITATIONS:
 * 1. Process-local: Enforces limits in the local Node.js process memory.
 * 2. Does NOT persist across server restarts or container redeployments.
 * 3. Does NOT synchronize across multiple horizontal container replicas or serverless instances.
 * 4. This is a best-effort burst throttle against casual spam and automated scripting.
 * 5. PostgreSQL remains the SOLE authoritative enforcement boundary for generation quotas (10 jobs/day),
 *    concurrency (1 active job), and credit wallet balances.
 * 6. Memory is strictly bounded (maxEntries) with periodic cleanup to prevent memory leaks.
 */

export type RateLimitConfig = {
  /** Maximum number of allowed hits within the window. */
  max: number;
  /** Window duration in milliseconds. */
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

type Entry = {
  timestamps: number[];
  lastSeen: number;
};

export class InMemoryRateLimiter {
  private readonly store = new Map<string, Entry>();
  private readonly maxEntries: number;
  private lastCleanup = Date.now();
  private readonly cleanupIntervalMs: number;

  constructor(options: { maxEntries?: number; cleanupIntervalMs?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
  }

  /**
   * Check and record a hit for the given key.
   * Runs in O(hits in window) time and cleans expired state.
   */
  check(key: string, config: RateLimitConfig, now = Date.now()): RateLimitResult {
    this.maybeCleanup(now);

    const windowStart = now - config.windowMs;
    let entry = this.store.get(key);

    if (!entry) {
      if (this.store.size >= this.maxEntries) {
        // Enforce hard memory bound: evict oldest entry
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) this.store.delete(oldestKey);
      }
      entry = { timestamps: [], lastSeen: now };
      this.store.set(key, entry);
    }

    entry.lastSeen = now;
    // Filter out timestamps outside the sliding window
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    if (entry.timestamps.length >= config.max) {
      const oldestInWindow = entry.timestamps[0];
      const resetAt = oldestInWindow + config.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
      };
    }

    entry.timestamps.push(now);
    const remaining = Math.max(0, config.max - entry.timestamps.length);
    const oldestInWindow = entry.timestamps[0];
    const resetAt = oldestInWindow + config.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));

    return {
      allowed: true,
      remaining,
      resetAt,
      retryAfterSeconds,
    };
  }

  /**
   * Read-only check: would the NEXT hit for `key` be refused? Records nothing, so it can gate an
   * expensive operation (e.g. a bcrypt comparison) where only failures should be counted.
   */
  peek(key: string, config: RateLimitConfig, now = Date.now()): RateLimitResult {
    const windowStart = now - config.windowMs;
    const hits = (this.store.get(key)?.timestamps ?? []).filter((ts) => ts > windowStart);
    const resetAt = hits.length ? hits[0] + config.windowMs : now;
    return {
      allowed: hits.length < config.max,
      remaining: Math.max(0, config.max - hits.length),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  /** Reset a specific key (e.g. after successful authentication or in tests). */
  reset(key: string) {
    this.store.delete(key);
  }

  /** Total tracked keys (for metrics and test assertions). */
  get size(): number {
    return this.store.size;
  }

  /** Clears all entries. */
  clear() {
    this.store.clear();
  }

  private maybeCleanup(now: number) {
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;

    for (const [key, entry] of this.store.entries()) {
      // Remove entries that haven't been seen in the largest typical window (15 minutes)
      // or whose timestamps are all expired
      if (now - entry.lastSeen > 15 * 60 * 1000) {
        this.store.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Standard Configuration Presets
// ---------------------------------------------------------------------------

export const RATE_LIMITS = {
  /** Registration: 5 attempts per 15 minutes per IP. */
  REGISTER_IP: { max: 5, windowMs: 15 * 60 * 1000 },
  /** Login IP: 10 attempts per 15 minutes per IP. */
  LOGIN_IP: { max: 10, windowMs: 15 * 60 * 1000 },
  /** Login Account: 5 failed/consecutive attempts per 15 minutes per normalized email. */
  LOGIN_ACCOUNT: { max: 5, windowMs: 15 * 60 * 1000 },
  /** Generation Burst: 10 requests per minute per IP (Postgres enforces daily 10/day). */
  GENERATION_BURST: { max: 10, windowMs: 60 * 1000 },
  /** Image generation burst per authenticated user (not spoofable; Postgres still enforces the daily quota). */
  GENERATION_USER: { max: 10, windowMs: 60 * 1000 },
  /**
   * Failure COUNTER window per normalized email (not a hard limit): authorize() turns the count into
   * progressive per-account spacing (src/features/auth/authorize.ts). `max` only bounds memory.
   */
  LOGIN_ACCOUNT_FAILURES: { max: 1000, windowMs: 15 * 60 * 1000 },
  /** Site-wide cap on SUCCESSFUL registrations (applies even when no client IP can be trusted). */
  REGISTER_GLOBAL: { max: 100, windowMs: 60 * 60 * 1000 },
  /** Abuse reports: signed-in reporter. */
  REPORT_USER: { max: 10, windowMs: 60 * 60 * 1000 },
  /** Anonymous abuse reports per trusted client IP (only when a trusted IP exists). */
  REPORT_ANON_IP: { max: 10, windowMs: 60 * 60 * 1000 },
  /** Anonymous abuse reports per reported target (duplicates of an already-queued report add nothing). */
  REPORT_ANON_TARGET: { max: 3, windowMs: 60 * 60 * 1000 },
  /** Site-wide anonymous report circuit breaker (bounds database spam). */
  REPORT_ANON_GLOBAL: { max: 60, windowMs: 60 * 60 * 1000 },
} as const;

/** Shared process-local rate limiter instance. */
export const defaultRateLimiter = new InMemoryRateLimiter();

/**
 * Separate instance for authentication counters, so key floods on other endpoints (each limiter
 * evicts its oldest key at maxEntries) can never flush sign-in failure counters.
 */
export const authRateLimiter = new InMemoryRateLimiter();

// ---------------------------------------------------------------------------
// Client IP Extraction & Trust Boundary
// ---------------------------------------------------------------------------

export type ClientIpTrustModel = "cloudflare" | "none";

export type ExtractClientIpOptions = {
  /**
   * Explicit trust model override.
   * Defaults to "cloudflare" if process.env.TRUST_PROXY === "cloudflare", otherwise "none".
   */
  trustModel?: ClientIpTrustModel;
};

const IPV4_OR_IPV6 = /^(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-fA-F:]+)$/;

/**
 * Safe client IP extraction strategy.
 *
 * THREAT MODEL & TRUST BOUNDARIES:
 * 1. Untrusted Client Headers:
 *    Forwarding and proxy headers (such as CF-Connecting-IP, CF-Ray, X-Forwarded-For, and X-Real-IP)
 *    can be trivially fabricated by any direct HTTP client when the origin server is directly
 *    reachable over the network.
 *
 * 2. CF-Ray Is NOT Cryptographic Authentication:
 *    CF-Ray is a non-cryptographic diagnostic request identifier assigned by Cloudflare. A direct
 *    client sending requests directly to the origin can forge both "CF-Connecting-IP" and "CF-Ray".
 *    Header presence alone DOES NOT prove that a request passed through Cloudflare.
 *
 * 3. Network Ingress Prerequisite for Cloudflare Trust:
 *    Trusting CF-Connecting-IP is safe ONLY when the deployment infrastructure enforces a strict
 *    network boundary preventing direct client access to the origin server (e.g. Cloudflare Tunnel,
 *    Authenticated Origin Pulls / mTLS, or strict firewall ingress allowing only Cloudflare IP ranges).
 *    If direct access to the origin server is possible, TRUST_PROXY=cloudflare MUST remain disabled.
 *
 * 4. Default Safe Fallback ("none"):
 *    By default (trustModel === "none"), or when the trusted proxy deployment guarantee is not
 *    established, all client-supplied forwarding headers are ignored, and a constant fallback IP
 *    ("127.0.0.1") is returned.
 *    - LIMITATION: All clients sharing the fallback IP share the process-local IP burst throttle
 *      (5 registrations/15m, 10 logins/15m, 10 generations/min).
 *    - MITIGATION:
 *      a) Login has dedicated account-level rate limiting (LOGIN_ACCOUNT: 5 attempts/15m per normalized email),
 *         which is unaffected by shared IP fallbacks.
 *      b) PostgreSQL remains the authoritative, tamper-proof enforcement layer for generation daily allowances
 *         (10 jobs/day), concurrency (1 active job), and credit wallet balances.
 */
export function extractClientIp(
  headers: Headers | Record<string, string | string[] | undefined>,
  options: ExtractClientIpOptions = {},
): string {
  const trustModel: ClientIpTrustModel =
    options.trustModel ?? (process.env.TRUST_PROXY === "cloudflare" ? "cloudflare" : "none");

  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const val = headers[name.toLowerCase()] ?? headers[name];
    if (Array.isArray(val)) return val[0] ?? null;
    return typeof val === "string" ? val : null;
  };

  // Cloudflare mode is honored ONLY under the explicit operator trust assertion
  // that network ingress guarantees the origin cannot be reached directly.
  if (trustModel === "cloudflare") {
    const cfIp = getHeader("cf-connecting-ip")?.trim();
    const cfRay = getHeader("cf-ray")?.trim();

    // Under trusted Cloudflare ingress, CF-Connecting-IP is the client IP.
    // Both CF-Connecting-IP and CF-Ray must be present and CF-Connecting-IP
    // must be a valid single IPv4 or IPv6 address.
    if (cfIp && cfRay && IPV4_OR_IPV6.test(cfIp)) {
      return cfIp;
    }
  }

  // Under default trustModel "none", or if Cloudflare proxy context is missing/invalid,
  // do NOT trust X-Forwarded-For, X-Real-IP, or untrusted CF-Connecting-IP.
  // Fall back to the safe constant default.
  return "127.0.0.1";
}

/**
 * The client IP ONLY when it comes from the explicitly trusted proxy model; otherwise null.
 *
 * Prefer this over extractClientIp() for rate-limit keys: the constant "127.0.0.1" fallback turns a
 * per-IP limit into ONE site-wide bucket that any single client can exhaust for everyone (e.g. 10
 * sign-ins per 15 minutes for the whole site). Callers skip per-IP limits when this returns null and
 * rely on per-account / per-user / per-target limits instead.
 *
 * Render: requests reach the service through Cloudflare. Render appends to (does not reset) a
 * client-supplied X-Forwarded-For, so XFF is never trusted. CF-Connecting-IP is only honored under
 * TRUST_PROXY=cloudflare, which must not be set until the boundary is validated (see
 * docs/runbooks/client-ip-trust.md).
 */
export function trustedClientIp(
  headers: Headers | Record<string, string | string[] | undefined>,
  options: ExtractClientIpOptions = {},
): string | null {
  const trustModel: ClientIpTrustModel =
    options.trustModel ?? (process.env.TRUST_PROXY === "cloudflare" ? "cloudflare" : "none");
  if (trustModel !== "cloudflare") return null;
  const ip = extractClientIp(headers, { trustModel });
  return ip === "127.0.0.1" ? null : ip;
}
