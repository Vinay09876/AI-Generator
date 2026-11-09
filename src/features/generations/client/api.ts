import type { ImageQuality } from "../config";
import type { ImageJobView, JobResponseBody } from "../job-view";

/*
 * Typed browser client for the Stage 5 generation API. Never throws: every outcome is a
 * discriminated result, so callers handle network loss explicitly. The idempotency key is
 * always supplied by the caller (from the persisted pending request) and echoed back on
 * network failure — this module never creates or discards keys.
 */

export const API_ERROR_CODES = [
  "INVALID_INPUT",
  "UNAUTHENTICATED",
  "INSUFFICIENT_CREDITS",
  "FORBIDDEN_ORIGIN",
  "ACTIVE_JOB_EXISTS",
  "IDEMPOTENCY_CONFLICT",
  "DAILY_LIMIT_REACHED",
  "CAPACITY_EXHAUSTED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
  "NOT_FOUND",
] as const;

/** Known contract codes, plus UNKNOWN for anything unexpected (e.g. a proxy error page). */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number] | "UNKNOWN";

export type ApiError = {
  code: ApiErrorCode;
  /** User-safe message (from the server, or a local fallback). */
  message: string;
  /** ISO time when a daily limit / capacity resets (429 / 503 CAPACITY_EXHAUSTED). */
  resetAt: string | null;
  /** Set when the server created a job but could not report its state (500). */
  jobId: string | null;
};

export type GenerationApiResult =
  /** The server returned a job (201, 200, 202 — or 502 for a failed, refunded job). */
  | { kind: "job"; httpStatus: number; body: JobResponseBody; retryAfterSeconds: number | null }
  /** A contract error (no job state in the body). */
  | { kind: "error"; httpStatus: number; error: ApiError; retryAfterSeconds: number | null }
  /** No HTTP response: the request may or may not have reached the server. Keep the key. */
  | { kind: "network"; idempotencyKey: string | null }
  /** Cancelled by the caller (e.g. component unmounted). */
  | { kind: "aborted" };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type ApiOptions = { signal?: AbortSignal; fetchImpl?: FetchLike };

const FALLBACK_MESSAGES: Record<ApiErrorCode, string> = {
  INVALID_INPUT: "Please check your prompt and try again.",
  UNAUTHENTICATED: "Please sign in to continue.",
  INSUFFICIENT_CREDITS: "You don't have enough credits for this generation.",
  FORBIDDEN_ORIGIN: "This request was blocked. Please refresh the page and try again.",
  ACTIVE_JOB_EXISTS: "You already have a generation in progress.",
  IDEMPOTENCY_CONFLICT: "This request could not be repeated. Please try again.",
  DAILY_LIMIT_REACHED: "You've reached today's image limit.",
  CAPACITY_EXHAUSTED: "Today's generation capacity is used up.",
  SERVICE_UNAVAILABLE: "Image generation is temporarily unavailable. Please try again later.",
  INTERNAL_ERROR: "Something went wrong. Please try again.",
  NOT_FOUND: "This generation could not be found.",
  UNKNOWN: "Something went wrong. Please try again.",
};

export const fallbackMessage = (code: ApiErrorCode) => FALLBACK_MESSAGES[code];

const JOB_STATUSES = new Set<ImageJobView["status"]>(["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Structural check of the job response body (enough to render it safely). */
export function isJobResponseBody(value: unknown): value is JobResponseBody {
  if (!isObject(value) || !isObject(value.job)) return false;
  const job = value.job;
  if (typeof job.id !== "string" || !ID_PATTERN.test(job.id)) return false;
  if (typeof job.status !== "string" || !JOB_STATUSES.has(job.status as ImageJobView["status"])) return false;
  if (job.error !== null && job.error !== undefined && !isObject(job.error)) return false;
  if (value.asset !== null && value.asset !== undefined) {
    if (!isObject(value.asset) || typeof value.asset.id !== "string" || typeof value.asset.url !== "string") return false;
    // Only same-origin asset URLs are ever rendered.
    if (!value.asset.url.startsWith("/api/assets/")) return false;
  }
  return true;
}

/** Retry-After in whole seconds (delta form only); null if absent or invalid. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value.trim())) return null;
  return Number(value.trim());
}

function toApiError(value: unknown): ApiError {
  const e = isObject(value) && isObject(value.error) ? value.error : {};
  const code: ApiErrorCode =
    typeof e.code === "string" && (API_ERROR_CODES as readonly string[]).includes(e.code) ? (e.code as ApiErrorCode) : "UNKNOWN";
  const message = typeof e.message === "string" && e.message.trim() !== "" ? e.message.slice(0, 300) : fallbackMessage(code);
  const resetAt = typeof e.resetAt === "string" && !Number.isNaN(Date.parse(e.resetAt)) ? e.resetAt : null;
  const jobId = typeof e.jobId === "string" && ID_PATTERN.test(e.jobId) ? e.jobId : null;
  return { code, message, resetAt, jobId };
}

/**
 * Pure parser for one HTTP response (status, Retry-After header, raw body text).
 * A body carrying a job wins regardless of status (e.g. 502 = failed and refunded).
 */
export function parseApiResponse(httpStatus: number, retryAfterHeader: string | null, text: string): GenerationApiResult {
  const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (isJobResponseBody(json)) return { kind: "job", httpStatus, body: json, retryAfterSeconds };

  const error = toApiError(json);
  // Non-contract responses (proxy pages, empty bodies): derive a code from the status.
  if (error.code === "UNKNOWN") {
    if (httpStatus === 401) error.code = "UNAUTHENTICATED";
    else if (httpStatus === 404) error.code = "NOT_FOUND";
    error.message = fallbackMessage(error.code);
  }
  return { kind: "error", httpStatus, error, retryAfterSeconds };
}

async function send(url: string, init: RequestInit, options: ApiOptions, idempotencyKey: string | null): Promise<GenerationApiResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((u, i) => fetch(u, i));
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, credentials: "same-origin", cache: "no-store", signal: options.signal });
  } catch {
    return options.signal?.aborted ? { kind: "aborted" } : { kind: "network", idempotencyKey };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    // Headers arrived but the body was cut off: the outcome is unknown, so keep the key.
    return options.signal?.aborted ? { kind: "aborted" } : { kind: "network", idempotencyKey };
  }
  return parseApiResponse(response.status, response.headers.get("retry-after"), text);
}

/**
 * POST /api/generations/image. The same key + prompt + quality may be sent again safely
 * (replay); the server never re-runs the provider, debit or reservation for a known key.
 */
export function postImageGeneration(
  request: { prompt: string; quality: ImageQuality; idempotencyKey: string },
  options: ApiOptions = {},
): Promise<GenerationApiResult> {
  return send(
    "/api/generations/image",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey },
      body: JSON.stringify({ prompt: request.prompt, quality: request.quality }),
    },
    options,
    request.idempotencyKey,
  );
}

/** GET /api/generations/{jobId}: owner-scoped job state (also settles the user's stale jobs). */
export function getGenerationJob(jobId: string, options: ApiOptions = {}): Promise<GenerationApiResult> {
  if (!ID_PATTERN.test(jobId)) {
    return Promise.resolve({
      kind: "error",
      httpStatus: 404,
      error: { code: "NOT_FOUND", message: fallbackMessage("NOT_FOUND"), resetAt: null, jobId: null },
      retryAfterSeconds: null,
    });
  }
  return send(`/api/generations/${encodeURIComponent(jobId)}`, { method: "GET" }, options, null);
}
