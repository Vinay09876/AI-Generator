import { CredentialsSignin } from "next-auth";
import { loginSchema } from "@/features/auth/schemas";
import { verifyPassword as defaultVerifyPassword } from "@/features/auth/password";
import { authRateLimiter, RATE_LIMITS, type InMemoryRateLimiter } from "@/lib/rate-limit";

/**
 * Thrown from Credentials authorize() when an account's sign-in queue is momentarily full (see
 * below). The `code` reaches the client (Auth.js puts it in the redirect URL), so it states only the
 * throttle, never whether the email exists or which credential was wrong.
 */
export class SignInRateLimited extends CredentialsSignin {
  code = "rate_limited";
}

export type CredentialUserRow = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  passwordHash: string | null;
  isDeleted: boolean;
  isSuspended: boolean;
};

// ---------------------------------------------------------------------------
// Per-account progressive delay (no hard lockout)
// ---------------------------------------------------------------------------
//
// Failed sign-ins are counted per normalized email over 15 minutes. The first LOGIN_FREE_FAILURES
// cost nothing. After that, password checks for the account are SPACED: each evaluation must start
// at least failureDelayMs(failures + pending attempts) after the previous one (1 s, 2 s, 4 s ...
// capped at 30 s; pending attempts count so simultaneous requests cannot reuse a stale count), and
// the request simply waits for its turn. A correct password is always evaluated when its turn comes
// and then clears the account's state; nothing ever refuses a correct password outright except a
// momentarily full queue (LOGIN_MAX_WAIT_MS), and that refusal is temporary.
//
// Why spacing instead of a lockout: without a trustworthy client IP the server cannot tell the owner
// from an attacker, so a hard lock let anyone block a known account with 5 requests per 15 minutes.
// Spacing keeps the per-account guess rate bounded while a legitimate user is only delayed.
//
// RESIDUAL RISK (documented in docs/runbooks/client-ip-trust.md):
//  - Guess rate per account is capped at 1 per 30 s (about 120/hour, ~2,900/day), higher than the
//    old hard lock (5 per 15 minutes). Weak or common passwords remain guessable over days.
//  - An attacker who keeps more than LOGIN_MAX_WAIT_MS of attempts queued for one account, around
//    the clock, still delays or temporarily refuses the owner; this needs continuous parallel
//    traffic instead of 5 requests per 15 minutes.
//  - State is process-local: it resets on restart/deploy and is not shared between instances.

export const LOGIN_FREE_FAILURES = 5;
export const LOGIN_DELAY_CAP_MS = 30_000;
export const LOGIN_MAX_WAIT_MS = 45_000;

export function failureDelayMs(failures: number): number {
  if (failures < LOGIN_FREE_FAILURES) return 0;
  return Math.min(1000 * 2 ** (failures - LOGIN_FREE_FAILURES), LOGIN_DELAY_CAP_MS);
}

type AccountQueue = {
  /** Start time of the most recently reserved evaluation slot. */
  lastSlot: number;
  /** Reserved attempts whose password check has not finished yet. */
  pending: number;
  /** Identity of this queue; a successful sign-in replaces it, which invalidates older tickets. */
  generation: number;
};

/** Handed to the caller by reserve(); must be passed to release() exactly once (in a finally). */
export type LoginReservation = { key: string; generation: number; waitMs: number };

/**
 * Per-account evaluation slots (process-local, bounded).
 *
 * Concurrency: Node runs reserve() synchronously, so simultaneous requests reserve one after
 * another. Because failures are only recorded AFTER a password check finishes, attempts that are
 * reserved but not yet finished (`pending`) are counted as provisional failures when computing the
 * spacing. A burst therefore escalates 0,0,0,0,0,1s,2s,4s,8s,16s... immediately instead of reusing a
 * stale failure count, and the LOGIN_MAX_WAIT_MS queue limit refuses the rest.
 */
export class LoginAttemptScheduler {
  private readonly queues = new Map<string, AccountQueue>();
  private nextGeneration = 1;
  constructor(private readonly maxEntries = 10_000) {}

  /** Reserve the next evaluation slot, or null if the account's queue is already too deep. */
  reserve(key: string, recordedFailures: number, now: number): LoginReservation | null {
    const queue = this.queues.get(key);
    const pending = queue?.pending ?? 0;
    const spacing = failureDelayMs(recordedFailures + pending);
    const slot = queue ? Math.max(now, queue.lastSlot + spacing) : now;
    const waitMs = slot - now;
    if (waitMs > LOGIN_MAX_WAIT_MS) return null;

    const next: AccountQueue = queue
      ? { lastSlot: slot, pending: pending + 1, generation: queue.generation }
      : { lastSlot: slot, pending: 1, generation: this.nextGeneration++ };
    if (!queue) this.makeRoom(now);
    this.queues.delete(key); // Map order = recency of use
    this.queues.set(key, next);
    return { key, generation: next.generation, waitMs };
  }

