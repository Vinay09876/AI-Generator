import "server-only";
import {
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_PROVIDER,
  DEFAULT_VIDEO_SETTINGS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_PROVIDER_TIMEOUT_MS,
} from "../config";
import type {
  CompletedVideoMetadata,
  VideoCancelResult,
  VideoGenerationRequest,
  VideoJobStatusResult,
  VideoProviderAdapter,
  VideoProviderErrorCode,
  VideoProviderOutcome,
  VideoSubmitResult,
  WebhookVerificationInput,
  WebhookVerificationResult,
} from "../types";
import { VideoProviderError } from "../types";
import { verifyFalWebhookSignature } from "../webhooks/fal-verify";

export const FAL_QUEUE_BASE_URL = "https://queue.fal.run";

export interface FalProviderOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Classifies an HTTP status code or error into normalized VideoProviderErrorCode and Outcome.
 */
function classifyFalError(
  status: number | null,
  bodyText: string,
  err?: unknown,
): { code: VideoProviderErrorCode; outcome: VideoProviderOutcome; message: string } {
  const errCode = (err as { code?: string })?.code;
  const errMsg = (err as Error)?.message || "";

  // 1. Network level errors before request was sent or connection refused
  if (errCode === "ENOTFOUND" || errCode === "EAI_AGAIN" || errCode === "ECONNREFUSED") {
    return {
      code: "NETWORK",
      outcome: "not_run",
      message: `Failed to connect to Fal.ai: ${errCode}`,
    };
  }

  // 2. Network errors where request may have reached the provider
  if (errCode === "ECONNRESET" || errCode === "EPIPE" || errCode === "UND_ERR_SOCKET" || errCode === "ETIMEDOUT") {
    return {
      code: "NETWORK",
      outcome: "unknown",
      message: `Connection dropped during Fal.ai communication: ${errCode}`,
    };
  }

  if (errMsg.includes("timeout") || errMsg.includes("aborted")) {
    return {
      code: "TIMEOUT",
      outcome: "unknown",
      message: "Fal.ai request timed out waiting for upstream response.",
    };
  }

  // 3. HTTP Status code mapping
  if (status === 400) {
    return {
      code: "INVALID_REQUEST",
      outcome: "not_run",
      message: `Fal.ai invalid request parameters: ${bodyText.slice(0, 200)}`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: "AUTH",
      outcome: "not_run",
      message: "Fal.ai authentication failed. Check FAL_KEY credentials.",
    };
  }
  if (status === 404) {
    return {
      code: "MODEL_NOT_FOUND",
      outcome: "not_run",
      message: "Requested Fal.ai model or endpoint does not exist.",
    };
  }
  if (status === 422) {
    const isPolicy = /nsfw|safety|filter|content|violation/i.test(bodyText);
    return {
      code: isPolicy ? "CONTENT_POLICY" : "INVALID_REQUEST",
      outcome: "not_run",
      message: isPolicy
        ? "Prompt was blocked by Fal.ai safety and content filters."
        : `Fal.ai validation error: ${bodyText.slice(0, 200)}`,
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      outcome: "not_run",
      message: "Fal.ai rate limit exceeded. Retry later.",
    };
  }
  if (status && status >= 500) {
    return {
      code: "UPSTREAM",
      outcome: "unknown",
      message: `Fal.ai upstream server error (HTTP ${status}).`,
    };
  }

  return {
    code: "UPSTREAM",
    outcome: "unknown",
    message: bodyText ? bodyText.slice(0, 200) : "Unknown Fal.ai provider error.",
  };
}

/**
 * Fal.ai Video Provider Adapter.
 * Interacts with the asynchronous Fal.ai Queue API (`https://queue.fal.run`).
 */
