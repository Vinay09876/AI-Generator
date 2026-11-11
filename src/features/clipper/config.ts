/**
 * AI Video Clipper Configuration & Business Rules.
 *
 * Centralizes all clipper domain constants, aspect ratios, dynamic bounds,
 * credit pricing formulas, storage TTLs, and per-user quotas.
 *
 * In accordance with Stage 9 architectural decisions:
 * - All limits and bounds are exposed via dynamic getter functions.
 * - Ephemeral staging storage is strictly bounded (100 MB upload ceiling, 2-hour TTL).
 * - Supported aspect ratios include 9:16 (vertical), 1:1 (square), and 16:9 (landscape).
 */

// ---------------------------------------------------------------------------
// Engine Identifiers
// ---------------------------------------------------------------------------
export const MOCK_CLIPPER_ENGINE = "mock-clipper-engine";
export const FFMPEG_CLIPPER_ENGINE = "ffmpeg-clipper-engine";
export const DEFAULT_CLIPPER_ENGINE = MOCK_CLIPPER_ENGINE;

// ---------------------------------------------------------------------------
// Supported Aspect Ratios & Framing Modes
// ---------------------------------------------------------------------------
export const CLIPPER_ASPECT_RATIOS = {
  "9:16": {
    label: "9:16 (Vertical / Reels / TikTok)",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    description: "Full vertical canvas with blurred background or tight crop",
  },
  "1:1": {
    label: "1:1 (Square / Feed)",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    description: "Square format with top/bottom blurred canvas",
  },
  "16:9": {
    label: "16:9 (Landscape / Web)",
    width: 1920,
    height: 1080,
    aspectRatio: "16:9",
    description: "Standard wide format with subtitle overlays",
  },
} as const;

export type ClipperAspectRatio = keyof typeof CLIPPER_ASPECT_RATIOS;
export const DEFAULT_CLIPPER_ASPECT_RATIO: ClipperAspectRatio = "9:16";

export const CLIPPER_FRAMING_MODES = {
  pillarbox_blur: {
    id: "pillarbox_blur",
    label: "Blurred Background",
    description: "Centered video overlay with dynamic blurred background canvas (recommended)",
  },
  center_crop: {
    id: "center_crop",
    label: "Center Crop",
    description: "Direct centered crop to canvas aspect ratio",
  },
  fit: {
    id: "fit",
    label: "Fit / Letterbox",
    description: "Fit entire video frame with solid letterbox borders",
  },
} as const;

export type ClipperFramingMode = keyof typeof CLIPPER_FRAMING_MODES;
export const DEFAULT_CLIPPER_FRAMING_MODE: ClipperFramingMode = "pillarbox_blur";

// ---------------------------------------------------------------------------
// Input Boundaries & File Size Constraints
// ---------------------------------------------------------------------------
/**
 * Maximum raw uploaded video size (50 MB, owner decision 2026-11-11).
 * Supabase Free caps individual objects at 50 MB; the project's actual bucket/global limit is
 * NOT verified and must be checked in staging. Override with CLIPPER_MAX_UPLOAD_BYTES.
 */
export const DEFAULT_MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;

/** Minimum allowed duration for a source video (15 seconds). */
export const DEFAULT_MIN_SOURCE_DURATION_SECONDS = 15;

/** Maximum allowed duration for a source video (300 seconds / 5 minutes). */
export const DEFAULT_MAX_SOURCE_DURATION_SECONDS = 300;

/** Minimum allowed duration for an individual exported clip (5 seconds). */
export const DEFAULT_MIN_CLIP_DURATION_SECONDS = 5;

/** Maximum allowed duration for an individual exported clip (60 seconds). */
export const DEFAULT_MAX_CLIP_DURATION_SECONDS = 60;

/** Default target duration for an automated highlight clip (30 seconds). */
export const DEFAULT_TARGET_CLIP_DURATION_SECONDS = 30;

/** Maximum number of candidate clips generated per clipping job. */
export const DEFAULT_MAX_CLIPS_PER_JOB = 3;

/** Maximum video width allowed for input video (1080p width). */
export const DEFAULT_MAX_SOURCE_WIDTH = 1920;

/** Maximum video height allowed for input video (1080p height). */
export const DEFAULT_MAX_SOURCE_HEIGHT = 1080;

/** Minimum video width required (480p width). */
export const DEFAULT_MIN_SOURCE_WIDTH = 480;

/** Minimum video height required (360p height). */
export const DEFAULT_MIN_SOURCE_HEIGHT = 360;

