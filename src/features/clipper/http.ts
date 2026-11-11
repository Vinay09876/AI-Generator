/**
 * Clipper HTTP handlers (Batch 5). Route files only delegate here; all dependencies injected.
 *
 *   POST /api/clipper/uploads            reserve + signed direct upload URL         (201)
 *   POST /api/clipper/uploads/complete   verify uploaded object (size, signature)   (200)
 *   POST /api/clipper/uploads/discard    release own pending upload                 (200)
 *   POST /api/generations/clip           create clip job (Idempotency-Key)          (202 / 200 replay)
 *   GET  /api/generations/clip/[jobId]   job status + clips (short-lived signed URLs)
 *
 * State-changing routes: trusted Origin, session auth, process-local rate limit, 16 KB JSON cap.
 * Responses never contain storage keys of finished assets, lease tokens or stderr. (The upload
 * key of the caller's OWN pending upload is returned, as it is the handle for later calls.)
 */

import { errorResponse, isTrustedOrigin, jsonResponse, readJsonBody } from "@/lib/api";
import { extractClientIp } from "@/lib/rate-limit";
import { GENERATION_REQUEST_MAX_BODY_BYTES } from "@/features/generations/config";
import type { AccountingErrorCode } from "@/features/generations/errors";
import { isValidIdempotencyKey } from "@/features/generations/validation";
import { CLIPPER_POLL_AFTER_SECONDS } from "./config";
import { createClipJobFromRequest, type ClipJobDeps } from "./jobs";
import { isClipJobInProgress, toClipJobView, type ClipJobRecord, type ClipJobResponseBody } from "./job-view";
import { SEGMENT_REGEX } from "./storage/keys";
import { createUploadIntent, discardUpload, verifyUpload, type ClipperUploadDeps } from "./uploads/uploads";

export interface ClipperHttpDeps {
  getUserId: () => Promise<string | null>;
  trustedOrigins: () => readonly string[];
  checkRateLimit?: (key: string) => { allowed: boolean; retryAfterSeconds: number };
  uploads: ClipperUploadDeps;
  jobs: ClipJobDeps;
  loadJob: (userId: string, jobId: string) => Promise<ClipJobRecord | null>;
  loadBalance: (userId: string) => Promise<number | null>;
  signAsset: (userId: string, assetId: string, kind: "video" | "thumbnail") => Promise<string>;
  log?: { error(message: string, data?: Record<string, unknown>): void };
}

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
const forbiddenOrigin = () => errorResponse(403, "FORBIDDEN_ORIGIN", "This request was blocked.");

