import {
  VIDEO_POLL_INTERVAL_MS,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoResolution,
  type VideoFrameRate,
} from "./config";

/**
 * Client-facing shape of a video generation job. Pure mapping (no database access):
 * internal fields (raw provider payloads, internal storage keys, provider keys)
 * are never exposed to the client.
 */

export interface VideoJobRecord {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  prompt: string | null;
  settings: unknown;
  chargedCredits: number;
  estimatedCredits: number;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  assets?: {
    id: string;
    width: number | null;
    height: number | null;
    mimeType: string | null;
    fileSize: bigint | null;
    durationSeconds: number | null;
    thumbnailKey?: string | null;
  }[];
}

export type VideoFailureReason = "SERVICE_BUSY" | "PROMPT_REJECTED" | "TIMED_OUT" | "FAILED";

export interface VideoJobView {
  id: string;
  status: VideoJobRecord["status"];
  prompt: string | null;
  aspectRatio: VideoAspectRatio | null;
  durationSeconds: VideoDuration | null;
  resolution: VideoResolution | null;
  frameRate: VideoFrameRate | null;
  creditsCharged: number;
  estimatedCredits: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** True while awaiting asynchronous webhook recovery or background reconciliation. */
  outcomeUnknown: boolean;
  error: {
    code: "GENERATION_FAILED";
    reason: VideoFailureReason;
    message: string;
    refunded: boolean;
  } | null;
}

export interface VideoAssetView {
  id: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface VideoJobResponseBody {
  job: VideoJobView;
  asset: VideoAssetView | null;
  replayed: boolean;
  balance: number | null;
}

const FAILURE_MESSAGES: Record<VideoFailureReason, string> = {
  SERVICE_BUSY: "The video generation service is busy right now. Your credits were refunded — please try again later.",
  PROMPT_REJECTED: "This prompt couldn't be processed by the video model. Your credits were refunded.",
  TIMED_OUT: "The video generation took too long and timed out. Your credits were refunded.",
  FAILED: "The video couldn't be generated. Your credits were refunded.",
};

export const VIDEO_POLL_AFTER_SECONDS = Math.round(VIDEO_POLL_INTERVAL_MS / 1000); // 4 seconds

/**
 * Maps internal error message to a user-safe category.
 * Unknown codes fall back to FAILED.
 */
export function failureReasonFor(errorMessage: string | null): VideoFailureReason {
  const m = errorMessage ?? "";
  if (/^(provider_not_run|provider_unknown):(RATE_LIMITED|UPSTREAM|SERVICE_UNAVAILABLE)/.test(m)) {
    return "SERVICE_BUSY";
  }
  if (/^(provider_not_run|provider_unknown):(INVALID_REQUEST|CONTENT_POLICY)/.test(m)) {
    return "PROMPT_REJECTED";
  }
  if (
    m.includes("TIMEOUT") ||
    m.includes("timed out") ||
    m.includes("did not start in time")
  ) {
    return "TIMED_OUT";
  }
  return "FAILED";
}

export function isJobInProgress(status: VideoJobRecord["status"]): boolean {
  return status === "PENDING" || status === "PROCESSING";
}

/**
 * Transforms an internal VideoJobRecord to the sanitized client view.
 */
export function toVideoJobView(
  record: VideoJobRecord,
  signedUrls?: { videoUrl?: string; thumbnailUrl?: string | null },
): { job: VideoJobView; asset: VideoAssetView | null } {
  const settings = (record.settings as Record<string, unknown> | null) ?? {};
  const failed = record.status === "FAILED" || record.status === "CANCELLED";
  const reason = failed ? failureReasonFor(record.errorMessage) : null;
  const isSubmissionAmbiguous =
    record.status === "PROCESSING" &&
    (settings.submission as { state?: string } | undefined)?.state === "ambiguous";

  const firstAsset = record.status === "COMPLETED" && record.assets && record.assets.length > 0
    ? record.assets[0]
    : undefined;

  const job: VideoJobView = {
    id: record.id,
    status: record.status,
    prompt: record.prompt,
    aspectRatio: (settings.aspectRatio as VideoAspectRatio) ?? "16:9",
    durationSeconds: ((settings.duration ?? settings.durationSeconds) as VideoDuration) ?? 5,
    resolution: (settings.resolution as VideoResolution) ?? "720p",
    frameRate: ((settings.fps ?? settings.frameRate) as VideoFrameRate) ?? 16,
    creditsCharged: record.chargedCredits,
    estimatedCredits: record.estimatedCredits,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    outcomeUnknown: isSubmissionAmbiguous,
    error: reason
      ? {
          code: "GENERATION_FAILED",
          reason,
          message: FAILURE_MESSAGES[reason],
          refunded: true,
        }
      : null,
  };

  const asset: VideoAssetView | null = firstAsset && signedUrls?.videoUrl
    ? {
        id: firstAsset.id,
        videoUrl: signedUrls.videoUrl,
        thumbnailUrl: signedUrls.thumbnailUrl ?? null,
        durationSeconds: firstAsset.durationSeconds,
        width: firstAsset.width,
        height: firstAsset.height,
        mimeType: firstAsset.mimeType,
        sizeBytes: firstAsset.fileSize !== null ? Number(firstAsset.fileSize) : null,
      }
    : null;

  return { job, asset };
}

/**
 * HTTP status for a video job response:
 *  - in progress -> 202 for submission/replayed in-flight, 200 for fetched polling
 *  - fresh COMPLETED -> 201; fresh FAILED (refunded) -> 502
 *  - replayed/fetched COMPLETED or FAILED -> 200
 */
export function videoJobResponseStatus(
  status: VideoJobRecord["status"],
  mode: "created" | "replayed" | "fetched",
): number {
  if (isJobInProgress(status)) return mode === "fetched" ? 200 : 202;
  if (mode !== "created") return 200;
  return status === "COMPLETED" ? 201 : 502;
}