// ---------------------------------------------------------------------------
// Dynamic Threshold Resolvers
// ---------------------------------------------------------------------------
export function getClipperMaxUploadBytes(): number {
  const envVal = process.env.CLIPPER_MAX_UPLOAD_BYTES;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_UPLOAD_SIZE_BYTES;
}

export function getClipperMinSourceDurationSeconds(): number {
  const envVal = process.env.CLIPPER_MIN_SOURCE_DURATION_SECONDS;
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MIN_SOURCE_DURATION_SECONDS;
}

export function getClipperMaxSourceDurationSeconds(): number {
  const envVal = process.env.CLIPPER_MAX_SOURCE_DURATION_SECONDS;
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_SOURCE_DURATION_SECONDS;
}

export function getClipperMaxClipsPerJob(): number {
  const envVal = process.env.CLIPPER_MAX_CLIPS_PER_JOB;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_CLIPS_PER_JOB;
}

// ---------------------------------------------------------------------------
// Supported MIME Types & Containers
// ---------------------------------------------------------------------------
export const ALLOWED_CLIPPER_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;

export type AllowedClipperMimeType = (typeof ALLOWED_CLIPPER_MIME_TYPES)[number];

export const ALLOWED_FILE_EXTENSIONS = [".mp4", ".mov", ".webm"] as const;

// ---------------------------------------------------------------------------
// Storage TTLs, Quotas & Retention
// ---------------------------------------------------------------------------
/** Ephemeral staging TTL for raw source uploads (2 hours in seconds). */
export const EPHEMERAL_UPLOAD_TTL_SECONDS = 7200;

/** Maximum total temporary staging bytes allowed per user at any time (200 MB). */
export const EPHEMERAL_USER_STAGING_QUOTA_BYTES = 200 * 1024 * 1024;

/** Temporary signed URL validity for asset streaming (10 minutes in seconds). */
export const CLIPPER_SIGNED_URL_EXPIRY_SECONDS = 600;

/** Maximum size for an individual exported clip file (30 MB). */
export const MAX_STORED_CLIP_BYTES = 30 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Rendering Pipeline (Batch 4)
// ---------------------------------------------------------------------------
/** Maximum size for a stored clip poster thumbnail (1 MB). */
export const MAX_STORED_CLIP_THUMBNAIL_BYTES = 1 * 1024 * 1024;

/** Poster thumbnail width in pixels (height follows the clip aspect ratio). */
export const CLIPPER_THUMBNAIL_WIDTH = 540;

/** Allowed absolute difference between requested and rendered clip duration. */
export const CLIPPER_OUTPUT_DURATION_TOLERANCE_SECONDS = 0.5;

/** Output frame rate ceiling; sources above it are resampled down. */
export const CLIPPER_MAX_OUTPUT_FPS = 30;

/** AAC audio bitrate for rendered clips (kbit/s). */
export const CLIPPER_AUDIO_BITRATE_KBPS = 128;

/** EBU R128 single-pass loudness target for short-form social video. */
export const CLIPPER_LOUDNORM = { integratedLufs: -14, truePeakDb: -1.5, loudnessRange: 11 } as const;

/** Default FFmpeg render timeout (10 minutes). Unbenchmarked safety ceiling, not a performance estimate. */
export const DEFAULT_CLIPPER_RENDER_TIMEOUT_MS = 10 * 60 * 1000;

/** Default FFmpeg thread cap per render process. */
export const DEFAULT_CLIPPER_FFMPEG_THREADS = 2;

