import type { ImageQuality } from "../config";
import type { AssetView, ImageJobView, JobResponseBody } from "../job-view";
import type { ApiErrorCode, GenerationApiResult, getGenerationJob, postImageGeneration } from "./api";
import {
  clearPendingRequest,
  createPendingRequest,
  loadPendingRequest,
  savePendingRequest,
  withJobId,
  type KeyValueStore,
  type PendingRequest,
} from "./pending-request";
import { POLLING, backoffDelayMs, decideNextPoll, decideRecovery, isPollFailure, isTerminalStatus } from "./polling";

/*
 * Client-side generation state machine (framework-free, all effects injected):
 *
 *   idle ──submit──► submitting ──job in progress──► polling ──► completed | failed
 *                       │  └─ rejected before a job exists ──► error
 *                       └─ outcome unknown (network loss / 5xx) ──► replay SAME key (backoff)
 *   polling / submitting give up after 7 minutes ──► stalled ("Check again" resumes, never re-submits)
 *
 *   recover() on page load (once): server active job → poll it; stored request with a job id →
 *   poll it; stored request without a job id < 10 min old → replay it with its ORIGINAL key;
 *   older → discarded with a notice. A stored request that does not belong to the server's
 *   active job is HELD (kept, explained, resumable by the user) — never silently dropped.
 *
 * Guarantees:
 *  - The idempotency key is created once per user submit (createPendingRequest) and reused for
 *    every retry and recovery of that request. No key is ever created during recovery.
 *  - A new independent generation only starts from an explicit submit() while nothing runs.
 *  - Polling a job (GET) is always user-scoped on the server; a stored job id is never trusted
 *    as proof of ownership (a 404 ends recovery).
 *  - "completed" requires a confirmed asset; a stored request is cleared only when its own job
 *    reached a confirmed terminal state, after a definitive rejection, or on expiry.
 *  - State holds only same-origin /api/assets/ URLs — never signed storage URLs or keys.
 */

export type GenerationState =
  | { phase: "idle" }
  /** POST in flight (the server generates synchronously). checking = connection lost, replaying the same request. */
  | { phase: "submitting"; prompt: string; quality: ImageQuality; startedAt: number; checking: boolean; recovered: boolean }
  /** Job acknowledged and in progress. outcomeUnknown = provider outcome unknown (server reconciles). */
  | {
      phase: "polling";
      jobId: string;
      prompt: string;
      quality: ImageQuality;
      startedAt: number;
      outcomeUnknown: boolean;
      checking: boolean;
      recovered: boolean;
    }
  | { phase: "completed"; job: ImageJobView; asset: AssetView }
  /** The job failed; the server refunded the credits. */
  | { phase: "failed"; job: ImageJobView; message: string }
  /** Rejected before a job existed (credits, limits, capacity, auth, conflicts, …). */
  | { phase: "error"; code: ApiErrorCode; message: string; resetAt: string | null }
  /** Could not confirm the outcome in time. The request (and its key) is kept for a later check. */
  | { phase: "stalled"; jobId: string | null; prompt: string; message: string };

export type GenerationPhase = GenerationState["phase"];

/** Information about a stored request that recovery could not (or did not) resume. */
export type RecoveryNotice =
  /** Kept in storage: another job is active. The user may resume it later or discard it. */
  | { kind: "held"; prompt: string; quality: ImageQuality; startedAt: number }
  /** Too old to replay safely; removed from storage. The prompt is offered back to the editor. */
  | { kind: "expired"; prompt: string; quality: ImageQuality; startedAt: number };

/** Minimal view of the server-reported active job. */
export type ActiveJobInput = { id: string; status: ImageJobView["status"]; prompt: string | null; quality: ImageQuality | null } | null;

export type ControllerDeps = {
  userId: string;
  store: KeyValueStore | null;
  api: { post: typeof postImageGeneration; get: typeof getGenerationJob };
  now: () => number;
  /** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  visibility: { isHidden: () => boolean; waitUntilVisible: (signal: AbortSignal) => Promise<void> };
  randomId?: () => string;
  /** Re-sync server-rendered data (wallet balance, daily usage, active job). */
  onSettled?: () => void;
  /** Session expired: send the user to sign in. The stored request is kept for recovery. */
  onUnauthenticated?: () => void;
};

