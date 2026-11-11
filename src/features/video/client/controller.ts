import {
  getVideoJob,
  postVideoGeneration,
  type ApiFetchOptions,
} from "./api";
import {
  decideNextVideoPoll,
  isTerminalJobStatus,
  VIDEO_POLLING,
} from "./polling";
import type {
  SubmitVideoInput,
  VideoClientError,
  VideoGenerationState,
} from "./types";
import type { VideoAspectRatio } from "../config";

export interface VideoControllerDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  isDocumentHidden?: () => boolean;
  isOnline?: () => boolean;
  onStateChange?: (state: VideoGenerationState) => void;
  onUnauthenticated?: () => void;
  onSettled?: () => void;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
};

/**
 * Pure client-side state machine and polling orchestrator for AI video generation.
 * Manages full lifecycle: idle -> submitting -> polling -> completed | failed.
 *
 * Guarantees:
 *  - 4-second initial polling interval with bounded jittered backoff.
 *  - Strictly terminates on COMPLETED or FAILED (no infinite loops).
 *  - Stopping polling only aborts the local fetch and stops the loop;
 *    it NEVER falsely claims or cancels the upstream provider generation.
 */
export class VideoGenerationController {
  private state: VideoGenerationState = { phase: "idle" };
  private listeners = new Set<(state: VideoGenerationState) => void>();
  private activeAbortController: AbortController | null = null;
  private isDestroyed = false;
  private pollingActive = false;

  constructor(private readonly deps: VideoControllerDeps = {}) {}

  public getState(): VideoGenerationState {
    return this.state;
  }

  public subscribe(listener: (state: VideoGenerationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(next: VideoGenerationState): void {
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err) {
        console.error("[VideoController] listener error", err);
      }
    }
    this.deps.onStateChange?.(next);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const sleepFn = this.deps.sleep ?? defaultSleep;
    return sleepFn(ms, signal);
  }

  private isHidden(): boolean {
    if (this.deps.isDocumentHidden) return this.deps.isDocumentHidden();
    if (typeof document !== "undefined") return document.hidden;
    return false;
  }

