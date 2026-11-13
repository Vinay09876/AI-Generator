import { errorResponse, isPlainObject, isTrustedOrigin, jsonResponse, readJsonBody } from "@/lib/api";
import { extractClientIp } from "@/lib/rate-limit";
import { GENERATION_REQUEST_MAX_BODY_BYTES } from "./config";
import type { AccountingErrorCode } from "./errors";
import type { GenerationRunResult } from "./generate-image";
import { POLL_AFTER_SECONDS, isJobInProgress, jobResponseStatus, toJobView, type ImageJobRecord, type JobResponseBody } from "./job-view";
import { isValidIdempotencyKey } from "./validation";

/*
 * HTTP layer for image generation. Framework-free (standard Request/Response) and fully
 * dependency-injected; the real wiring lives in ./service.ts and the route files only
 * delegate. Every handler authenticates via the session; user IDs never come from the client.
 */

export type GenerationHttpDeps = {
  /** Authenticated user id from the session, or null. */
  getUserId: () => Promise<string | null>;
  trustedOrigins: () => readonly string[];
  generate: (input: { userId: string; prompt: unknown; quality: unknown; idempotencyKey: string }) => Promise<GenerationRunResult>;
  loadJob: (userId: string, jobId: string) => Promise<ImageJobRecord | null>;
  loadBalance: (userId: string) => Promise<number | null>;
  /** Settle this user's stale jobs (best effort). */
  reconcileForUser: (userId: string) => Promise<unknown>;
  /** Run a task after the response is sent (Next.js after()). Best effort, not durable. */
  scheduleBackground: (task: () => Promise<unknown>) => void;
  /** Bounded global sweep of stale jobs. */
  reconcileGlobal: () => Promise<unknown>;
  /** Ownership-checked signed URL; throws AssetAccessError for missing / not owned. */
  signAssetUrl: (userId: string, assetId: string) => Promise<string>;
  log?: { error(message: string, data?: Record<string, unknown>): void };
  /** Optional process-local burst throttle. */
  checkRateLimit?: (key: string) => { allowed: boolean; retryAfterSeconds: number };
};

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

