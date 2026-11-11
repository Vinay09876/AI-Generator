import {
  VideoProviderError,
  type VideoProviderErrorCode,
  type VideoProviderOutcome,
} from "../types";

/**
 * Normalizes an unknown exception or provider rejection into a typed VideoProviderError.
 * Guarantees that raw exceptions never escape unclassified to outer application layers.
 */
export function normalizeProviderError(
  err: unknown,
  defaultJobId?: string
): VideoProviderError {
  if (err instanceof VideoProviderError) {
    return err;
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    // Abort / Cancellation
    if (err.name === "AbortError" || msg.includes("aborted") || msg.includes("cancelled")) {
      return new VideoProviderError({
        code: "CANCELLED",
        outcome: "unknown",
        message: err.message,
        providerJobId: defaultJobId,
      });
    }

    // Network reachability failures before inference
    if (
      msg.includes("enotfound") ||
      msg.includes("econnrefused") ||
      msg.includes("eai_again") ||
      msg.includes("fetch failed")
    ) {
      return new VideoProviderError({
        code: "NETWORK",
        outcome: "not_run",
        message: `Network error reaching provider: ${err.message}`,
        providerJobId: defaultJobId,
      });
    }

    // Content moderation / safety policy rejections
    if (
      msg.includes("policy") ||
      msg.includes("nsfw") ||
      msg.includes("safety") ||
      msg.includes("moderation") ||
      msg.includes("content_policy")
    ) {
      return new VideoProviderError({
        code: "CONTENT_POLICY",
        outcome: "not_run",
        message: `Generation rejected by content safety policy: ${err.message}`,
        httpStatus: 400,
        providerJobId: defaultJobId,
      });
    }

    // Rate limits
    if (msg.includes("rate limit") || msg.includes("429")) {
      return new VideoProviderError({
        code: "RATE_LIMITED",
        outcome: "not_run",
        message: `Provider rate limit reached: ${err.message}`,
        httpStatus: 429,
        providerJobId: defaultJobId,
      });
    }

    // Authentication
    if (msg.includes("unauthorized") || msg.includes("401") || msg.includes("403")) {
      return new VideoProviderError({
        code: "AUTH",
        outcome: "not_run",
        message: `Provider authentication failed: ${err.message}`,
        httpStatus: 401,
        providerJobId: defaultJobId,
      });
    }

    // Generic upstream error
    return new VideoProviderError({
      code: "UPSTREAM",
      outcome: "unknown",
      message: err.message,
      providerJobId: defaultJobId,
    });
  }

  // Non-Error fallback
  return new VideoProviderError({
    code: "UPSTREAM",
    outcome: "unknown",
    message: String(err ?? "Unknown provider exception occurred"),
    providerJobId: defaultJobId,
  });
}

/**
 * Creates a classified VideoProviderError for HTTP response errors.
 */
export function createProviderHttpError(params: {
  status: number;
  bodyText?: string;
  providerJobId?: string;
}): VideoProviderError {
  const { status, bodyText = "", providerJobId } = params;
  const lower = bodyText.toLowerCase();

  let code: VideoProviderErrorCode = "UPSTREAM";
  let outcome: VideoProviderOutcome = "unknown";

  if (status === 401 || status === 403) {
    code = "AUTH";
    outcome = "not_run";
  } else if (status === 404) {
    code = "MODEL_NOT_FOUND";
    outcome = "not_run";
  } else if (status === 429) {
    code = "RATE_LIMITED";
    outcome = "not_run";
  } else if (status === 422 || status === 400) {
    if (
      lower.includes("policy") ||
      lower.includes("nsfw") ||
      lower.includes("safety") ||
      lower.includes("moderation")
    ) {
      code = "CONTENT_POLICY";
      outcome = "not_run";
    } else {
      code = "INVALID_REQUEST";
      outcome = "not_run";
    }
  } else if (status === 504 || status === 408) {
    code = "TIMEOUT";
    outcome = "unknown";
  }

  return new VideoProviderError({
    code,
    outcome,
    httpStatus: status,
    message: `Provider returned HTTP ${status}: ${bodyText.slice(0, 300)}`,
    providerJobId,
  });
}

