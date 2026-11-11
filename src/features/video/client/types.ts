import type { VideoAspectRatio, VideoDuration, VideoResolution, VideoFrameRate } from "../config";
import type { VideoAssetView, VideoJobResponseBody, VideoJobView } from "../job-view";

export const VIDEO_API_ERROR_CODES = [
  "INVALID_INPUT",
  "UNAUTHENTICATED",
  "INSUFFICIENT_CREDITS",
  "FORBIDDEN",
  "FORBIDDEN_ORIGIN",
  "ACTIVE_JOB_EXISTS",
  "IDEMPOTENCY_CONFLICT",
  "DAILY_LIMIT_REACHED",
  "CAPACITY_EXHAUSTED",
  "UPSTREAM_REJECTED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
  "NOT_FOUND",
  "NETWORK_ERROR",
  "TIMEOUT",
  "ABORTED",
  "UNKNOWN",
] as const;

export type VideoApiErrorCode = (typeof VIDEO_API_ERROR_CODES)[number];

export interface VideoClientError {
  code: VideoApiErrorCode;
  message: string;
  retryAfterSeconds: number | null;
  resetAt: string | null;
  isTerminal: boolean;
}

export type VideoGenerationState =
  | { phase: "idle" }
  | {
      phase: "submitting";
      prompt: string;
      aspectRatio: VideoAspectRatio;
      startedAt: number;
    }
  | {
      phase: "polling";
      jobId: string;
      prompt: string;
      aspectRatio: VideoAspectRatio;
      startedAt: number;
      consecutiveFailures: number;
      outcomeUnknown: boolean;
      lastJob?: VideoJobView;
    }
  | {
      phase: "completed";
      job: VideoJobView;
      asset: VideoAssetView;
    }
  | {
      phase: "failed";
      job: VideoJobView | null;
      error: VideoClientError;
    };

export type VideoGenerationPhase = VideoGenerationState["phase"];

export interface SubmitVideoInput {
  prompt: string;
  aspectRatio?: VideoAspectRatio;
  durationSeconds?: VideoDuration;
  resolution?: VideoResolution;
  frameRate?: VideoFrameRate;
  idempotencyKey?: string;
}

export interface VideoApiResult {
  kind: "job" | "error" | "network" | "aborted";
  httpStatus?: number;
  body?: VideoJobResponseBody;
  error?: VideoClientError;
  retryAfterSeconds?: number | null;
  idempotencyKey?: string | null;
}