/** Next 00:00 UTC — when per-user limits and the provider budget reset. */
export function nextUtcMidnight(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

const unauthenticated = () => errorResponse(401, "UNAUTHENTICATED", "Please sign in to continue.");
const notFound = () => errorResponse(404, "NOT_FOUND", "Not found.");
const invalid = (message: string) => errorResponse(400, "INVALID_INPUT", message);

export function createGenerationHandlers(deps: GenerationHttpDeps) {
  const log = deps.log ?? { error: (m: string, d?: Record<string, unknown>) => console.error(`[api/generations] ${m}`, d ?? {}) };

  /** Map an error thrown before/while creating a job to the approved status contract. */
  function errorToResponse(error: unknown): Response {
    const name = (error as Error | null)?.name;
    if (name === "ContentPolicyViolationError") {
      return errorResponse(400, "CONTENT_POLICY_VIOLATION", (error as Error).message);
    }
    if (name === "AccountingError") {
      const code = (error as { code: AccountingErrorCode }).code;
      const status = ACCOUNTING_STATUS[code] ?? 400;
      if (code === "USER_NOT_FOUND") return unauthenticated();
      const message = (error as Error).message;
      if (code === "DAILY_LIMIT_REACHED" || code === "CAPACITY_EXHAUSTED") {
        const resetAt = nextUtcMidnight();
        const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
        return errorResponse(status, code, message, { resetAt: resetAt.toISOString() }, { "Retry-After": String(retryAfter) });
      }
      return errorResponse(status, code, message);
    }
    if (name === "GenerationUnavailableError") {
      return errorResponse(503, "SERVICE_UNAVAILABLE", "Image generation is temporarily unavailable. Please try again later.");
    }
    log.error("unexpected error", { name: name ?? typeof error });
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }

  /** Re-read the persisted job so the client always sees the actual settled state. */
  async function jobResponse(userId: string, jobId: string, mode: "created" | "replayed" | "fetched"): Promise<Response> {
    let record: ImageJobRecord | null;
    let balance: number | null = null;
    try {
      [record, balance] = await Promise.all([deps.loadJob(userId, jobId), deps.loadBalance(userId).catch(() => null)]);
    } catch (error) {
      log.error("job load failed", { jobId, name: (error as Error | null)?.name });
      // The job exists; the client can recover it with GET or by replaying its key.
      return errorResponse(500, "INTERNAL_ERROR", "Your request was received but its status could not be loaded. Please refresh.", { jobId });
    }
    if (!record) return notFound();

    const view = toJobView(record);
    const body: JobResponseBody = { ...view, replayed: mode === "replayed", balance };
    const headers: Record<string, string> = { Location: `/api/generations/${encodeURIComponent(jobId)}` };
    if (isJobInProgress(record.status)) headers["Retry-After"] = String(POLL_AFTER_SECONDS);
    return jsonResponse(body, jobResponseStatus(record.status, mode), headers);
  }

  return {
    /** POST /api/generations/image — synchronous generation. */
    async postImage(request: Request): Promise<Response> {
      if (!isTrustedOrigin(request, deps.trustedOrigins())) {
        return errorResponse(403, "FORBIDDEN_ORIGIN", "This request was blocked.");
      }
      const userId = await deps.getUserId();
      if (!userId) return unauthenticated();

      // Process-local burst throttling (best-effort; Postgres enforces authoritative limits)
      if (deps.checkRateLimit) {
        const ip = extractClientIp(request.headers);
        const limitCheck = deps.checkRateLimit(`gen:ip:${ip}`);
        if (!limitCheck.allowed) {
          return errorResponse(
            429,
            "RATE_LIMITED",
            "Too many generation requests. Please slow down.",
            {},
            { "Retry-After": String(limitCheck.retryAfterSeconds) },
          );
        }
      }

      const idempotencyKey = request.headers.get("idempotency-key");
      if (!isValidIdempotencyKey(idempotencyKey)) {
        return invalid("A valid Idempotency-Key header (8-100 characters: letters, digits, '-' or '_') is required.");
      }

      const body = await readJsonBody(request, GENERATION_REQUEST_MAX_BODY_BYTES);
      if (!body.ok) {
        return invalid(
          body.reason === "CONTENT_TYPE" ? "Content-Type must be application/json."
            : body.reason === "TOO_LARGE" ? "Request body is too large."
            : "Request body must be valid JSON.",
        );
      }
      if (!isPlainObject(body.value)) return invalid("Request body must be a JSON object.");

      // Best-effort global sweep after the response (not a durable queue; see PROJECT_CONTEXT.md).
      deps.scheduleBackground(deps.reconcileGlobal);

      let result: GenerationRunResult;
      try {
        result = await deps.generate({ userId, prompt: body.value.prompt, quality: body.value.quality, idempotencyKey });
      } catch (error) {
        return errorToResponse(error);
      }
      return jobResponse(userId, result.jobId, result.replayed ? "replayed" : "created");
    },

    /** GET /api/generations/{jobId} — owner-scoped status, used for polling and reload recovery. */
    async getJob(_request: Request, jobId: string): Promise<Response> {
      const userId = await deps.getUserId();
      if (!userId) return unauthenticated();
      if (!ID_PATTERN.test(jobId)) return notFound();
      try {
        await deps.reconcileForUser(userId);
      } catch (error) {
        log.error("user reconciliation failed", { name: (error as Error | null)?.name });
      }
      return jobResponse(userId, jobId, "fetched");
    },

    /** GET /api/assets/{assetId} — ownership check, then 302 to a short-lived signed URL. */
    async getAsset(_request: Request, assetId: string): Promise<Response> {
      const userId = await deps.getUserId();
      if (!userId) return unauthenticated();
      if (!ID_PATTERN.test(assetId)) return notFound();
      try {
        const url = await deps.signAssetUrl(userId, assetId);
        return new Response(null, {
          status: 302,
          headers: { Location: url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
        });
      } catch (error) {
        const name = (error as Error | null)?.name;
        if (name === "AssetAccessError") return notFound();
        log.error("asset signing failed", { name, code: (error as { code?: unknown } | null)?.code });
        return errorResponse(503, "SERVICE_UNAVAILABLE", "This image is temporarily unavailable. Please try again.");
      }
    },
  };
}