export function createClipperHandlers(deps: ClipperHttpDeps) {
  const log = deps.log ?? { error: (m: string, d?: Record<string, unknown>) => console.error(`[api/clipper] ${m}`, d ?? {}) };

  function errorToResponse(error: unknown): Response {
    const e = error as { name?: string; code?: string; message?: string; httpStatus?: number } | null;
    switch (e?.name) {
      case "ClipperUploadError":
        return errorResponse(e.httpStatus ?? 400, e.code!, e.message!);
      case "ClipJobRequestError":
        return errorResponse(e.code === "SOURCE_NOT_FOUND" ? 404 : 400, e.code!, e.message!);
      case "ClipperStorageKeyError":
        return errorResponse(400, "INVALID_INPUT", "Invalid request.");
      case "AccountingError": {
        const code = e.code as AccountingErrorCode;
        if (code === "USER_NOT_FOUND") return unauthenticated();
        const status = ACCOUNTING_STATUS[code] ?? 400;
        const headers: Record<string, string> = code === "DAILY_LIMIT_REACHED" || code === "CAPACITY_EXHAUSTED" ? { "Retry-After": "3600" } : {};
        return errorResponse(status, code, e.message ?? "Request rejected.", {}, headers);
      }
      default:
        log.error("unexpected error", { name: e?.name ?? typeof error });
        return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
    }
  }

  /** Origin + auth + rate limit + JSON body. Returns a Response on rejection. */
  async function guard(request: Request, bucket: string): Promise<{ userId: string; body: unknown } | Response> {
    if (!isTrustedOrigin(request, deps.trustedOrigins())) return forbiddenOrigin();
    const userId = await deps.getUserId();
    if (!userId) return unauthenticated();
    if (deps.checkRateLimit) {
      for (const key of [`clip:${bucket}:ip:${extractClientIp(request.headers)}`, `clip:${bucket}:user:${userId}`]) {
        const r = deps.checkRateLimit(key);
        if (!r.allowed) {
          return errorResponse(429, "RATE_LIMITED", "Too many requests. Please slow down.", {}, { "Retry-After": String(r.retryAfterSeconds) });
        }
      }
    }
    const parsed = await readJsonBody(request, GENERATION_REQUEST_MAX_BODY_BYTES);
    if (!parsed.ok) {
      return parsed.reason === "TOO_LARGE"
        ? errorResponse(413, "PAYLOAD_TOO_LARGE", "Request body is too large.")
        : errorResponse(400, "INVALID_INPUT", "Request body must be JSON.");
    }
    return { userId, body: parsed.value };
  }

  async function jobResponse(userId: string, jobId: string, mode: "created" | "replayed" | "fetched"): Promise<Response> {
    let record: ClipJobRecord | null;
    let balance: number | null = null;
    try {
      [record, balance] = await Promise.all([deps.loadJob(userId, jobId), deps.loadBalance(userId).catch(() => null)]);
    } catch (error) {
      log.error("job load failed", { jobId, name: (error as Error | null)?.name });
      return errorResponse(500, "INTERNAL_ERROR", "Your request was received but its status could not be loaded. Please refresh.", { jobId });
    }
    if (!record) return errorResponse(404, "NOT_FOUND", "Not found.");

    const signed = new Map<string, { videoUrl: string | null; thumbnailUrl: string | null }>();
    if (record.status === "COMPLETED") {
      await Promise.all(
        record.assets.map(async (a) => {
          const [videoUrl, thumbnailUrl] = await Promise.all([
            deps.signAsset(userId, a.id, "video").catch(() => null),
            a.thumbnailKey ? deps.signAsset(userId, a.id, "thumbnail").catch(() => null) : Promise.resolve(null),
          ]);
          signed.set(a.id, { videoUrl, thumbnailUrl });
        }),
      );
    }

    const body: ClipJobResponseBody = { job: toClipJobView(record, signed), replayed: mode === "replayed", balance };
    const headers: Record<string, string> = { Location: `/api/generations/clip/${encodeURIComponent(jobId)}` };
    const inProgress = isClipJobInProgress(record.status);
    if (inProgress) headers["Retry-After"] = String(CLIPPER_POLL_AFTER_SECONDS);
    const status = mode === "fetched" ? 200 : mode === "created" ? 202 : inProgress ? 202 : 200;
    return jsonResponse(body, status, headers);
  }

  return {
    async postUploadIntent(request: Request): Promise<Response> {
      const g = await guard(request, "upload");
      if (g instanceof Response) return g;
      try {
        const intent = await createUploadIntent(deps.uploads, { userId: g.userId, input: g.body });
        return jsonResponse({ upload: intent }, 201);
      } catch (error) {
        return errorToResponse(error);
      }
    },

    async postUploadComplete(request: Request): Promise<Response> {
      const g = await guard(request, "upload-verify");
      if (g instanceof Response) return g;
      try {
        const uploadKey = (g.body as Record<string, unknown> | null)?.uploadKey;
        const verified = await verifyUpload(deps.uploads, { userId: g.userId, uploadKey });
        return jsonResponse({ upload: verified }, 200);
      } catch (error) {
        return errorToResponse(error);
      }
    },

    async postUploadDiscard(request: Request): Promise<Response> {
      const g = await guard(request, "upload");
      if (g instanceof Response) return g;
      try {
        const uploadKey = (g.body as Record<string, unknown> | null)?.uploadKey;
        return jsonResponse(await discardUpload(deps.uploads, { userId: g.userId, uploadKey }), 200);
      } catch (error) {
        return errorToResponse(error);
      }
    },

    async postClipJob(request: Request): Promise<Response> {
      const g = await guard(request, "job");
      if (g instanceof Response) return g;
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!isValidIdempotencyKey(idempotencyKey)) return errorResponse(400, "INVALID_INPUT", "A valid Idempotency-Key header is required.");
      try {
        const { job, replayed } = await createClipJobFromRequest(deps.jobs, { userId: g.userId, idempotencyKey, body: g.body });
        return jobResponse(g.userId, job.id, replayed ? "replayed" : "created");
      } catch (error) {
        return errorToResponse(error);
      }
    },

    async getClipJob(_request: Request, jobId: string): Promise<Response> {
      const userId = await deps.getUserId();
      if (!userId) return unauthenticated();
      if (!SEGMENT_REGEX.test(jobId)) return errorResponse(404, "NOT_FOUND", "Not found.");
      return jobResponse(userId, jobId, "fetched");
    },
  };
}
