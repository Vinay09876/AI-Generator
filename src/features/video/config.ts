/**
 * Video Generation Configuration & Business Rules.
 *
 * All pricing and quota values are identified as configurable defaults.
 * Any future commercial adjustments should be updated via this configuration module.
 */

// ---------------------------------------------------------------------------
// Provider & Model Constants
// ---------------------------------------------------------------------------
export const DEFAULT_VIDEO_PROVIDER = "fal-ai";
export const DEFAULT_VIDEO_MODEL = "fal-ai/wan/v2.1/t2v-720p";

export const MOCK_VIDEO_PROVIDER = "mock-video-provider";
export const MOCK_VIDEO_MODEL = "mock-wan-2.1-720p";

// ---------------------------------------------------------------------------
// Supported Settings & Aspect Ratios
// ---------------------------------------------------------------------------
export const VIDEO_ASPECT_RATIOS = {
  "16:9": {
    label: "16:9 (Landscape)",
    width: 1280,
    height: 720,
    aspectRatio: "16:9",
  },
  "9:16": {
    label: "9:16 (Portrait / Reels)",
    width: 720,
    height: 1280,
    aspectRatio: "9:16",
  },
  "1:1": {
    label: "1:1 (Square)",
    width: 960,
    height: 960,
    aspectRatio: "1:1",
  },
} as const;

export type VideoAspectRatio = keyof typeof VIDEO_ASPECT_RATIOS;

export const VIDEO_DURATIONS = {
  5: {
    label: "5 seconds",
    seconds: 5,
  },
} as const;

export type VideoDuration = keyof typeof VIDEO_DURATIONS;

export const VIDEO_RESOLUTIONS = {
  "720p": {
    label: "720p HD",
    verticalPixels: 720,
  },
} as const;

export type VideoResolution = keyof typeof VIDEO_RESOLUTIONS;

export const VIDEO_FRAME_RATES = {
  16: {
    label: "16 fps",
    fps: 16,
  },
} as const;

export type VideoFrameRate = keyof typeof VIDEO_FRAME_RATES;

export const DEFAULT_VIDEO_SETTINGS = {
  aspectRatio: "16:9" as VideoAspectRatio,
  duration: 5 as VideoDuration,
  resolution: "720p" as VideoResolution,
  fps: 16 as VideoFrameRate,
} as const;

// ---------------------------------------------------------------------------
// Configurable Credit Pricing
// ---------------------------------------------------------------------------
/**
 * Proposed initial default: 10 promotional credits per 5-second 720p video.
 * Corresponds to roughly $0.30 provider inference cost at $0.06/sec.
 * Identified as a configurable default, not an immutable business rule.
 */
export const DEFAULT_VIDEO_CREDIT_COST = 10;

export interface VideoPricingParams {
  duration?: VideoDuration;
  resolution?: VideoResolution;
  aspectRatio?: VideoAspectRatio;
}

/**
 * Resolves the credit cost for a video generation request.
 * Centralizes pricing calculations so future tiers or promotional rules can be adjusted here.
 */
export function getVideoCreditCost(params?: VideoPricingParams): number {
  if (!params) {
    return DEFAULT_VIDEO_CREDIT_COST;
  }
  // Default tier pricing (10 credits for 5s 720p)
  return DEFAULT_VIDEO_CREDIT_COST;
}

// ---------------------------------------------------------------------------
// Quotas & Input Boundaries
// ---------------------------------------------------------------------------
/**
 * Authoritative daily limit for video generations per user per UTC day on promotional accounts.
 * Mandated limit: exactly 1 video per UTC day for promotional accounts to strictly
 * cap infrastructure expenses and financial exposure.
 */
export const DEFAULT_DAILY_USER_VIDEO_LIMIT = 1;

/**
 * Provisional configurable limits for testing and future commercial tiers.
 * These are provisional defaults, not active subscriptions.
 */
export const PROVISIONAL_QA_DAILY_VIDEO_LIMIT = 10;
export const PROVISIONAL_PAID_DAILY_VIDEO_LIMIT = 50;

export type VideoUserTier = "promotional" | "qa" | "paid";

/**
 * Resolves the daily video generation limit for an authorized tier.
 * Unrecognized or unknown tiers strictly fail closed to DEFAULT_DAILY_USER_VIDEO_LIMIT (1).
 */