const STALLED_MESSAGE =
  "We couldn't confirm the result yet. If the generation doesn't finish, your credits are refunded automatically within about 5 minutes.";
const MISSING_ASSET_MESSAGE = "Your image finished but couldn't be loaded yet. Please check again in a moment.";

/** Rejections that created no job: retrying the same request would not change the outcome. */
const DEFINITIVE_REJECTIONS = new Set<ApiErrorCode>([
  "INVALID_INPUT",
  "INSUFFICIENT_CREDITS",
  "FORBIDDEN_ORIGIN",
  "ACTIVE_JOB_EXISTS",
  "IDEMPOTENCY_CONFLICT",
  "DAILY_LIMIT_REACHED",
  "CAPACITY_EXHAUSTED",
  "SERVICE_UNAVAILABLE",
]);
/** After these, server-rendered data (balance, limits, active job) may be stale. */
const REFRESH_AFTER = new Set<ApiErrorCode>(["INSUFFICIENT_CREDITS", "ACTIVE_JOB_EXISTS", "DAILY_LIMIT_REACHED", "CAPACITY_EXHAUSTED"]);

/** Whether a stored request is (very likely) the server's active job. */
function belongsToActiveJob(stored: PendingRequest, active: NonNullable<ActiveJobInput>) {
  if (stored.jobId) return stored.jobId === active.id;
  // Acknowledgement was never received: the active job is this request if it carries the same
  // body (the server would have rejected a different body for this key anyway).
  return active.prompt === stored.prompt && (active.quality === null || active.quality === stored.quality);
}

export class GenerationController {
  private state: GenerationState = { phase: "idle" };
  private notice: RecoveryNotice | null = null;
  private readonly listeners = new Set<() => void>();
  private abort = new AbortController();
  /** Incremented whenever a run starts or the controller detaches; stale runs stop silently. */
  private runId = 0;
  private recoveryStarted = false;
  /** Key of the stored request the current run belongs to (only that request may be cleared). */
  private trackedKey: string | null = null;
  /** Job currently followed by polling (prevents duplicate loops for the same job). */
  private trackedJobId: string | null = null;
  /** Ends the current wait early ("Check now"). */
  private wake: (() => void) | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  // ------------------------------------------------------------------ store interface
  getState = (): GenerationState => this.state;
  getNotice = (): RecoveryNotice | null => this.notice;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get busy() {
    return this.state.phase === "submitting" || this.state.phase === "polling";
  }

  /** (Re)activate after mount. */
  attach() {
    if (this.abort.signal.aborted) this.abort = new AbortController();
  }

  /**
   * Stop all in-flight work (unmount / navigation). Only the browser's own request is
   * aborted: the server keeps working on anything already sent, and the stored request lets
   * a later visit recover it with the same key.
   */
  detach() {
    this.runId++;
    this.trackedJobId = null;
    this.abort.abort();
    this.wake?.();
  }

  // ------------------------------------------------------------------ actions
  /**
   * Start a NEW generation (explicit user action). Ignored while one is in progress, and while
   * a held request awaits the user's decision (a new request would overwrite its stored slot).
   */
  submit(input: { prompt: string; quality: ImageQuality }): boolean {
    if (this.busy || this.notice?.kind === "held") return false;
    const request = createPendingRequest(input, { now: this.deps.now(), randomId: this.deps.randomId });
    savePendingRequest(this.deps.store, this.deps.userId, request);
    this.trackedKey = request.key;
    void this.runSubmit(request, ++this.runId, false);
    return true;
  }