export class FalVideoProvider implements VideoProviderAdapter {
  readonly id = DEFAULT_VIDEO_PROVIDER;
  readonly model: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly webhookUrl?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FalProviderOptions) {
    const key = options.apiKey?.trim();
    if (!key) {
      throw new VideoProviderError({
        code: "CONFIG",
        outcome: "not_run",
        message: "Missing FAL_KEY configuration.",
      });
    }

    this.apiKey = key;
    this.model = options.model?.trim() || DEFAULT_VIDEO_MODEL;
    this.timeoutMs = options.timeoutMs ?? VIDEO_PROVIDER_TIMEOUT_MS;
    this.webhookUrl = options.webhookUrl;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Submits a video generation task to the Fal.ai asynchronous inference queue.
   */
  async submit(request: VideoGenerationRequest): Promise<VideoSubmitResult> {
    // 1. Check if caller already aborted before transmission
    if (request.signal?.aborted) {
      throw new VideoProviderError({
        code: "CANCELLED",
        outcome: "not_run",
        message: "Video generation request was aborted before submission.",
      });
    }

    const { prompt, settings } = request;

    // 2. Map aspect ratio to dimensions
    const ar = settings?.aspectRatio ?? DEFAULT_VIDEO_SETTINGS.aspectRatio;

    // 3. Construct URL with optional fal_webhook parameter and jobId correlation
    const effectiveWebhookUrl = request.webhookUrl ?? this.webhookUrl;
    let submitUrl = `${FAL_QUEUE_BASE_URL}/${this.model}`;
    if (effectiveWebhookUrl) {
      const parsed = new URL(submitUrl);
      const whUrl = new URL(effectiveWebhookUrl);
      if (request.jobId) {
        whUrl.searchParams.set("jobId", request.jobId);
        if (request.correlationToken) {
          whUrl.searchParams.set("token", request.correlationToken);
        }
      }
      parsed.searchParams.set("fal_webhook", whUrl.toString());
      submitUrl = parsed.toString();
    }

    // 4. Exact Wan 2.1 720p payload structure
    const payload = {
      prompt: prompt.trim(),
      aspect_ratio: ar,
      num_frames: 81, // 81 frames default for Wan 2.1 720p (~5 seconds at 16 fps)
      frames_per_second: 16,
      resolution: "720p",
      enable_safety_checker: true,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(submitUrl, {
        method: "POST",
        headers: {
          Authorization: `Key ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const bodyText = await res.text();
        const classified = classifyFalError(res.status, bodyText);
        throw new VideoProviderError({
          code: classified.code,
          outcome: classified.outcome,
          message: classified.message,
          httpStatus: res.status,
        });
      }

      let data: any;
      try {
        data = (await res.json()) as {
          request_id?: string;
          status?: string;
          queue_position?: number;
        };
      } catch {
        // Fal accepted with HTTP 200, but response was truncated or not valid JSON!
        // Ambiguous outcome: unknown (provider may be running the generation).
        throw new VideoProviderError({
          code: "MALFORMED_RESPONSE",
          outcome: "unknown",
          message: "Fal.ai returned HTTP 200 but response body was not valid JSON.",
          httpStatus: 200,
        });
      }

      if (!data?.request_id || typeof data.request_id !== "string") {
        throw new VideoProviderError({
          code: "MALFORMED_RESPONSE",
          outcome: "unknown",
          message: "Fal.ai response missing request_id.",
          httpStatus: 200,
        });
      }

      return {
        provider: this.id,
        model: this.model,
        providerJobId: data.request_id,
        status: "PENDING",
        queuePosition: data.queue_position ?? null,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof VideoProviderError) throw err;

      const classified = classifyFalError(null, "", err);
      throw new VideoProviderError({
        code: classified.code,
        outcome: classified.outcome,
        message: classified.message,
      });
    }
  }

  /**
   * Checks the status of an in-flight job in the Fal.ai queue.
   */
  async checkStatus(
    providerJobId: string,
    signal?: AbortSignal,
  ): Promise<VideoJobStatusResult> {
    const statusUrl = `${FAL_QUEUE_BASE_URL}/${this.model}/requests/${providerJobId}/status`;

    try {
      const res = await this.fetchImpl(statusUrl, {
        method: "GET",
        headers: {
          Authorization: `Key ${this.apiKey}`,
          Accept: "application/json",
        },
        signal,
      });

      if (!res.ok) {
        const bodyText = await res.text();
        const classified = classifyFalError(res.status, bodyText);
        throw new VideoProviderError({
          code: classified.code,
          outcome: classified.outcome,
          message: classified.message,
          httpStatus: res.status,
          providerJobId,
        });
      }

      const statusData = (await res.json()) as {
        status?: string;
        response_url?: string;
        error?: string;
      };

      const falStatus = statusData.status?.toUpperCase() ?? "IN_QUEUE";

      if (falStatus === "IN_QUEUE") {
        return { providerJobId, status: "PENDING" };
      }

      if (falStatus === "IN_PROGRESS") {
        return { providerJobId, status: "PROCESSING" };
      }

      if (falStatus === "FAILED" || falStatus === "ERROR") {
        return {
          providerJobId,
          status: "FAILED",
          error: {
            code: "PROVIDER_ERROR",
            message: statusData.error || "Fal.ai execution failed.",
          },
        };
      }

      if (falStatus === "COMPLETED") {
        // Fetch result output from response_url
        const resultUrl =
          statusData.response_url ||
          `${FAL_QUEUE_BASE_URL}/${this.model}/requests/${providerJobId}`;

        const resultRes = await this.fetchImpl(resultUrl, {
          method: "GET",
          headers: {
            Authorization: `Key ${this.apiKey}`,
            Accept: "application/json",
          },
          signal,
        });

        if (!resultRes.ok) {
          throw new VideoProviderError({
            code: "UPSTREAM",
            outcome: "ran",
            message: `Failed to retrieve Fal.ai completed result: HTTP ${resultRes.status}`,
            httpStatus: resultRes.status,
            providerJobId,
          });
        }

        const resultData = (await resultRes.json()) as {
          video?: { url?: string; content_type?: string; file_size?: number };
          thumbnail?: { url?: string };
        };

        if (!resultData.video?.url) {
          throw new VideoProviderError({
            code: "MALFORMED_RESPONSE",
            outcome: "ran",
            message: "Fal.ai completed payload missing video.url.",
            providerJobId,
          });
        }

        const metadata: CompletedVideoMetadata = {
          videoUrl: resultData.video.url,
          mimeType: resultData.video.content_type || "video/mp4",
          fileSizeBytes: resultData.video.file_size ?? null,
          width: 1280,
          height: 720,
          durationSeconds: 5,
          fps: 16,
          thumbnailUrl: resultData.thumbnail?.url ?? null,
        };

        return {
          providerJobId,
          status: "COMPLETED",
          metadata,
        };
      }

      return { providerJobId, status: "PROCESSING" };
    } catch (err) {
      if (err instanceof VideoProviderError) throw err;
      const classified = classifyFalError(null, "", err);
      throw new VideoProviderError({
        code: classified.code,
        outcome: classified.outcome,
        message: classified.message,
        providerJobId,
      });
    }
  }

  /**
   * Attempts to cancel a queued or active generation job.
   */
  async cancel(providerJobId: string, signal?: AbortSignal): Promise<VideoCancelResult> {
    const cancelUrl = `${FAL_QUEUE_BASE_URL}/${this.model}/requests/${providerJobId}/cancel`;

    try {
      const res = await this.fetchImpl(cancelUrl, {
        method: "PUT",
        headers: {
          Authorization: `Key ${this.apiKey}`,
        },
        signal,
      });

      return {
        providerJobId,
        cancelled: res.ok,
        reason: res.ok ? "Cancelled on Fal.ai queue" : `Cancel failed with HTTP ${res.status}`,
      };
    } catch {
      return {
        providerJobId,
        cancelled: false,
        reason: "Network error during cancellation request",
      };
    }
  }

  /**
   * Verifies an incoming webhook signature using the official Fal.ai Ed25519 JWKS specification.
   */
  async verifyWebhook(input: WebhookVerificationInput): Promise<WebhookVerificationResult> {
    const result = await verifyFalWebhookSignature({
      rawBody: input.rawBody,
      headers: input.headers,
      now: input.now,
      toleranceMs: input.toleranceMs,
    });

    return {
      valid: result.valid,
      error: result.error,
      providerJobId: result.requestId,
      timestamp: result.timestamp,
    };
  }
}

/**
 * Server-only factory for FalVideoProvider.
 * Reads credentials from environment variables and builds the adapter.
 */
export function getFalVideoProvider(options?: Partial<FalProviderOptions>): FalVideoProvider {
  const apiKey = options?.apiKey ?? process.env.FAL_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new VideoProviderError({
      code: "CONFIG",
      outcome: "not_run",
      message: "FAL_KEY environment variable is not configured.",
    });
  }

  return new FalVideoProvider({
    apiKey,
    model: options?.model ?? process.env.FAL_VIDEO_MODEL ?? DEFAULT_VIDEO_MODEL,
    timeoutMs: options?.timeoutMs ?? VIDEO_PROVIDER_TIMEOUT_MS,
    webhookUrl:
      options?.webhookUrl ??
      process.env.FAL_WEBHOOK_URL ??
      (process.env.APP_ORIGIN ? `${process.env.APP_ORIGIN.replace(/\/$/, "")}/api/webhooks/video/fal` : undefined),
    fetchImpl: options?.fetchImpl,
  });
}