export function getDailyUserVideoLimit(tier: unknown = "promotional"): number {
  if (tier === "qa") {
    return PROVISIONAL_QA_DAILY_VIDEO_LIMIT;
  }
  if (tier === "paid") {
    return PROVISIONAL_PAID_DAILY_VIDEO_LIMIT;
  }
  // All other inputs (promotional, unknown, null, malformed) fail closed to promotional limit
  return DEFAULT_DAILY_USER_VIDEO_LIMIT;
}

export const VIDEO_PROMPT_MIN_LENGTH = 1;
export const VIDEO_PROMPT_MAX_LENGTH = 2048;

// ---------------------------------------------------------------------------
// File Size & Storage Limits
// ---------------------------------------------------------------------------
/** Max raw provider video response body accepted (35 MB). */
export const MAX_PROVIDER_VIDEO_BYTES = 35 * 1024 * 1024;

/** Max stored MP4 asset file size (35 MB). */
export const MAX_STORED_VIDEO_BYTES = 35 * 1024 * 1024;

/** Max stored thumbnail WebP poster frame file size (1 MB). */
export const MAX_STORED_THUMBNAIL_BYTES = 1 * 1024 * 1024;

export const STORED_VIDEO_MIME = "video/mp4";
export const STORED_THUMBNAIL_MIME = "image/webp";

/** Signed URL lifetime for video asset downloads and streaming (10 minutes). */
export const VIDEO_SIGNED_URL_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// Timing & Reconciliation Invariants
// ---------------------------------------------------------------------------
/**
 * Inactive/stale PENDING job threshold for automated refund reconciliation.
 * If a job remains in PENDING for longer than this without starting, it is reconciled as FAILED.
 */
export const VIDEO_PENDING_STALE_MS = 5 * 60_000;

/**
 * Provider-side wait timeout before aborting synchronous or polling waits.
 * Wan 2.1 inference typically completes in 60-90s; timeout is 120s.
 */
export const VIDEO_PROVIDER_TIMEOUT_MS = 120_000;

/**
 * Atomic ingestion lease lifetime.
 * If a worker crashes mid-stream, the lease expires after 5 minutes,
 * allowing subsequent polling or reconciliation to reclaim ingestion.
 */
export const VIDEO_INGESTION_LEASE_MS = 5 * 60_000;

/**
 * Inactive/stale PROCESSING job threshold for automated refund reconciliation.
 * Must strictly exceed VIDEO_PROVIDER_TIMEOUT_MS and VIDEO_INGESTION_LEASE_MS.
 */
export const VIDEO_PROCESSING_STALE_MS = 15 * 60_000;

/** Client recommended polling interval for pending/processing video jobs (4 seconds). */
export const VIDEO_POLL_INTERVAL_MS = 4_000;

/** Webhook timestamp freshness tolerance to prevent replay attacks (5 minutes). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Runtime Validation Helpers
// ---------------------------------------------------------------------------
export function isSupportedVideoAspectRatio(value: unknown): value is VideoAspectRatio {
  return typeof value === "string" && Object.hasOwn(VIDEO_ASPECT_RATIOS, value);
}

export function isSupportedVideoDuration(value: unknown): value is VideoDuration {
  return typeof value === "number" && Object.hasOwn(VIDEO_DURATIONS, value);
}

export function isSupportedVideoResolution(value: unknown): value is VideoResolution {
  return typeof value === "string" && Object.hasOwn(VIDEO_RESOLUTIONS, value);
}

export function isSupportedVideoFrameRate(value: unknown): value is VideoFrameRate {
  return typeof value === "number" && Object.hasOwn(VIDEO_FRAME_RATES, value);
}

export interface PromptValidationResult {
  valid: boolean;
  error?: string;
  cleaned?: string;
}

export function validateVideoPrompt(prompt: unknown): PromptValidationResult {
  if (typeof prompt !== "string") {
    return { valid: false, error: "Prompt must be a string." };
  }

  const cleaned = prompt.trim();
  if (cleaned.length < VIDEO_PROMPT_MIN_LENGTH) {
    return { valid: false, error: "Prompt cannot be empty." };
  }

  if (cleaned.length > VIDEO_PROMPT_MAX_LENGTH) {
    return {
      valid: false,
      error: `Prompt exceeds maximum length of ${VIDEO_PROMPT_MAX_LENGTH} characters.`,
    };
  }

  return { valid: true, cleaned };
}

