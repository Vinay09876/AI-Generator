/**
 * Pure presentation logic for the /video-clipper UI (Batch 6). Browser-safe, no React.
 *
 * Honesty rules encoded here (and tested):
 *   - The only percentage ever shown is real upload progress (bytes sent / file size).
 *   - "Processing" is shown only after the server reports that a worker started the job
 *     (status PROCESSING). A PENDING job is "Queued, waiting for a worker".
 *   - The operator submission switch is never described as worker liveness.
 *   - Speech analysis and captions are reported unavailable whenever the API says so.
 */

import type { ClipJobView } from "../job-view";
import type { ClipperClientState } from "./controller";

export interface ClipperLimitsView {
  maxUploadBytes: number;
  minSourceSeconds: number;
  maxSourceSeconds: number;
  minLongEdge: number;
  minShortEdge: number;
  maxLongEdge: number;
  maxShortEdge: number;
  maxPixels: number;
  maxClips: number;
  creditsPerClip: number;
  mimeTypes: readonly string[];
  extensions: readonly string[];
  clipDuration: { targetSeconds: number; minSeconds: number; maxSeconds: number };
  queueTimeoutMinutes: number;
}

/** After this long in the queue the UI says plainly that no worker has picked the job up yet. */
export const QUEUE_ESCALATION_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** 75 → "1:15", 3600 → "60:00". */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Elapsed wall time as "45 s", "3 min", "1 h 5 min". */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const clipCost = (clipCount: number, creditsPerClip: number) => Math.max(0, Math.floor(clipCount)) * creditsPerClip;

// ---------------------------------------------------------------------------
// Local (pre-upload) checks — convenience only; the server and worker decide.
// ---------------------------------------------------------------------------
const EXTENSION_MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

export type LocalCheck = { ok: true; mimeType: string } | { ok: false; code: string; message: string };

export function checkLocalFile(file: { name: string; type: string; size: number }, limits: ClipperLimitsView): LocalCheck {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  const allowedExt = limits.extensions.includes(ext);
  // Some browsers report an empty type (e.g. .mov on Windows); fall back to the extension.
  const mimeType = file.type ? file.type.toLowerCase() : allowedExt ? EXTENSION_MIME[ext] ?? "" : "";
  if (!allowedExt || !limits.mimeTypes.includes(mimeType)) {
    return { ok: false, code: "UNSUPPORTED_FILE", message: "Choose an MP4, MOV or WebM video." };
  }
  if (file.size <= 0) return { ok: false, code: "EMPTY_FILE", message: "This file is empty." };
  if (file.size > limits.maxUploadBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `This file is ${formatBytes(file.size)}. The maximum is ${formatBytes(limits.maxUploadBytes)}.`,
    };
  }
  return { ok: true, mimeType };
}

export interface LocalVideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
}