  /** Finish a reservation. Ignored if the queue was reset (successful sign-in) or evicted since. */
  release(reservation: LoginReservation) {
    const queue = this.queues.get(reservation.key);
    if (!queue || queue.generation !== reservation.generation) return;
    queue.pending = Math.max(0, queue.pending - 1);
  }

  /** Successful sign-in: drop the account's queue. Still-pending older tickets become no-ops. */
  clear(key: string) {
    this.queues.delete(key);
  }

  /** Pending attempts for an account (diagnostics/tests). */
  pendingFor(key: string): number {
    return this.queues.get(key)?.pending ?? 0;
  }

  get size(): number {
    return this.queues.size;
  }

  /** Keep at most maxEntries queues: drop idle stale ones first, then the least recently used. */
  private makeRoom(now: number) {
    if (this.queues.size < this.maxEntries) return;
    for (const [k, q] of this.queues) {
      if (q.pending === 0 && q.lastSlot < now - LOGIN_DELAY_CAP_MS) this.queues.delete(k);
    }
    while (this.queues.size >= this.maxEntries) {
      // Evicting a queue with pending attempts is safe: their release() calls become no-ops.
      this.queues.delete(this.queues.keys().next().value!);
    }
  }
}

const defaultScheduler = new LoginAttemptScheduler();
const sleepMs = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

export type AuthorizeDeps = {
  findUserByEmail: (email: string) => Promise<CredentialUserRow | null>;
  verifyPassword?: (password: string, hash: string | null | undefined) => Promise<boolean>;
  limiter?: Pick<InMemoryRateLimiter, "check" | "peek" | "reset">;
  scheduler?: LoginAttemptScheduler;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export const loginFailureKey = (normalizedEmail: string) => `login:account:${normalizedEmail}`;

/** Failed sign-ins for the account in the current 15-minute window. */
export function recentFailures(limiter: Pick<InMemoryRateLimiter, "peek">, key: string, now?: number): number {
  const window = RATE_LIMITS.LOGIN_ACCOUNT_FAILURES;
  return window.max - limiter.peek(key, window, now).remaining;
}

/**
 * Credentials sign-in check shared by EVERY path into Auth.js: the login server action and a direct
 * POST to /api/auth/callback/credentials both end here, so the per-account throttle cannot be
 * bypassed by skipping the form.
 */
export async function authorizeCredentials(credentials: unknown, deps: AuthorizeDeps) {
  const parsed = loginSchema.safeParse(credentials);
  if (!parsed.success) return null;

  const { email, password } = parsed.data; // loginSchema trims and lower-cases the email
  const limiter = deps.limiter ?? authRateLimiter;
  const scheduler = deps.scheduler ?? defaultScheduler;
  const now = deps.now ?? Date.now;
  const key = loginFailureKey(email);

  // Synchronous: no await between reading the state and reserving, so simultaneous requests are
  // serialized through the scheduler. Refused requests never run bcrypt and are not counted.
  const t0 = now();
  const reservation = scheduler.reserve(key, recentFailures(limiter, key, t0), t0);
  if (!reservation) throw new SignInRateLimited();

  try {
    await (deps.sleep ?? sleepMs)(reservation.waitMs);

    const user = await deps.findUserByEmail(email);
    // Always run a bcrypt comparison so timing does not reveal whether the email exists.
    const valid = await (deps.verifyPassword ?? defaultVerifyPassword)(password, user?.passwordHash);
    if (!user || user.isDeleted || user.isSuspended || !valid) {
      // Recorded before release() in the same synchronous turn, so there is no moment in which
      // this attempt counts as neither pending nor failed.
      limiter.check(key, RATE_LIMITS.LOGIN_ACCOUNT_FAILURES, now());
      return null;
    }

    limiter.reset(key);
    scheduler.clear(key);
    // Never return the password hash: this object becomes the session token payload.
    return { id: user.id, name: user.name, email: user.email, image: user.image };
  } finally {
    // Always runs (wrong password, success, database or bcrypt errors). After a successful sign-in
    // or an eviction the ticket's generation no longer matches, so this is a no-op.
    scheduler.release(reservation);
  }
}