  /**
   * Page-load recovery. Runs at most once per controller (Strict Mode / repeated effects are
   * no-ops). Never creates a key and never starts an independent generation.
   */
  recover(activeJob: ActiveJobInput): void {
    if (this.recoveryStarted || this.busy) return;
    this.recoveryStarted = true;
    const now = this.deps.now();
    const stored = loadPendingRequest(this.deps.store, this.deps.userId, now);
    const active = activeJob && !isTerminalStatus(activeJob.status) ? activeJob : null;

    if (active) {
      const own = stored !== null && belongsToActiveJob(stored, active);
      if (own) {
        this.trackedKey = stored.key;
        if (!stored.jobId) savePendingRequest(this.deps.store, this.deps.userId, withJobId(stored, active.id));
      } else {
        this.trackedKey = null;
        if (stored) this.setNotice({ kind: "held", prompt: stored.prompt, quality: stored.quality, startedAt: stored.startedAt });
      }
      void this.runPoll(active.id, active.prompt ?? stored?.prompt ?? "", active.quality ?? "fast", ++this.runId, 0, false, true);
      return;
    }

    const decision = decideRecovery({ activeJob: null, pending: stored, now });
    if (decision.action === "poll" && stored) {
      this.trackedKey = stored.key;
      void this.runPoll(decision.jobId, stored.prompt, stored.quality, ++this.runId, 0, false, true);
    } else if (decision.action === "replay") {
      this.trackedKey = decision.request.key;
      void this.runSubmit(decision.request, ++this.runId, true);
    } else if (decision.action === "discard" && stored) {
      clearPendingRequest(this.deps.store, this.deps.userId);
      this.setNotice({ kind: "expired", prompt: stored.prompt, quality: stored.quality, startedAt: stored.startedAt });
    }
  }

  /**
   * Follow a job the server reports as active (e.g. after a 409, or started in another tab).
   * Polling only — never a POST. Ignored while this page is already running something.
   */
  adoptActiveJob(activeJob: ActiveJobInput): boolean {
    // Before recovery has run, recover() handles the active job (and any stored request) itself.
    if (!this.recoveryStarted || !activeJob || isTerminalStatus(activeJob.status) || this.busy || this.trackedJobId === activeJob.id) return false;
    const stored = loadPendingRequest(this.deps.store, this.deps.userId, this.deps.now());
    this.trackedKey = stored && belongsToActiveJob(stored, activeJob) ? stored.key : null;
    void this.runPoll(activeJob.id, activeJob.prompt ?? "", activeJob.quality ?? "fast", ++this.runId, 0, false, true);
    return true;
  }

  /** Resume a held request (explicit user action, only while nothing else runs). Same key. */
  resumeHeld(): boolean {
    if (this.notice?.kind !== "held" || this.busy) return false;
    const now = this.deps.now();
    const stored = loadPendingRequest(this.deps.store, this.deps.userId, now);
    this.setNotice(null);
    if (!stored) return false;
    const decision = decideRecovery({ activeJob: null, pending: stored, now });
    this.trackedKey = stored.key;
    if (decision.action === "poll") {
      void this.runPoll(decision.jobId, stored.prompt, stored.quality, ++this.runId, 0, false, true);
      return true;
    }
    if (decision.action === "replay") {
      void this.runSubmit(decision.request, ++this.runId, true);
      return true;
    }
    clearPendingRequest(this.deps.store, this.deps.userId);
    this.setNotice({ kind: "expired", prompt: stored.prompt, quality: stored.quality, startedAt: stored.startedAt });
    return false;
  }

  /** Discard a held request (explicit user action). */
  discardHeld(): void {
    if (this.notice?.kind !== "held") return;
    const stored = loadPendingRequest(this.deps.store, this.deps.userId, this.deps.now());
    if (stored && stored.key !== this.trackedKey) clearPendingRequest(this.deps.store, this.deps.userId);
    this.setNotice(null);
  }

  dismissNotice(): void {
    if (this.notice?.kind === "held") return; // held requests are resolved via resume / discard
    this.setNotice(null);
  }

  /**
   * Re-check a stalled request without creating a new one: poll its job if known, otherwise
   * replay the stored request with its ORIGINAL key.
   */
  checkAgain(): boolean {
    if (this.state.phase !== "stalled") return false;
    const { jobId, prompt } = this.state;
    const stored = loadPendingRequest(this.deps.store, this.deps.userId, this.deps.now());
    const id = jobId ?? stored?.jobId ?? null;
    if (id) {
      void this.runPoll(id, prompt, stored?.quality ?? "fast", ++this.runId, 0, false, true);
      return true;
    }
    if (stored && stored.key === this.trackedKey) {
      void this.runSubmit(stored, ++this.runId, true);
      return true;
    }
    this.set({ phase: "idle" });
    return false;
  }

  /** "Check now": end the current wait so the next poll / replay happens immediately. */
  checkNow(): boolean {
    if (!this.busy || !this.wake) return false;
    this.wake();
    return true;
  }

