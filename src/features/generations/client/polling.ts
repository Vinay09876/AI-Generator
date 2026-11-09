import type { ImageJobView } from "../job-view";
import type { GenerationApiResult } from "./api";
import type { PendingRequest } from "./pending-request";

/*
 * Pure polling and recovery decisions. No timers, storage or network here: the React hook
 * (later batch) feeds in the latest result and the clock, then acts on the decision.
 */

export const POLLING = {
  /** Used when the server sends no valid Retry-After. */
  defaultIntervalMs: 3_000,
  minIntervalMs: 1_000,
  maxIntervalMs: 30_000,
  /** Network / server-error backoff: 3 s, 6 s, 12 s, then 30 s. */
  backoffMs: [3_000, 6_000, 12_000, 30_000] as readonly number[],
  /** Give up after this long (past the 5-minute reconciliation threshold plus margin). */
  maxDurationMs: 7 * 60_000,
} as const;

export const RECOVERY = {
  /** A request with no acknowledged job id is replayed (same key) only within this window. */
  replayWindowMs: 10 * 60_000,
  /** A request with a known job id is polled (never replayed) within this window. */
  pollWindowMs: 24 * 60 * 60_000,
} as const;

const TERMINAL = new Set<ImageJobView["status"]>(["COMPLETED", "FAILED", "CANCELLED"]);
export const isTerminalStatus = (status: ImageJobView["status"]) => TERMINAL.has(status);

/** Backoff delay for the n-th consecutive failure (1-based). */
export function backoffDelayMs(consecutiveFailures: number) {
  const steps = POLLING.backoffMs;
  const i = Math.min(Math.max(consecutiveFailures, 1), steps.length) - 1;
  return steps[i];
}

export type PollStopReason = "terminal" | "not-found" | "unauthenticated" | "timeout" | "fatal" | "aborted";

export type PollDecision =
  | { action: "stop"; reason: PollStopReason }
  | { action: "wait"; delayMs: number }
  /** Tab hidden: stop scheduling; the hook resumes (polls immediately) when visible again. */
  | { action: "pause" };

/**
 * Decide what to do after a poll result.
 * Order: terminal job → hard stops (404 / 401 / client errors) → 7-minute limit → hidden
 * tab → schedule (Retry-After for in-progress jobs, backoff for failures).
 * `consecutiveFailures` must already include the current result if it was a failure.
 */
export function decideNextPoll(input: {
  result: GenerationApiResult;
  pollStartedAt: number;
  now: number;
  consecutiveFailures: number;
  hidden: boolean;
}): PollDecision {
  const { result } = input;
  if (result.kind === "aborted") return { action: "stop", reason: "aborted" };
  if (result.kind === "job" && isTerminalStatus(result.body.job.status)) return { action: "stop", reason: "terminal" };
  if (result.kind === "error") {
    if (result.error.code === "NOT_FOUND" || result.httpStatus === 404) return { action: "stop", reason: "not-found" };
    if (result.error.code === "UNAUTHENTICATED" || result.httpStatus === 401) return { action: "stop", reason: "unauthenticated" };
    // Other client errors will not fix themselves by retrying.
    if (result.httpStatus >= 400 && result.httpStatus < 500 && result.httpStatus !== 408 && result.httpStatus !== 429) {
      return { action: "stop", reason: "fatal" };
    }
  }
  if (input.now - input.pollStartedAt >= POLLING.maxDurationMs) return { action: "stop", reason: "timeout" };
  if (input.hidden) return { action: "pause" };

  if (result.kind === "job") {
    const seconds = result.retryAfterSeconds;
    const delay = seconds === null ? POLLING.defaultIntervalMs : seconds * 1000;
    return { action: "wait", delayMs: Math.min(Math.max(delay, POLLING.minIntervalMs), POLLING.maxIntervalMs) };
  }
  // Network failure, 5xx, 408 or 429: back off.
  return { action: "wait", delayMs: backoffDelayMs(input.consecutiveFailures) };
}

/** Whether a result counts as a failure for backoff purposes. */
export const isPollFailure = (result: GenerationApiResult) => result.kind === "network" || result.kind === "error";

export type RecoveryDecision =
  /** Poll an existing job (no POST, nothing can be charged). */
  | { action: "poll"; jobId: string; source: "active-job" | "pending" }
  /** Re-send the stored request with its ORIGINAL idempotency key. */
  | { action: "replay"; request: PendingRequest }
  /** Remove the stored request; nothing to recover. */
  | { action: "discard"; reason: "expired" }
  | { action: "none" };

/**
 * Decide how to recover after a page load.
 *  1. The server reports an active job → poll it (works even if localStorage was cleared).
 *  2. A stored request with an acknowledged job id → poll that job (within 24 h).
 *  3. A stored request without a job id, < 10 minutes old → replay it with the SAME key
 *     (if the job exists the server returns it; it is never created twice).
 *  4. Anything older → discard.
 * Never creates a new idempotency key.
 */
export function decideRecovery(input: {
  activeJob: { id: string; status: ImageJobView["status"] } | null;
  pending: PendingRequest | null;
  now: number;
}): RecoveryDecision {
  const { activeJob, pending, now } = input;
  if (activeJob && !isTerminalStatus(activeJob.status)) return { action: "poll", jobId: activeJob.id, source: "active-job" };
  if (!pending) return { action: "none" };

  const age = now - pending.startedAt;
  if (pending.jobId) {
    return age < RECOVERY.pollWindowMs ? { action: "poll", jobId: pending.jobId, source: "pending" } : { action: "discard", reason: "expired" };
  }
  return age < RECOVERY.replayWindowMs ? { action: "replay", request: pending } : { action: "discard", reason: "expired" };
}

/**
 * Whether the stored request should be cleared once a tracked job reaches a terminal
 * state: when it is that job, or when it never learned its job id (it was this request).
 */
export function shouldClearPendingOnTerminal(pending: PendingRequest | null, terminalJobId: string) {
  return pending !== null && (pending.jobId === undefined || pending.jobId === terminalJobId);
}
