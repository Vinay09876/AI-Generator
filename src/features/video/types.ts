import type {
  VideoAspectRatio,
  VideoDuration,
  VideoFrameRate,
  VideoResolution,
} from "./config";

// ---------------------------------------------------------------------------
// Generation Request & Settings
// ---------------------------------------------------------------------------
export interface VideoGenerationSettings {
  aspectRatio: VideoAspectRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  fps: VideoFrameRate;
}

export interface VideoGenerationRequest {
  prompt: string;
  settings?: Partial<VideoGenerationSettings>;
  webhookUrl?: string;
  jobId?: string;
  correlationToken?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Provider Status & Outcomes
// ---------------------------------------------------------------------------
export type VideoProviderStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/**
 * Whether the provider may have executed (and consumed billable capacity):
 * - not_run: non-execution is established (rejected before inference, or never submitted)
 * - ran:     the provider executed (inference ran, or provider reported usage/cost)
 * - unknown: cannot tell (timeouts, network dropouts, 5xx) — requires reconciliation
 */
export type VideoProviderOutcome = "not_run" | "ran" | "unknown";

export type VideoProviderErrorCode =
  | "INVALID_REQUEST"
  | "AUTH"
  | "MODEL_NOT_FOUND"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "TIMEOUT"
  | "CANCELLED"
  | "NETWORK"
  | "UPSTREAM"
  | "CONTENT_POLICY"
  | "MALFORMED_RESPONSE"
  | "CONFIG";

/**
 * Safe-to-log normalized provider error.
 * Never leaks raw secrets, credentials, or client data.
 */
export class VideoProviderError extends Error {
  readonly code: VideoProviderErrorCode;
  readonly outcome: VideoProviderOutcome;
  readonly httpStatus: number | null;
  readonly providerCode: string | number | null;
  readonly providerJobId: string | null;

  constructor(params: {
    code: VideoProviderErrorCode;
    outcome: VideoProviderOutcome;
    message: string;
    httpStatus?: number | null;
    providerCode?: string | number | null;
    providerJobId?: string | null;
  }) {
    super(params.message);
    this.name = "VideoProviderError";
    Object.setPrototypeOf(this, VideoProviderError.prototype);
    this.code = params.code;
    this.outcome = params.outcome;
    this.httpStatus = params.httpStatus ?? null;
    this.providerCode = params.providerCode ?? null;
    this.providerJobId = params.providerJobId ?? null;
  }

  toLog() {
    return {
      name: this.name,
      code: this.code,
      outcome: this.outcome,
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      providerJobId: this.providerJobId,
      message: this.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Provider Return Data Contracts
// ---------------------------------------------------------------------------
export interface VideoSubmitResult {
  provider: string;
  model: string;
  providerJobId: string;
  status: "PENDING" | "PROCESSING";
  queuePosition?: number | null;
  estimatedSeconds?: number | null;
}

export interface CompletedVideoMetadata {
  /** Download URL or data URI of the generated MP4 */
  videoUrl: string;
  mimeType: string;
  fileSizeBytes?: number | null;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
  thumbnailUrl?: string | null;
}

export interface VideoJobStatusResult {
  providerJobId: string;
  status: VideoProviderStatus;
  metadata?: CompletedVideoMetadata | null;
  error?: {
    code: string;
    message: string;
  } | null;
  metrics?: {
    queueTimeMs?: number;
    inferenceTimeMs?: number;
    latencyMs?: number;
  } | null;
}

export interface VideoCancelResult {
  providerJobId: string;
  cancelled: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Webhook Verification Contract
// ---------------------------------------------------------------------------
export interface WebhookVerificationInput {
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  secretOrPublicKey: string;
  now?: number;
  toleranceMs?: number;
}

export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
  providerJobId?: string;
  payload?: unknown;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Pluggable Video Provider Adapter Interface
// ---------------------------------------------------------------------------
export interface VideoProviderAdapter {
  readonly id: string;
  readonly model: string;

  /**
   * Submit an asynchronous video generation job to the provider.
   * Returns immediately with a providerJobId and initial queue status.
   */
  submit(request: VideoGenerationRequest): Promise<VideoSubmitResult>;

  /**
   * Check the current execution status of a provider job.
   * Idempotent: multiple calls for the same state must return consistent data.
   */
  checkStatus(
    providerJobId: string,
    signal?: AbortSignal
  ): Promise<VideoJobStatusResult>;

  /**
   * Attempt to cancel an active or queued generation job.
   */
  cancel?(
    providerJobId: string,
    signal?: AbortSignal
  ): Promise<VideoCancelResult>;

  /**
   * Verify an incoming webhook payload and signature.
   */
  verifyWebhook?(
    input: WebhookVerificationInput
  ): Promise<WebhookVerificationResult>;
}
