import {
  errorResponse,
  isPlainObject,
  isTrustedOrigin,
  jsonResponse,
  readJsonBody,
} from "@/lib/api";
import { extractClientIp } from "@/lib/rate-limit";
import { GENERATION_REQUEST_MAX_BODY_BYTES } from "@/features/generations/config";
import type { AccountingErrorCode } from "@/features/generations/errors";
import { isValidIdempotencyKey } from "@/features/generations/validation";
import {
  canGenerateVideoInStage8,
  resolveUserVideoEntitlement,
  type UserVideoEntitlement,
} from "./auth";
import {
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_PROVIDER,
  VIDEO_POLL_INTERVAL_MS,
} from "./config";
import {
  dispatchVideoSubmission,
  reconcileStaleSubmissionIntent,
} from "./durable-submission";
import {
  toVideoJobView,
  videoJobResponseStatus,
  VIDEO_POLL_AFTER_SECONDS,
  isJobInProgress,
  type VideoJobRecord,
  type VideoJobResponseBody,
} from "./job-view";
import {
  createVideoJob,
  validateVideoRequestInput,
  type CreateVideoJobInput,
} from "./lifecycle";
import type { VideoProviderAdapter } from "./types";

export interface VideoHttpDeps {
  getUserId: () => Promise<string | null>;
  getUser?: (userId: string) => Promise<{
    id: string;
    email?: string | null;
    emailVerified?: Date | boolean | null;
    subscription?: { status: string; tier: string } | null;
  } | null>;
  trustedOrigins: () => readonly string[];
  getProvider: () => VideoProviderAdapter;
  loadJob: (userId: string, jobId: string) => Promise<VideoJobRecord | null>;
  loadBalance: (userId: string) => Promise<number | null>;
  signAssetUrl: (userId: string, assetId: string, kind?: "video" | "thumbnail") => Promise<string>;
  reconcileForUser: (userId: string) => Promise<unknown>;
  scheduleBackground: (task: () => Promise<unknown>) => void;
  triggerPendingIngestion?: (jobId: string) => Promise<unknown>;
  checkRateLimit?: (key: string) => { allowed: boolean; retryAfterSeconds: number };
  log?: { error(message: string, data?: Record<string, unknown>): void };
  now?: () => Date;
  allowlistRaw?: string;
  nodeEnv?: string;
  db?: any;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ACCOUNTING_STATUS: Record<AccountingErrorCode, number> = {
  INVALID_INPUT: 400,
  USER_NOT_FOUND: 401,
  INSUFFICIENT_CREDITS: 402,
  ACTIVE_JOB_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DAILY_LIMIT_REACHED: 429,
  CAPACITY_EXHAUSTED: 503,
};

const unauthenticated = () => errorResponse(401, "UNAUTHENTICATED", "Please sign in to continue.");
const notFound = () => errorResponse(404, "NOT_FOUND", "Not found.");
const invalid = (message: string) => errorResponse(400, "INVALID_INPUT", message);

export function createVideoGenerationHandlers(deps: VideoHttpDeps) {
  const log = deps.log ?? {
    error: (m: string, d?: Record<string, unknown>) => console.error(`[api/generations/video] ${m}`, d ?? {}),
  };

  function errorToResponse(error: unknown): Response {
    const name = (error as Error | null)?.name;
    if (name === "AccountingError") {
      const code = (error as { code: AccountingErrorCode }).code;
      const status = ACCOUNTING_STATUS[code] ?? 400;
      if (code === "USER_NOT_FOUND") return unauthenticated();
      const message = (error as Error).message;
      if (code === "DAILY_LIMIT_REACHED" || code === "CAPACITY_EXHAUSTED") {
        const retryAfter = 3600;
        return errorResponse(status, code, message, {}, { "Retry-After": String(retryAfter) });
      }
      return errorResponse(status, code, message);
    }
    log.error("unexpected error", { name: name ?? typeof error });
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }

  async function jobResponse(
    userId: string,
    jobId: string,
    mode: "created" | "replayed" | "fetched",
  ): Promise<Response> {
    let record: VideoJobRecord | null;
    let balance: number | null = null;
    try {
      [record, balance] = await Promise.all([
        deps.loadJob(userId, jobId),
        deps.loadBalance(userId).catch(() => null),
      ]);
    } catch (error) {
      log.error("job load failed", { jobId, name: (error as Error | null)?.name });
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "Your request was received but its status could not be loaded. Please refresh.",
        { jobId },
      );
    }
    if (!record) return notFound();

    let signedUrls: { videoUrl?: string; thumbnailUrl?: string | null } | undefined;
    if (record.status === "COMPLETED" && record.assets && record.assets.length > 0) {
      const asset = record.assets[0];
      try {
        const [videoUrl, thumbnailUrl] = await Promise.all([
          deps.signAssetUrl(userId, asset.id, "video"),
          asset.thumbnailKey
            ? deps.signAssetUrl(userId, asset.id, "thumbnail").catch(() => null)
            : Promise.resolve(null),
        ]);
        signedUrls = { videoUrl, thumbnailUrl };
      } catch (err) {
        log.error("signed url generation failed", { assetId: asset.id, err: (err as Error).message });
      }
    }

    const { job, asset } = toVideoJobView(record, signedUrls);
    const body: VideoJobResponseBody = {
      job,
      asset,
      replayed: mode === "replayed",
      balance,
    };

    const headers: Record<string, string> = {
      Location: `/api/generations/video/${encodeURIComponent(jobId)}`,
    };
    if (isJobInProgress(record.status)) {
      headers["Retry-After"] = String(VIDEO_POLL_AFTER_SECONDS);
    }

    return jsonResponse(body, videoJobResponseStatus(record.status, mode), headers);
  }