export function checkLocalMetadata(meta: LocalVideoMetadata | null, limits: ClipperLimitsView): { ok: true } | { ok: false; code: string; message: string } {
  if (!meta || !Number.isFinite(meta.durationSeconds) || meta.durationSeconds <= 0) {
    return {
      ok: false,
      code: "METADATA_UNREADABLE",
      message: "Your browser couldn't read this video's length, which is needed to submit it. Try an MP4 (H.264) file.",
    };
  }
  if (meta.durationSeconds < limits.minSourceSeconds || meta.durationSeconds > limits.maxSourceSeconds) {
    return {
      ok: false,
      code: "DURATION_OUT_OF_RANGE",
      message: `This video is ${formatClock(meta.durationSeconds)} long. Videos must be ${formatClock(limits.minSourceSeconds)}–${formatClock(limits.maxSourceSeconds)}.`,
    };
  }
  if (meta.width > 0 && meta.height > 0) {
    // Same orientation-neutral rule as the server (portrait, landscape and square alike).
    const long = Math.max(meta.width, meta.height);
    const short = Math.min(meta.width, meta.height);
    if (long > limits.maxLongEdge || short > limits.maxShortEdge || meta.width * meta.height > limits.maxPixels) {
      return {
        ok: false,
        code: "RESOLUTION_TOO_HIGH",
        message: `This video is ${meta.width}×${meta.height}. The maximum is ${limits.maxLongEdge}×${limits.maxShortEdge} in any orientation (1080p).`,
      };
    }
    if (long < limits.minLongEdge || short < limits.minShortEdge) {
      return {
        ok: false,
        code: "RESOLUTION_TOO_LOW",
        message: `This video is ${meta.width}×${meta.height}. The minimum is ${limits.minLongEdge}×${limits.minShortEdge} in any orientation.`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Submission blockers (checked before any reservation)
// ---------------------------------------------------------------------------
export type SubmitBlocker = { code: string; message: string } | null;

export function getSubmitBlocker(p: {
  submissionsEnabled: boolean;
  balance: number;
  cost: number;
  dailyUsed: number;
  dailyLimit: number;
  hasFile: boolean;
  fileError: string | null;
}): SubmitBlocker {
  if (!p.submissionsEnabled) return { code: "CLIPPER_UNAVAILABLE", message: "New clipping jobs are switched off right now." };
  if (p.dailyUsed >= p.dailyLimit) return { code: "DAILY_LIMIT_REACHED", message: "You've used today's clipping jobs. The limit resets at 00:00 UTC." };
  if (p.balance < p.cost) return { code: "INSUFFICIENT_CREDITS", message: `This needs ${p.cost} credits; you have ${p.balance}.` };
  if (!p.hasFile) return { code: "NO_FILE", message: "Choose a video to continue." };
  if (p.fileError) return { code: "FILE_INVALID", message: p.fileError };
  return null;
}

// ---------------------------------------------------------------------------
// Error presentation
// ---------------------------------------------------------------------------
export type ErrorAction = "retry" | "choose_file" | "sign_in" | "refresh" | "release_pending" | "none";

const ERRORS: Record<string, { title: string; action: ErrorAction; message?: string }> = {
  UNAUTHENTICATED: { title: "Session expired", action: "sign_in", message: "Please sign in again to continue." },
  CLIPPER_UNAVAILABLE: { title: "Submissions are off", action: "none" },
  UPLOAD_PENDING_EXISTS: {
    title: "A previous upload is still reserved",
    action: "release_pending",
    message:
      "Another upload is still reserved for your account, for example from another tab, another device or an interrupted upload. If it's still running somewhere, let it finish there. Otherwise release it below and try again. Unused uploads are also removed automatically within 2 hours.",
  },
  STAGING_QUOTA_EXCEEDED: { title: "Temporary storage is full", action: "refresh" },
  QUOTA_UNVERIFIABLE: { title: "Couldn't check your upload allowance", action: "retry" },
  STORAGE_UNAVAILABLE: { title: "Storage is unavailable", action: "retry" },
  UPLOAD_REJECTED: { title: "Upload rejected", action: "retry" },
  NETWORK_ERROR: { title: "Connection lost", action: "retry" },
  UPLOAD_TOO_LARGE: { title: "File too large", action: "choose_file" },
  UPLOAD_INVALID_CONTAINER: { title: "Unsupported video", action: "choose_file" },
  UPLOAD_INCOMPLETE: { title: "Upload incomplete", action: "retry" },
  UPLOAD_EXPIRED: { title: "Upload expired", action: "choose_file" },
  UPLOAD_NOT_FOUND: { title: "Upload not found", action: "choose_file" },
  UPLOAD_ALREADY_USED: { title: "Upload already used", action: "choose_file" },
  INVALID_INPUT: { title: "Request not accepted", action: "choose_file" },
  SOURCE_DURATION_OUT_OF_RANGE: { title: "Video length not supported", action: "choose_file" },
  CAPTIONS_UNAVAILABLE: { title: "Captions unavailable", action: "none" },
  INSUFFICIENT_CREDITS: { title: "Not enough credits", action: "none" },
  DAILY_LIMIT_REACHED: { title: "Daily limit reached", action: "none" },
  ACTIVE_JOB_EXISTS: {
    title: "Another generation is running",
    action: "refresh",
    message: "You can run one generation at a time (image, video or clips). Wait for it to finish, then try again.",
  },
  RATE_LIMITED: { title: "Too many requests", action: "retry" },
  STATUS_UNKNOWN: { title: "Status not confirmed", action: "refresh" },
  INSUFFICIENT_HIGHLIGHTS: { title: "Not enough distinct moments", action: "choose_file" },
  SOURCE_TOO_SHORT: { title: "Video too short", action: "choose_file" },
  SOURCE_TOO_LONG: { title: "Video too long", action: "choose_file" },
  RENDER_TIMEOUT: { title: "Rendering took too long", action: "retry" },
  WORKER_SHUTDOWN: { title: "Processing was interrupted", action: "retry" },
  NOT_FOUND: { title: "Job not found", action: "none" },
};

export function presentError(code: string, serverMessage?: string | null): { title: string; message: string; action: ErrorAction } {
  const known = ERRORS[code];
  const message = known?.message ?? (serverMessage && serverMessage.trim() ? serverMessage : "Something went wrong. Please try again.");
  return { title: known?.title ?? "Video clipping failed", message, action: known?.action ?? "retry" };
}

// ---------------------------------------------------------------------------
// Status panel
// ---------------------------------------------------------------------------
export type StatusTone = "neutral" | "progress" | "success" | "warning" | "danger";

export interface StatusView {
  kind:
    | "idle"
    | "uploading"
    | "verifying"
    | "submitting"
    | "checking"
    | "queued"
    | "queued_long"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  title: string;
  detail: string;
  tone: StatusTone;
  /** Real upload progress only; null in every other phase. */
  uploadPercent: number | null;
  elapsedLabel: string | null;
  canCancelUpload: boolean;
  canCancelQueued: boolean;
  error: { code: string; title: string; message: string; action: ErrorAction } | null;
}

const base = (v: Partial<StatusView> & Pick<StatusView, "kind" | "title" | "detail" | "tone">): StatusView => ({
  uploadPercent: null,
  elapsedLabel: null,
  canCancelUpload: false,
  canCancelQueued: false,
  error: null,
  ...v,
});

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

export function describeJobProgress(job: ClipJobView, nowMs: number, limits: Pick<ClipperLimitsView, "queueTimeoutMinutes">): StatusView {
  if (job.status === "PROCESSING") {
    const startedAt = ms(job.startedAt);
    return base({
      kind: "processing",
      tone: "progress",
      title: "Processing",
      detail: "A worker picked up your job and is finding scene changes and rendering clips. You can leave this page; your clips will be here when you come back.",
      elapsedLabel: startedAt !== null ? `Started ${formatElapsed(nowMs - startedAt)} ago` : null,
    });
  }
  const createdAt = ms(job.createdAt);
  const waited = createdAt !== null ? nowMs - createdAt : 0;
  const long = waited >= QUEUE_ESCALATION_MS;
  return base({
    kind: long ? "queued_long" : "queued",
    tone: long ? "warning" : "neutral",
    title: long ? "Not picked up yet" : "Queued, waiting for a worker",
    detail: long
      ? `No worker has started this job yet. Clips are made by a separate worker that may not be running right now. You can cancel for a full refund; jobs still queued after ${limits.queueTimeoutMinutes} minutes are also failed and refunded by scheduled maintenance.`
      : "Your credits are reserved. Processing starts when a worker picks up the job; until then nothing is being rendered.",
    elapsedLabel: createdAt !== null ? `Waiting ${formatElapsed(waited)}` : null,
    canCancelQueued: true,
  });
}

export function describeClipperState(state: ClipperClientState, nowMs: number, limits: Pick<ClipperLimitsView, "queueTimeoutMinutes">): StatusView {
  switch (state.phase) {
    case "idle":
      return base({ kind: "idle", tone: "neutral", title: "Ready", detail: "Choose a video to get started." });
    case "uploading": {
      const pct = Math.max(0, Math.min(100, Math.floor(state.progress * 100)));
      return base({ kind: "uploading", tone: "progress", title: "Uploading", detail: "Sending your video to private storage.", uploadPercent: pct, canCancelUpload: true });
    }
    case "verifying":
      return base({ kind: "verifying", tone: "progress", title: "Checking your video", detail: "Confirming the upload's size and format.", canCancelUpload: true });
    case "submitting":
      return base({
        kind: "submitting",
        tone: "progress",
        title: "Creating your job",
        detail:
          state.attempt > 1
            ? `The connection is unstable, so we're retrying safely (attempt ${state.attempt}). You can't be charged twice for this request.`
            : "Reserving credits and adding your job to the queue.",
      });
    case "processing":
      return state.job
        ? describeJobProgress(state.job, nowMs, limits)
        : base({ kind: "checking", tone: "progress", title: "Checking job status", detail: "Reconnecting to your job." });
    case "completed": {
      const n = state.job.clips.length;
      return base({ kind: "completed", tone: "success", title: "Your clips are ready", detail: `${n} clip${n === 1 ? "" : "s"} rendered.` });
    }
    case "cancelled":
      return base({ kind: "cancelled", tone: "neutral", title: "Job cancelled", detail: state.job.error?.message ?? "The job was cancelled. Credits were refunded." });
    case "expired":
      return base({
        kind: "expired",
        tone: "warning",
        title: "Request not confirmed",
        detail: "We couldn't confirm whether your last request was created. Reload the page: if it was, it will appear here. You were not charged twice.",
      });
    case "failed": {
      const p = presentError(state.error.code, state.error.message);
      return base({ kind: "failed", tone: "danger", title: p.title, detail: p.message, error: { code: state.error.code, ...p } });
    }
  }
}

/** True when the page should show results/status instead of the setup form. */
export const isActivePhase = (s: ClipperClientState) =>
  s.phase === "uploading" || s.phase === "verifying" || s.phase === "submitting" || s.phase === "processing";