  /** Tab became visible: a stalled job with a known id is re-checked once (GET only). */
  onVisible(): void {
    if (this.state.phase === "stalled" && this.state.jobId) this.checkAgain();
  }

  /** Clear a finished / rejected state back to idle (never cancels an in-progress job). */
  reset() {
    if (!this.busy) this.set({ phase: "idle" });
  }

  // ------------------------------------------------------------------ internals
  private set(next: GenerationState) {
    this.state = next;
    this.emit();
  }

  private setNotice(next: RecoveryNotice | null) {
    this.notice = next;
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private live(run: number) {
    return run === this.runId && !this.abort.signal.aborted;
  }

  /** Wait `ms` (abortable, and endable early by checkNow()). */
  private async wait(ms: number) {
    let woke!: () => void;
    const early = new Promise<void>((r) => (woke = r));
    this.wake = woke;
    await Promise.race([this.deps.sleep(ms, this.abort.signal), early]);
    if (this.wake === woke) this.wake = null;
  }

  /** POST the request; on uncertain outcomes replay it with the SAME key (backoff, 7-minute budget). */
  private async runSubmit(request: PendingRequest, run: number, recovered: boolean) {
    const loopStartedAt = this.deps.now();
    let failures = 0;
    this.trackedJobId = null;
    const submitting = (checking: boolean): GenerationState => ({
      phase: "submitting", prompt: request.prompt, quality: request.quality, startedAt: loopStartedAt, checking, recovered,
    });
    this.set(submitting(false));

    for (;;) {
      const result = await this.deps.api.post(
        { prompt: request.prompt, quality: request.quality, idempotencyKey: request.key },
        { signal: this.abort.signal },
      );
      if (!this.live(run) || result.kind === "aborted") return;

      if (result.kind === "job") return this.onJob(result, request, run, recovered);

      if (result.kind === "error") {
        const { code } = result.error;
        if (code === "UNAUTHENTICATED") {
          // Keep the stored request: after signing in, recovery replays it with the same key.
          this.set({ phase: "error", code, message: result.error.message, resetAt: null });
          this.deps.onUnauthenticated?.();
          return;
        }
        if (code === "INTERNAL_ERROR" && result.error.jobId) {
          // The job exists but its state could not be reported: follow it.
          savePendingRequest(this.deps.store, this.deps.userId, withJobId(request, result.error.jobId));
          return this.runPoll(result.error.jobId, request.prompt, request.quality, run, POLLING.defaultIntervalMs, false, recovered);
        }
        if (DEFINITIVE_REJECTIONS.has(code)) {
          // No job was created for this key; a new attempt needs a new user action.
          this.clearStoredIfKey(request.key);
          this.set({ phase: "error", code, message: result.error.message, resetAt: result.error.resetAt });
          if (REFRESH_AFTER.has(code)) this.deps.onSettled?.();
          return;
        }
        if (result.httpStatus < 500 && code !== "INTERNAL_ERROR") {
          // Unexpected client error (e.g. a non-contract 4xx): not retryable, but a job may
          // not exist — keep the request so a later check can confirm.
          this.set({ phase: "error", code, message: result.error.message, resetAt: null });
          return;
        }
      }

      // Network loss, 5xx or INTERNAL_ERROR without a job id: the job may or may not exist.
      // Replay the SAME request (idempotent on the server) after a backoff.
      failures++;
      if (this.deps.now() - loopStartedAt >= POLLING.maxDurationMs) {
        this.set({ phase: "stalled", jobId: null, prompt: request.prompt, message: STALLED_MESSAGE });
        return;
      }
      this.set(submitting(true));
      await this.wait(backoffDelayMs(failures));
      if (!this.live(run)) return;
    }
  }

  private onJob(result: Extract<GenerationApiResult, { kind: "job" }>, request: PendingRequest, run: number, recovered: boolean) {
    const { job } = result.body;
    savePendingRequest(this.deps.store, this.deps.userId, withJobId(request, job.id));
    if (isTerminalStatus(job.status)) return this.finish(result.body);
    const delay = result.retryAfterSeconds !== null ? result.retryAfterSeconds * 1000 : POLLING.defaultIntervalMs;
    return this.runPoll(job.id, request.prompt, request.quality, run, delay, job.outcomeUnknown, recovered);
  }

  private async runPoll(
    jobId: string,
    prompt: string,
    quality: ImageQuality,
    run: number,
    initialDelayMs: number,
    outcomeUnknown: boolean,
    recovered: boolean,
  ) {
    const pollStartedAt = this.deps.now();
    let failures = 0;
    let delay = initialDelayMs;
    this.trackedJobId = jobId;
    const polling = (checking: boolean): GenerationState => ({
      phase: "polling", jobId, prompt, quality, startedAt: pollStartedAt, outcomeUnknown, checking, recovered,
    });
    this.set(polling(false));

    for (;;) {
      if (delay > 0) await this.wait(delay);
      if (!this.live(run)) return;

      const result = await this.deps.api.get(jobId, { signal: this.abort.signal });
      if (!this.live(run)) return;
      failures = isPollFailure(result) ? failures + 1 : 0;

      if (result.kind === "job") {
        const job = result.body.job;
        outcomeUnknown = job.outcomeUnknown;
        if (job.prompt && !prompt) prompt = job.prompt;
        if (!isTerminalStatus(job.status)) this.set(polling(false));
      } else if (result.kind === "network" || (result.kind === "error" && result.httpStatus >= 500)) {
        this.set(polling(true));
      }

      const decision = decideNextPoll({
        result,
        pollStartedAt,
        now: this.deps.now(),
        consecutiveFailures: failures,
        hidden: this.deps.visibility.isHidden(),
      });

      if (decision.action === "wait") {
        delay = decision.delayMs;
        continue;
      }
      if (decision.action === "pause") {
        await this.deps.visibility.waitUntilVisible(this.abort.signal);
        delay = 0; // poll immediately when the tab is visible again
        continue;
      }
      if (decision.reason !== "aborted") this.trackedJobId = null;
      switch (decision.reason) {
        case "terminal":
          return this.finish((result as Extract<GenerationApiResult, { kind: "job" }>).body);
        case "not-found":
          // Not this user's job (or gone): the server is authoritative, nothing to recover.
          this.clearStoredIfJob(jobId);
          this.set({ phase: "error", code: "NOT_FOUND", message: "This generation could not be found.", resetAt: null });
          return;
        case "unauthenticated":
          this.set({ phase: "error", code: "UNAUTHENTICATED", message: "Please sign in to continue.", resetAt: null });
          this.deps.onUnauthenticated?.();
          return;
        case "aborted":
          return;
        default: // timeout, fatal
          this.set({ phase: "stalled", jobId, prompt, message: STALLED_MESSAGE });
          return;
      }
    }
  }

  /** Confirmed terminal state from the server. */
  private finish(body: JobResponseBody) {
    const { job, asset } = body;
    this.trackedJobId = null;
    if (job.status === "COMPLETED") {
      if (!asset) {
        // Never claim an image without a confirmed asset; keep the request for a re-check.
        this.set({ phase: "stalled", jobId: job.id, prompt: job.prompt ?? "", message: MISSING_ASSET_MESSAGE });
        return;
      }
      this.clearStoredIfJob(job.id);
      this.set({ phase: "completed", job, asset });
      this.deps.onSettled?.();
      return;
    }
    // FAILED or CANCELLED: the server refunded the credits.
    this.clearStoredIfJob(job.id);
    this.set({
      phase: "failed",
      job,
      message: job.error?.message ?? "The image couldn't be generated. Your credits were refunded.",
    });
    this.deps.onSettled?.();
  }

  /**
   * Clear the stored request only if it belongs to this finished job: its acknowledged job id
   * matches, or it is the request this page is running (tracked key). A held (different)
   * request is never cleared here.
   */
  private clearStoredIfJob(jobId: string) {
    const stored = loadPendingRequest(this.deps.store, this.deps.userId, this.deps.now());
    if (!stored) return;
    if (stored.jobId === jobId || (stored.jobId === undefined && stored.key === this.trackedKey)) {
      clearPendingRequest(this.deps.store, this.deps.userId);
    }
  }

  private clearStoredIfKey(key: string) {
    const stored = loadPendingRequest(this.deps.store, this.deps.userId, this.deps.now());
    if (stored?.key === key) clearPendingRequest(this.deps.store, this.deps.userId);
  }
}