export function getClipperRenderTimeoutMs(): number {
  const parsed = parseInt(process.env.CLIPPER_RENDER_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_CLIPPER_RENDER_TIMEOUT_MS;
}

export function getClipperFfmpegThreads(): number {
  const parsed = parseInt(process.env.CLIPPER_FFMPEG_THREADS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 16 ? parsed : DEFAULT_CLIPPER_FFMPEG_THREADS;
}

/**
 * Video bitrate ceiling (kbit/s) chosen so that a maximum-length clip stays within
 * MAX_STORED_CLIP_BYTES with ~10% container/VBV headroom.
 */
export function getClipperVideoMaxrateKbps(): number {
  const totalKbps = (MAX_STORED_CLIP_BYTES * 8 * 0.9) / DEFAULT_MAX_CLIP_DURATION_SECONDS / 1000;
  return Math.max(500, Math.floor(totalKbps - CLIPPER_AUDIO_BITRATE_KBPS));
}

// ---------------------------------------------------------------------------
// Analysis Capabilities (Batch 5, owner decision A)
// ---------------------------------------------------------------------------
/**
 * No transcription engine is integrated. Clips are chosen by scene cuts and pacing (silence
 * detection is acoustic only — no speech is recognised). Original audio is preserved.
 * Speech-based scoring and captions stay unavailable until a real transcriber exists.
 * This object is persisted on every job and returned by the API so the limitation is explicit.
 */
export const CLIPPER_ANALYSIS_CAPABILITIES = {
  highlightMode: "scene_pacing",
  speechAnalysis: "unavailable",
  captions: "unavailable",
  originalAudio: "preserved",
} as const;

export type ClipperAnalysisCapabilities = typeof CLIPPER_ANALYSIS_CAPABILITIES;

// ---------------------------------------------------------------------------
// Upload Workflow & Maintenance (Batch 5)
// ---------------------------------------------------------------------------
/** At most this many uploads not attached to an active job may exist per user. */
export const MAX_PENDING_UPLOADS_PER_USER = 1;

/**
 * Hard ceiling on objects in one user's upload folder. Quota listing that reaches it cannot
 * prove completeness and therefore FAILS CLOSED.
 */
export const CLIPPER_UPLOAD_LISTING_MAX_OBJECTS = 20;

/** Timeout for each individual storage operation in the upload/quota path. */
export const CLIPPER_STORAGE_OP_TIMEOUT_MS = 5_000;

/** Uploads must be used for a job within TTL minus this margin (so the sweep cannot race it). */
export const CLIPPER_UPLOAD_USE_MARGIN_SECONDS = 15 * 60;

/** Bytes read from the start of an upload for container signature verification. */
export const CLIPPER_UPLOAD_SIGNATURE_BYTES = 64;

/** Queue wait allowed before an unclaimed PENDING clip job is failed + refunded. */
export const CLIPPER_QUEUE_WAIT_STALE_MS = 30 * 60 * 1000;

/** Per-run bounds for the maintenance cron. */
export const CLIPPER_MAINTENANCE_LIMITS = {
  cleanupRetryJobs: 20,
  sweepUserFolders: 50,
  sweepDeletes: 100,
} as const;

/** Client polling cadence hint for clip jobs (seconds). */
export const CLIPPER_POLL_AFTER_SECONDS = 5;

// ---------------------------------------------------------------------------
// Credit Pricing & Daily Quotas
// ---------------------------------------------------------------------------
/** Base credit cost per individual rendered clip asset (5 credits). */
export const DEFAULT_CREDIT_COST_PER_CLIP = 5;

/** Base job initialization cost (0 credits; user is billed per completed clip). */
export const DEFAULT_CLIPPER_JOB_BASE_COST = 0;

export interface ClipperPricingParams {
  clipsCount?: number;
  durationSeconds?: number;
}

/**
 * Resolves total credit cost for a video clipping job.
 * Default: 5 credits per rendered clip.
 */
export function getClipperCreditCost(params?: ClipperPricingParams): number {
  const count = params?.clipsCount ?? 1;
  const safeCount = Math.max(1, Math.min(count, getClipperMaxClipsPerJob()));
  return safeCount * DEFAULT_CREDIT_COST_PER_CLIP;
}

/** Daily limit of clipping generation jobs per user on promotional accounts. */
export const DEFAULT_DAILY_USER_CLIP_LIMIT = 2;
export const PROVISIONAL_QA_DAILY_CLIP_LIMIT = 10;
export const PROVISIONAL_PAID_DAILY_CLIP_LIMIT = 50;

export type ClipperUserTier = "promotional" | "qa" | "paid";

export function getDailyUserClipLimit(tier: unknown = "promotional"): number {
  if (tier === "qa") return PROVISIONAL_QA_DAILY_CLIP_LIMIT;
  if (tier === "paid") return PROVISIONAL_PAID_DAILY_CLIP_LIMIT;
  return DEFAULT_DAILY_USER_CLIP_LIMIT;
}

// ---------------------------------------------------------------------------
// Subtitle & Karaoke Styling Defaults
// ---------------------------------------------------------------------------
export const SUBTITLE_DEFAULTS = {
  fontName: "Inter",
  fontSize: 52,
  primaryColor: "&H00FFFFFF", // White text (AABBGGRR in ASS)
  secondaryColor: "&H0000FFFF", // Yellow/Gold karaoke highlight
  outlineColor: "&H00000000", // Black border/outline
  backColor: "&H80000000", // Semi-transparent shadow
  bold: true,
  outlineWidth: 3.5,
  shadowDepth: 1.5,
  alignment: 2, // Centered bottom
  marginV: 180, // Vertical margin from bottom
  maxWordsPerSegment: 4,
} as const;