  return {
    /**
     * POST /api/generations/video — Asynchronous video generation submission.
     * Returns HTTP 202 Accepted immediately without holding the request connection open.
     */
    async postVideo(request: Request): Promise<Response> {
      // 1. CSRF / Origin Verification
      if (!isTrustedOrigin(request, deps.trustedOrigins())) {
        return errorResponse(403, "FORBIDDEN_ORIGIN", "This request was blocked.");
      }

      // 2. Authentication
      const userId = await deps.getUserId();
      if (!userId) return unauthenticated();

      // 3. Process-local rate limiting
      if (deps.checkRateLimit) {
        const ip = extractClientIp(request.headers);
        const ipLimit = deps.checkRateLimit(`gen:video:ip:${ip}`);
        if (!ipLimit.allowed) {
          return errorResponse(
            429,
            "RATE_LIMITED",
            "Too many generation requests from this IP. Please slow down.",
            {},
            { "Retry-After": String(ipLimit.retryAfterSeconds) },
          );
        }
        const userLimit = deps.checkRateLimit(`gen:video:user:${userId}`);
        if (!userLimit.allowed) {
          return errorResponse(
            429,
            "RATE_LIMITED",
            "Too many generation requests for this account. Please slow down.",
            {},
            { "Retry-After": String(userLimit.retryAfterSeconds) },
          );
        }
      }

      // 4. Idempotency Key validation
      const headerKey = request.headers.get("idempotency-key");
      const bodyResult = await readJsonBody(request, GENERATION_REQUEST_MAX_BODY_BYTES);
      if (!bodyResult.ok) {
        return invalid(
          bodyResult.reason === "CONTENT_TYPE"
            ? "Content-Type must be application/json."
            : bodyResult.reason === "TOO_LARGE"
            ? "Request body is too large."
            : "Request body must be valid JSON.",
        );
      }
      if (!isPlainObject(bodyResult.value)) {
        return invalid("Request body must be a JSON object.");
      }

      const body = bodyResult.value as Record<string, unknown>;
      const idempotencyKey = (typeof headerKey === "string" && headerKey.trim() !== "")
        ? headerKey.trim()
        : typeof body.idempotencyKey === "string"
        ? body.idempotencyKey.trim()
        : null;

      if (!isValidIdempotencyKey(idempotencyKey)) {
        return invalid("A valid Idempotency-Key header or property (8-100 characters: letters, digits, '-' or '_') is required.");
      }

      // 5. Server-side QA and entitlement resolution
      const user = deps.getUser ? await deps.getUser(userId) : { id: userId };
      const entitlement = resolveUserVideoEntitlement({
        user: user ?? { id: userId },
        clientPayload: body, // Untrusted client fields (tier, QA) are ignored by resolver
        trustedSubscription: user?.subscription,
        allowlistRaw: deps.allowlistRaw ?? process.env.STAGE_8_QA_ALLOWLIST,
        nodeEnv: deps.nodeEnv ?? process.env.NODE_ENV,
      });

      const access = canGenerateVideoInStage8({
        entitlement,
        nodeEnv: deps.nodeEnv ?? process.env.NODE_ENV,
      });
      if (!access.allowed) {
        return errorResponse(
          403,
          "FORBIDDEN",
          access.reason ?? "Video generation is restricted to authorized QA accounts during Stage 8.",
        );
      }

      // 6. Strict input validation
      let validatedInput;
      try {
        validatedInput = validateVideoRequestInput({
          prompt: body.prompt,
          aspectRatio: body.aspectRatio,
          duration: body.duration ?? body.durationSeconds,
          resolution: body.resolution,
          fps: body.fps ?? body.frameRate,
          idempotencyKey,
        });
      } catch (err) {
        return invalid((err as Error).message);
      }

      // 7. Atomic Job Creation & Credit Debit
      const now = deps.now ? deps.now() : new Date();
      let creationResult;
      try {
        creationResult = await createVideoJob(
          {
            userId,
            prompt: validatedInput.prompt,
            aspectRatio: validatedInput.settings.aspectRatio,
            duration: validatedInput.settings.duration,
            resolution: validatedInput.settings.resolution,
            fps: validatedInput.settings.fps,
            idempotencyKey,
            user: user ?? { id: userId },
            trustedSubscription: user?.subscription,
          },
          {
            now,
            creditCost: entitlement.creditCost,
            allowlistRaw: deps.allowlistRaw ?? process.env.STAGE_8_QA_ALLOWLIST,
            nodeEnv: deps.nodeEnv ?? process.env.NODE_ENV,
            provider: DEFAULT_VIDEO_PROVIDER,
            model: DEFAULT_VIDEO_MODEL,
          },
          deps.db,
        );
      } catch (error) {
        return errorToResponse(error);
      }

      const { job, replayed } = creationResult;

      // 8. Handle Idempotency Replay
      if (replayed) {
        // If the existing job is already terminal (COMPLETED, FAILED, CANCELLED), return its state
        if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
          return jobResponse(userId, job.id, "replayed");
        }
        // If PENDING and submission intent was never dispatched, recover and dispatch it below
        const submissionState = (job.settings as Record<string, unknown> | null)?.submission as
          | { state?: string }
          | undefined;
        if (job.status === "PROCESSING" || submissionState?.state === "dispatching" || submissionState?.state === "submitted") {
          return jobResponse(userId, job.id, "replayed");
        }
      }

      // 9. Dispatch to Provider (Asynchronous Queue Submission)
      const provider = deps.getProvider();
      const dispatchResult = await dispatchVideoSubmission({
        jobId: job.id,
        prompt: job.prompt ?? validatedInput.prompt,
        aspectRatio: validatedInput.settings.aspectRatio,
        provider,
        db: deps.db,
      });

      if (dispatchResult.outcome === "rejected") {
        // Definite pre-transmission failure; credits were refunded immediately
        return errorResponse(
          502,
          "UPSTREAM_REJECTED",
          dispatchResult.error ?? "Video generation request was rejected by provider.",
        );
      }

      // Both 'submitted' and 'ambiguous' return HTTP 202 Accepted
      // 'submitted' is in PROCESSING with providerJobId
      // 'ambiguous' is in PROCESSING awaiting webhook recovery (?jobId=) or operational review (preserves debit; never auto-refunded)
      return jobResponse(userId, job.id, replayed ? "replayed" : "created");
    },