  private isOnline(): boolean {
    if (this.deps.isOnline) return this.deps.isOnline();
    if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
      return navigator.onLine;
    }
    return true;
  }

  /**
   * Submits a video generation request.
   * On HTTP 202, transitions to 'polling' and runs the status check loop.
   */
  public async submit(input: SubmitVideoInput): Promise<VideoGenerationState> {
    if (this.state.phase === "submitting" || this.state.phase === "polling") {
      return this.state;
    }

    this.stopPollingLoop();
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    const startedAt = this.now();
    const aspectRatio: VideoAspectRatio = input.aspectRatio ?? "16:9";

    this.setState({
      phase: "submitting",
      prompt: input.prompt,
      aspectRatio,
      startedAt,
    });

    const options: ApiFetchOptions = {
      signal,
      fetchImpl: this.deps.fetchImpl,
    };

    const result = await postVideoGeneration(input, options);

    if (signal.aborted || this.isDestroyed) {
      return this.state;
    }

    if (result.kind === "job" && result.body) {
      const { job, asset } = result.body;

      // If job is already COMPLETED (e.g. replayed request)
      if (job.status === "COMPLETED" && asset) {
        this.setState({
          phase: "completed",
          job,
          asset,
        });
        this.deps.onSettled?.();
        return this.state;
      }

      // If job is already FAILED
      if (job.status === "FAILED" || job.status === "CANCELLED") {
        this.setState({
          phase: "failed",
          job,
          error: {
            code: "UPSTREAM_REJECTED",
            message: job.error?.message ?? "Video generation failed.",
            retryAfterSeconds: null,
            resetAt: null,
            isTerminal: true,
          },
        });
        this.deps.onSettled?.();
        return this.state;
      }

      // In progress (HTTP 202 or 200 in-flight): begin polling
      this.startPollingLoop(job.id, {
        prompt: input.prompt,
        aspectRatio,
        startedAt,
        initialRetryAfter: result.retryAfterSeconds,
      });
      return this.state;
    }

    // Submission error or network issue
    if (result.kind === "error" && result.error) {
      if (result.error.code === "UNAUTHENTICATED") {
        this.deps.onUnauthenticated?.();
      }
      this.setState({
        phase: "failed",
        job: null,
        error: result.error,
      });
      return this.state;
    }

    // Network error on submission
    const networkError: VideoClientError = {
      code: "NETWORK_ERROR",
      message: "Could not reach video generation server. Please check your connection.",
      retryAfterSeconds: 4,
      resetAt: null,
      isTerminal: false,
    };
    this.setState({
      phase: "failed",
      job: null,
      error: networkError,
    });
    return this.state;
  }

  /**
   * Begins or resumes polling for an existing video job ID.
   */
  public poll(jobId: string, context: { prompt?: string; aspectRatio?: VideoAspectRatio; startedAt?: number } = {}): void {
    this.stopPollingLoop();
    this.startPollingLoop(jobId, {
      prompt: context.prompt ?? "",
      aspectRatio: context.aspectRatio ?? "16:9",
      startedAt: context.startedAt ?? this.now(),
    });
  }

  private startPollingLoop(
    jobId: string,
    context: {
      prompt: string;
      aspectRatio: VideoAspectRatio;
      startedAt: number;
      initialRetryAfter?: number | null;
    },
  ): void {
    this.pollingActive = true;
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    this.setState({
      phase: "polling",
      jobId,
      prompt: context.prompt,
      aspectRatio: context.aspectRatio,
      startedAt: context.startedAt,
      consecutiveFailures: 0,
      outcomeUnknown: false,
    });

    (async () => {
      let consecutiveFailures = 0;
      let nextDelayMs = context.initialRetryAfter
        ? context.initialRetryAfter * 1000
        : VIDEO_POLLING.defaultIntervalMs;

      while (this.pollingActive && !signal.aborted && !this.isDestroyed) {
        // Sleep for the determined interval
        await this.sleep(nextDelayMs, signal);

        if (!this.pollingActive || signal.aborted || this.isDestroyed) break;

        // If tab is hidden or device is offline, pause until online/visible
        if (this.isHidden() || !this.isOnline()) {
          nextDelayMs = 2000;
          continue;
        }

        const pollResult = await getVideoJob(jobId, {
          signal,
          fetchImpl: this.deps.fetchImpl,
        });

        if (!this.pollingActive || signal.aborted || this.isDestroyed) break;

        if (pollResult.kind === "job" && pollResult.body) {
          consecutiveFailures = 0;
          const { job, asset } = pollResult.body;

          if (job.status === "COMPLETED" && asset) {
            this.setState({
              phase: "completed",
              job,
              asset,
            });
            this.pollingActive = false;
            this.deps.onSettled?.();
            break;
          }

          if (job.status === "FAILED" || job.status === "CANCELLED") {
            this.setState({
              phase: "failed",
              job,
              error: {
                code: "UPSTREAM_REJECTED",
                message: job.error?.message ?? "Video generation failed.",
                retryAfterSeconds: null,
                resetAt: null,
                isTerminal: true,
              },
            });
            this.pollingActive = false;
            this.deps.onSettled?.();
            break;
          }

          // Still in progress
          this.setState({
            phase: "polling",
            jobId,
            prompt: context.prompt || job.prompt || "",
            aspectRatio: context.aspectRatio,
            startedAt: context.startedAt,
            consecutiveFailures: 0,
            outcomeUnknown: job.outcomeUnknown,
            lastJob: job,
          });
        } else {
          // Failure or error
          consecutiveFailures++;
        }

        const decision = decideNextVideoPoll({
          result: pollResult,
          pollStartedAt: context.startedAt,
          now: this.now(),
          consecutiveFailures,
          hidden: this.isHidden(),
          offline: !this.isOnline(),
        });

        if (decision.action === "stop") {
          this.pollingActive = false;
          if (decision.reason === "unauthenticated") {
            this.deps.onUnauthenticated?.();
            this.setState({
              phase: "failed",
              job: null,
              error: {
                code: "UNAUTHENTICATED",
                message: "Session expired. Please sign in again.",
                retryAfterSeconds: null,
                resetAt: null,
                isTerminal: true,
              },
            });
          } else if (decision.reason === "not-found") {
            this.setState({
              phase: "failed",
              job: null,
              error: {
                code: "NOT_FOUND",
                message: "Video generation job not found.",
                retryAfterSeconds: null,
                resetAt: null,
                isTerminal: true,
              },
            });
          } else if (decision.reason === "timeout") {
            this.setState({
              phase: "failed",
              job: null,
              error: {
                code: "TIMEOUT",
                message: "Video generation timed out. Your credits will be refunded automatically.",
                retryAfterSeconds: null,
                resetAt: null,
                isTerminal: true,
              },
            });
          }
          break;
        }

        if (decision.action === "wait") {
          nextDelayMs = decision.delayMs;
        } else if (decision.action === "pause") {
          nextDelayMs = 2000;
        }
      }
    })();
  }

  /**
   * Stops polling.
   * Aborts in-flight client network requests and cancels the local polling loop.
   *
   * IMPORTANT: This only stops local client polling.
   * It does NOT falsely claim or cancel the upstream server/provider generation job.
   */
  public stop(): void {
    this.stopPollingLoop();
    if (this.state.phase === "submitting" || this.state.phase === "polling") {
      this.setState({ phase: "idle" });
    }
  }

  public reset(): void {
    this.stopPollingLoop();
    this.setState({ phase: "idle" });
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.stopPollingLoop();
    this.listeners.clear();
  }

  private stopPollingLoop(): void {
    this.pollingActive = false;
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }
}

