/**
 * Clip job creation from an API request (Batch 5).
 *
 * - Source is either a VERIFIED ephemeral upload (fresh storage check + container signature) or
 *   the user's own completed Stage 8 video asset (metadata from the GeneratedAsset row).
 * - Client-supplied duration/dimensions are HINTS only; the worker's FFprobe result is
 *   authoritative and fails + refunds the job when limits are violated.
 * - Captions/speech analysis are unavailable (owner decision A): burnSubtitles is always false
 *   and a request asking for captions is rejected explicitly rather than silently ignored.
 * - Idempotent replays short-circuit BEFORE source verification, because a completed job's
 *   upload has legitimately been deleted.
 */

import { AccountingError } from "@/features/generations/errors";
import {
  CLIPPER_ANALYSIS_CAPABILITIES,
  CLIPPER_ASPECT_RATIOS,
  CLIPPER_FRAMING_MODES,
  getClipperMaxClipsPerJob,
  getClipperMaxSourceDurationSeconds,
  getClipperMinSourceDurationSeconds,
  type ClipperAspectRatio,
  type ClipperFramingMode,
} from "./config";
import type { CreateClipperJobInput, CreateClipperJobOverrides, ClipperJob } from "./lifecycle";
import { SEGMENT_REGEX } from "./storage/keys";
import { verifyUpload, type ClipperUploadDeps } from "./uploads/uploads";

export class ClipJobRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ClipJobRequestError";
  }
}

export interface PlatformVideoAsset {
  storageKey: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

export interface ClipJobDeps {
  uploads: Pick<ClipperUploadDeps, "storage" | "now" | "storageTimeoutMs" | "isSourceKeyReferenced">;
  /** Own, COMPLETED Stage 8 VIDEO asset under users/{userId}/videos/, else null. */
  loadPlatformVideoAsset(userId: string, assetId: string): Promise<PlatformVideoAsset | null>;
  /** Existing job for (userId, idempotencyKey), if any. */
  findJobByIdempotencyKey(userId: string, idempotencyKey: string): Promise<{ id: string } | null>;
  createJob(input: CreateClipperJobInput, overrides: CreateClipperJobOverrides): Promise<{ job: ClipperJob; replayed: boolean }>;
}

export interface ParsedClipJobRequest {
  source: { type: "upload"; uploadKey: string } | { type: "platform_asset"; assetId: string };
  aspectRatio: ClipperAspectRatio;
  framing: ClipperFramingMode;
  clipCount: number;
  hints: { durationSeconds: number; width: number; height: number } | null;
}

function bad(message: string, code = "INVALID_INPUT"): never {
  throw new ClipJobRequestError(code, message);
}

export function parseClipJobRequest(body: unknown): ParsedClipJobRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) bad("Invalid request body.");
  const b = body as Record<string, unknown>;

  if (b.burnSubtitles === true || b.captions === true) {
    bad("Captions are not available yet: speech transcription is not enabled.", "CAPTIONS_UNAVAILABLE");
  }

  const src = b.source as Record<string, unknown> | undefined;
  let source: ParsedClipJobRequest["source"];
  if (src?.type === "upload" && typeof src.uploadKey === "string" && src.uploadKey.length <= 200) {
    source = { type: "upload", uploadKey: src.uploadKey };
  } else if (src?.type === "platform_asset" && typeof src.assetId === "string" && SEGMENT_REGEX.test(src.assetId)) {
    source = { type: "platform_asset", assetId: src.assetId };
  } else {
    bad("A valid source (upload or your own generated video) is required.");
  }

  if (typeof b.aspectRatio !== "string" || !(b.aspectRatio in CLIPPER_ASPECT_RATIOS)) bad("Unsupported aspect ratio.");
  if (typeof b.framing !== "string" || !(b.framing in CLIPPER_FRAMING_MODES)) bad("Unsupported framing mode.");
  const clipCount = b.clipCount;
  if (typeof clipCount !== "number" || !Number.isInteger(clipCount) || clipCount < 1 || clipCount > getClipperMaxClipsPerJob()) {
    bad(`Clip count must be between 1 and ${getClipperMaxClipsPerJob()}.`);
  }

  let hints: ParsedClipJobRequest["hints"] = null;
  if (source.type === "upload") {
    const h = (b.hints ?? {}) as Record<string, unknown>;
    const d = h.durationSeconds;
    if (typeof d !== "number" || !Number.isFinite(d)) bad("The video duration is required.");
    if (d < getClipperMinSourceDurationSeconds() || d > getClipperMaxSourceDurationSeconds()) {
      bad(
        `Videos must be between ${getClipperMinSourceDurationSeconds()} and ${getClipperMaxSourceDurationSeconds()} seconds long.`,
        "SOURCE_DURATION_OUT_OF_RANGE",
      );
    }
    const w = typeof h.width === "number" && Number.isInteger(h.width) && h.width > 0 && h.width <= 8192 ? h.width : 1920;
    const ht = typeof h.height === "number" && Number.isInteger(h.height) && h.height > 0 && h.height <= 8192 ? h.height : 1080;
    hints = { durationSeconds: d, width: w, height: ht };
  }

  return {
    source,
    aspectRatio: b.aspectRatio as ClipperAspectRatio,
    framing: b.framing as ClipperFramingMode,
    clipCount: clipCount as number,
    hints,
  };
}