    /**
     * GET /api/generations/video/[jobId] — Authenticated status polling.
     * Lightweight: Does NOT perform video download or thumbnail extraction in the GET handler.
     */
    async getJob(_request: Request, jobId: string): Promise<Response> {
      // 1. Authentication
      const userId = await deps.getUserId();
      if (!userId) return unauthenticated();

      // 2. Validate jobId syntax
      if (!ID_PATTERN.test(jobId)) return notFound();

      // 3. User-scoped stale-job reconciliation (best effort)
      try {
        await deps.reconcileForUser(userId);
      } catch (error) {
        log.error("user reconciliation failed", { name: (error as Error | null)?.name });
      }

      // 4. Load the job scoped strictly to owner
      let record: VideoJobRecord | null;
      try {
        record = await deps.loadJob(userId, jobId);
      } catch (error) {
        log.error("job load failed", { jobId, name: (error as Error | null)?.name });
        return errorResponse(500, "INTERNAL_ERROR", "Failed to load video job status.");
      }
      if (!record) return notFound();

      // 5. Lightweight Ingestion Work Detection & Signaling
      // If the provider has completed generation (e.g. Fast-ACK stored payload in settings.providerResult)
      // but ingestion hasn't run yet, signal the durable worker mechanism without blocking GET.
      const settings = (record.settings as Record<string, unknown> | null) ?? {};
      const hasProviderResult = settings.providerResult !== undefined && settings.providerResult !== null;

      if (record.status === "PROCESSING" && hasProviderResult && deps.triggerPendingIngestion) {
        deps.scheduleBackground(async () => {
          try {
            await deps.triggerPendingIngestion!(jobId);
          } catch (err) {
            log.error("signaled ingestion failed", { jobId, err: (err as Error).message });
          }
        });
      }

      // If job is PENDING and stuck with a stale submission intent, reconcile it
      const submission = settings.submission as { state?: string; expiresAt?: string } | undefined;
      if (
        record.status === "PENDING" &&
        submission?.state === "dispatching" &&
        submission.expiresAt &&
        new Date(submission.expiresAt).getTime() < Date.now()
      ) {
        deps.scheduleBackground(async () => {
          try {
            await reconcileStaleSubmissionIntent(jobId, deps.db);
          } catch (err) {
            log.error("reconcile stale submission failed", { jobId, err: (err as Error).message });
          }
        });
      }

      return jobResponse(userId, jobId, "fetched");
    },
  };
}
