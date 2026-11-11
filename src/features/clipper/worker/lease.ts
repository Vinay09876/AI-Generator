/**
 * Worker lease keeper: periodic heartbeat renewal + explicit fencing checkpoints.
 *
 * Ownership is NEVER assumed from in-memory state alone: every checkpoint (renewNow) is a
 * database round-trip through renewClipperLease, which refuses expired or foreign tokens.
 * When the lease is lost the AbortSignal fires so in-flight FFmpeg processes are killed.
 */

export class LeaseLostError extends Error {
  readonly code = "LEASE_LOST";
  constructor(public readonly reason: string) {
    super(`Worker lease lost: ${reason}`);
    this.name = "LeaseLostError";
  }
}

export interface LeaseKeeperOptions {
  /** Performs one guarded renewal; resolves false when the database rejects the token. */
  renew: () => Promise<boolean>;
  /** Lease duration granted by each successful renewal. */
  leaseMs: number;
  /** Heartbeat period. Must be well below leaseMs. Default: leaseMs / 3. */
  intervalMs?: number;
  /** Treat the lease as lost this long before its locally computed expiry. Default: 10% of leaseMs. */
  safetyMarginMs?: number;
  now?: () => number;
  /** Time the lease was last granted (e.g. the claim). Default: now(). */
  grantedAt?: number;
  /**
   * Worker shutdown signal. Aborts in-flight subprocesses WITHOUT marking the lease lost, so the
   * worker can still perform a fenced failure settlement while it holds a valid lease.
   */
  externalSignal?: AbortSignal;
}

export class WorkerShutdownError extends Error {
  readonly code = "WORKER_SHUTDOWN";
  constructor() {
    super("Worker is shutting down.");
    this.name = "WorkerShutdownError";
  }
}

export class LeaseKeeper {
  private readonly controller = new AbortController();
  private readonly opts: Required<Omit<LeaseKeeperOptions, "grantedAt" | "externalSignal">>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private localExpiry: number;
  private lostReason: string | null = null;
  renewals = 0;

  constructor(options: LeaseKeeperOptions) {
    if (!(options.leaseMs > 0)) throw new Error("leaseMs must be positive");
    const intervalMs = options.intervalMs ?? Math.floor(options.leaseMs / 3);
    if (!(intervalMs > 0 && intervalMs < options.leaseMs)) throw new Error("intervalMs must be in (0, leaseMs)");
    this.opts = {
      renew: options.renew,
      leaseMs: options.leaseMs,
      intervalMs,
      safetyMarginMs: options.safetyMarginMs ?? Math.floor(options.leaseMs * 0.1),
      now: options.now ?? Date.now,
    };
    this.localExpiry = (options.grantedAt ?? this.opts.now()) + options.leaseMs;
    const ext = options.externalSignal;
    if (ext) {
      const onAbort = () => {
        if (!this.controller.signal.aborted) this.controller.abort(new WorkerShutdownError());
      };
      if (ext.aborted) onAbort();
      else ext.addEventListener("abort", onAbort, { once: true });
    }
  }

  /** True when the worker shutdown signal (not lease loss) aborted the work. */
  get shuttingDown(): boolean {
    return this.controller.signal.aborted && !this.lost;
  }

  /** Throws WorkerShutdownError when a shutdown was requested. */
  assertRunning(): void {
    if (this.shuttingDown) throw new WorkerShutdownError();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get lost(): boolean {
    return this.lostReason !== null;
  }

  get reason(): string | null {
    return this.lostReason;
  }

  start(): void {
    if (this.timer || this.lost) return;
    this.timer = setInterval(() => void this.heartbeat(), this.opts.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  markLost(reason: string): void {
    if (this.lostReason) return;
    this.lostReason = reason;
    this.stop();
    this.controller.abort(new LeaseLostError(reason));
  }

  assertHeld(): void {
    if (this.lostReason) throw new LeaseLostError(this.lostReason);
    if (this.opts.now() >= this.localExpiry - this.opts.safetyMarginMs) {
      this.markLost("lease_expiring_without_renewal");
      throw new LeaseLostError(this.lostReason!);
    }
  }

  private async attempt(throwOnError: boolean): Promise<void> {
    const startedAt = this.opts.now();
    let ok: boolean;
    try {
      ok = await this.opts.renew();
    } catch (err) {
      // Transient renewal failure: keep the job only while the last grant is still safely valid.
      if (this.opts.now() >= this.localExpiry - this.opts.safetyMarginMs) {
        this.markLost("renewal_unavailable");
      }
      if (throwOnError) throw err;
      return;
    }
    if (!ok) {
      this.markLost("renewal_rejected");
      return;
    }
    this.renewals++;
    this.localExpiry = startedAt + this.opts.leaseMs;
  }

  private async heartbeat(): Promise<void> {
    if (this.lost || this.inFlight) return;
    this.inFlight = this.attempt(false).finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  /** Fencing checkpoint: a synchronous database renewal that must succeed to continue. */
  async renewNow(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    this.assertHeld();
    await this.attempt(true);
    this.assertHeld();
  }
}