export async function createClipJobFromRequest(
  deps: ClipJobDeps,
  params: { userId: string; idempotencyKey: string; body: unknown },
): Promise<{ job: ClipperJob; replayed: boolean }> {
  const { userId, idempotencyKey } = params;
  const req = parseClipJobRequest(params.body);

  const common = {
    userId,
    idempotencyKey,
    targetAspectRatio: req.aspectRatio,
    targetFraming: req.framing,
    burnSubtitles: false,
    isVisualOnly: false, // audio presence is determined by the worker's FFprobe, never the client
    requestedClipsCount: req.clipCount,
    prompt: "Video highlight clips",
  };

  // Replay: never re-verify a source that a finished job may already have cleaned up.
  const existing = await deps.findJobByIdempotencyKey(userId, idempotencyKey);

  if (req.source.type === "upload") {
    const sourceKey = req.source.uploadKey;
    if (existing) {
      return deps.createJob(
        { ...common, sourceType: "upload", sourceKey, sourceDurationSeconds: req.hints!.durationSeconds, sourceWidth: req.hints!.width, sourceHeight: req.hints!.height },
        {},
      );
    }
    const verified = await verifyUpload(deps.uploads, { userId, uploadKey: sourceKey });
    if (await deps.uploads.isSourceKeyReferenced(userId, verified.uploadKey)) {
      bad("This upload was already used. Please upload the video again.", "UPLOAD_ALREADY_USED");
    }
    return deps.createJob(
      {
        ...common,
        sourceType: "upload",
        sourceKey: verified.uploadKey,
        sourceDurationSeconds: req.hints!.durationSeconds,
        sourceWidth: req.hints!.width,
        sourceHeight: req.hints!.height,
      },
      {
        extraSettings: {
          sourceMetadataOrigin: "client_hint",
          sourceSizeBytes: verified.sizeBytes,
          analysis: { ...CLIPPER_ANALYSIS_CAPABILITIES },
        },
      },
    );
  }

  const asset = await deps.loadPlatformVideoAsset(userId, req.source.assetId);
  if (!asset) bad("Video not found.", "SOURCE_NOT_FOUND");
  const duration = asset.durationSeconds ?? 0;
  if (duration < getClipperMinSourceDurationSeconds() || duration > getClipperMaxSourceDurationSeconds()) {
    bad(
      `Videos must be between ${getClipperMinSourceDurationSeconds()} and ${getClipperMaxSourceDurationSeconds()} seconds long.`,
      "SOURCE_DURATION_OUT_OF_RANGE",
    );
  }
  return deps.createJob(
    {
      ...common,
      sourceType: "platform_asset",
      sourceKey: asset.storageKey,
      sourceAssetId: req.source.assetId,
      sourceDurationSeconds: duration,
      sourceWidth: asset.width ?? 1920,
      sourceHeight: asset.height ?? 1080,
    },
    {
      extraSettings: {
        sourceMetadataOrigin: "asset_record",
        ...(asset.sizeBytes ? { sourceSizeBytes: asset.sizeBytes } : {}),
        analysis: { ...CLIPPER_ANALYSIS_CAPABILITIES },
      },
    },
  );
}

export { AccountingError };
