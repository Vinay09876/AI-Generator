import type {
  SubmitVideoInput,
  VideoApiErrorCode,
  VideoApiResult,
  VideoClientError,
} from "./types";
import type { VideoJobResponseBody } from "../job-view";

const FALLBACK_MESSAGES: Record<VideoApiErrorCode, string> = {
  INVALID_INPUT: "Please check your video prompt and parameters and try again.",
  UNAUTHENTICATED: "Please sign in to generate video.",
  INSUFFICIENT_CREDITS: "You don't have enough credits for video generation.",
  FORBIDDEN: "Video generation is restricted to authorized accounts during Stage 8.",
  FORBIDDEN_ORIGIN: "This request was blocked. Please refresh the page.",
  ACTIVE_JOB_EXISTS: "You already have a generation in progress. Please wait for it to finish.",
  IDEMPOTENCY_CONFLICT: "This request could not be repeated. Please try again with a new prompt.",
  DAILY_LIMIT_REACHED: "You've reached today's video generation limit.",
  CAPACITY_EXHAUSTED: "Video generation capacity is temporarily exhausted. Please try again later.",
  UPSTREAM_REJECTED: "The video provider rejected the request. Credits were refunded.",
  SERVICE_UNAVAILABLE: "Video generation is temporarily unavailable. Please try again later.",
  INTERNAL_ERROR: "Something went wrong. Please try again.",
  NOT_FOUND: "Video generation job not found.",
  NETWORK_ERROR: "Network connection lost. Checking job status...",
  TIMEOUT: "The generation took too long to complete. Please check status later.",
  ABORTED: "Video generation was cancelled.",
  UNKNOWN: "An unexpected error occurred. Please try again.",
};

export function fallbackMessage(code: VideoApiErrorCode): string {
  return FALLBACK_MESSAGES[code] ?? FALLBACK_MESSAGES.UNKNOWN;
}

export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function isJobResponseBody(value: unknown): value is VideoJobResponseBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.job !== "object" || v.job === null) return false;
  const job = v.job as Record<string, unknown>;
  if (typeof job.id !== "string" || typeof job.status !== "string") return false;
  return true;
}

export interface ApiFetchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Sends POST /api/generations/video to submit a video generation job.
 * Handles HTTP 202 Accepted, HTTP 200 (replayed completed), or errors.
 * Never throws: returns discriminated VideoApiResult.
 */
export async function postVideoGeneration(
  input: SubmitVideoInput,
  options: ApiFetchOptions = {},
): Promise<VideoApiResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const idempotencyKey = input.idempotencyKey ?? `vid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const response = await fetchFn("/api/generations/video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        durationSeconds: input.durationSeconds,
        resolution: input.resolution,
        frameRate: input.frameRate,
        idempotencyKey,
      }),
      signal: options.signal,
    });

    const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
    const json = await response.json().catch(() => null);

    if (response.status === 202 || response.status === 200 || response.status === 201) {
      if (isJobResponseBody(json)) {
        return {
          kind: "job",
          httpStatus: response.status,
          body: json,
          retryAfterSeconds,
          idempotencyKey,
        };
      }
    }

    // Error response
    const errObj = (json && typeof json === "object" && "error" in json)
      ? (json as Record<string, any>).error
      : null;
    const code = (typeof errObj?.code === "string" ? errObj.code : "UNKNOWN") as VideoApiErrorCode;
    const message = typeof errObj?.message === "string" ? errObj.message : fallbackMessage(code);
    const resetAt = typeof errObj?.resetAt === "string" ? errObj.resetAt : null;

    const isTerminal =
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403 ||
      response.status === 409 ||
      response.status === 422 ||
      response.status === 502;

    const error: VideoClientError = {
      code,
      message,
      retryAfterSeconds,
      resetAt,
      isTerminal,
    };

    return {
      kind: "error",
      httpStatus: response.status,
      error,
      retryAfterSeconds,
      idempotencyKey,
    };
  } catch (err: any) {
    if (err?.name === "AbortError" || options.signal?.aborted) {
      return { kind: "aborted", idempotencyKey };
    }
    return {
      kind: "network",
      idempotencyKey,
      error: {
        code: "NETWORK_ERROR",
        message: fallbackMessage("NETWORK_ERROR"),
        retryAfterSeconds: 4,
        resetAt: null,
        isTerminal: false,
      },
    };
  }
}

/**
 * Sends GET /api/generations/video/[jobId] to poll for video status.
 * Lightweight: Never throws.
 */
export async function getVideoJob(
  jobId: string,
  options: ApiFetchOptions = {},
): Promise<VideoApiResult> {
  const fetchFn = options.fetchImpl ?? fetch;

  try {
    const response = await fetchFn(`/api/generations/video/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: options.signal,
    });

    const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
    const json = await response.json().catch(() => null);

    if (response.ok && isJobResponseBody(json)) {
      return {
        kind: "job",
        httpStatus: response.status,
        body: json,
        retryAfterSeconds,
      };
    }

    const errObj = (json && typeof json === "object" && "error" in json)
      ? (json as Record<string, any>).error
      : null;
    const code = (typeof errObj?.code === "string" ? errObj.code : "UNKNOWN") as VideoApiErrorCode;
    const message = typeof errObj?.message === "string" ? errObj.message : fallbackMessage(code);

    return {
      kind: "error",
      httpStatus: response.status,
      error: {
        code,
        message,
        retryAfterSeconds,
        resetAt: null,
        isTerminal: response.status === 401 || response.status === 404,
      },
      retryAfterSeconds,
    };
  } catch (err: any) {
    if (err?.name === "AbortError" || options.signal?.aborted) {
      return { kind: "aborted" };
    }
    return {
      kind: "network",
      error: {
        code: "NETWORK_ERROR",
        message: fallbackMessage("NETWORK_ERROR"),
        retryAfterSeconds: 4,
        resetAt: null,
        isTerminal: false,
      },
    };
  }
}

