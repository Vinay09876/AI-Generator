import type { VideoApiResult } from "./types";
import { VIDEO_POLL_INTERVAL_MS } from "../config";

export const VIDEO_POLLING = {
  /** 4-second initial polling interval */
  defaultIntervalMs: VIDEO_POLL_INTERVAL_MS, // 4,000 ms
  minIntervalMs: 2_000,
  maxIntervalMs: 30_000,
  /** Network / server error backoff steps: 4s, 8s, 16s, 30s */
  backoffMs: [4_000, 8_000, 16_000, 30_000] as readonly number[],
  /** Give up after 15 minutes (matches VIDEO_PROCESSING_STALE_MS) */
  maxDurationMs: 15 * 60_000,
} as const;

export type PollStopReason =
  | "terminal"
  | "not-found"
  | "unauthenticated"
  | "timeout"
  | "fatal"
  | "aborted";

export type PollDecision =
  | { action: "stop"; reason: PollStopReason }
  | { action: "wait"; delayMs: number }
  | { action: "pause" };

export function isTerminalJobStatus(status: string): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

/**
 * Calculates poll delay with bounded exponential backoff and ±15% random jitter
 * to avoid thundering herd on backend APIs.
 */
export function calculatePollDelay(
  consecutiveFailures: number,
  retryAfterSeconds?: number | null,
  withJitter = true,
): number {
  let baseDelay: number;

  if (typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
    baseDelay = retryAfterSeconds * 1000;
  } else if (consecutiveFailures > 0) {
    const steps = VIDEO_POLLING.backoffMs;
    const idx = Math.min(Math.max(consecutiveFailures, 1), steps.length) - 1;
    baseDelay = steps[idx];
  } else {
    baseDelay = VIDEO_POLLING.defaultIntervalMs;
  }

  const clamped = Math.min(
    Math.max(baseDelay, VIDEO_POLLING.minIntervalMs),
    VIDEO_POLLING.maxIntervalMs,
  );

  if (!withJitter) return clamped;

  // Add ±15% jitter: factor between 0.85 and 1.15
  const jitterFactor = 0.85 + Math.random() * 0.3;
  return Math.round(clamped * jitterFactor);
}

/**
 * Pure decision engine: determines next action after receiving a poll result.
 */
export function decideNextVideoPoll(input: {
  result: VideoApiResult;
  pollStartedAt: number;
  now: number;
  consecutiveFailures: number;
  hidden?: boolean;
  offline?: boolean;
}): PollDecision {
  const { result } = input;

  if (result.kind === "aborted") {
    return { action: "stop", reason: "aborted" };
  }

  // Job reached terminal state
  if (result.kind === "job" && isTerminalJobStatus(result.body?.job.status ?? "")) {
    return { action: "stop", reason: "terminal" };
  }

  // Contract or HTTP errors
  if (result.kind === "error") {
    const status = result.httpStatus;
    if (status === 404 || result.error?.code === "NOT_FOUND") {
      return { action: "stop", reason: "not-found" };
    }
    if (status === 401 || result.error?.code === "UNAUTHENTICATED") {
      return { action: "stop", reason: "unauthenticated" };
    }
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return { action: "stop", reason: "fatal" };
    }
  }

  // Max duration timeout
  if (input.now - input.pollStartedAt >= VIDEO_POLLING.maxDurationMs) {
    return { action: "stop", reason: "timeout" };
  }

  // Tab hidden or offline: pause scheduling
  if (input.hidden || input.offline) {
    return { action: "pause" };
  }

  // Schedule next poll
  const delayMs = calculatePollDelay(
    input.consecutiveFailures,
    result.retryAfterSeconds,
  );

  return { action: "wait", delayMs };
}

