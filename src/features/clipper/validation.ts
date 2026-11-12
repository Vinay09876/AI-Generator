/**
 * Pure Input, Container, & Video Boundary Validation.
 *
 * Implements strict, framework-free validators for:
 * 1. Binary container magic bytes (ISO BMFF ftyp box, WebM EBML).
 * 2. File size boundaries against dynamic limits.
 * 3. Video metadata constraints (duration, resolution, audio presence).
 * 4. Clip time-window bounds (start, end, duration).
 * 5. Aspect ratio and framing settings.
 * 6. Identifier safety (anti-path-traversal).
 */

import {
  ALLOWED_CLIPPER_MIME_TYPES,
  CLIPPER_ASPECT_RATIOS,
  CLIPPER_FRAMING_MODES,
  DEFAULT_MIN_CLIP_DURATION_SECONDS,
  DEFAULT_MAX_CLIP_DURATION_SECONDS,
  checkSourceDimensions,
  getClipperMaxSourceDurationSeconds,
  getClipperMaxUploadBytes,
  getClipperMinSourceDurationSeconds,
  type AllowedClipperMimeType,
  type ClipperAspectRatio,
  type ClipperFramingMode,
} from "./config";
import { assertSafeIdentifier } from "./storage/keys";
import type { ValidationResult, VideoMetadata } from "./types";

// ---------------------------------------------------------------------------
// 1. Container Magic Bytes Inspection
// ---------------------------------------------------------------------------
const KNOWN_MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "mp41",
  "mp42",
  "qt  ",
  "m4v ",
  "m4v_",
  "m4a ",
  "avc1",
  "dash",
]);

export interface ContainerInspection {
  format: "mp4" | "quicktime" | "webm";
  majorBrand?: string;
  hasFtypBox?: boolean;
}

/**
 * Validates the binary header of an uploaded video stream (minimum 16 bytes required).
 * Fast-fails on executables, text files, zip archives, or corrupt data.
 */
export function inspectContainerMagicBytes(
  headerBuffer: Uint8Array | Buffer,
): ValidationResult<ContainerInspection> {
  if (!headerBuffer || headerBuffer.length < 12) {
    return {
      valid: false,
      code: "BUFFER_TOO_SHORT",
      error: "Header buffer is too short to inspect container signature (minimum 12 bytes required).",
    };
  }

  // Check for WebM EBML Header: 0x1A 0x45 0xDF 0xA3
  if (
    headerBuffer[0] === 0x1a &&
    headerBuffer[1] === 0x45 &&
    headerBuffer[2] === 0xdf &&
    headerBuffer[3] === 0xa3
  ) {
    return {
      valid: true,
      data: { format: "webm" },
    };
  }

  // Check for ISO-BMFF box structure: [4 bytes size][4 bytes type]
  const boxType = String.fromCharCode(
    headerBuffer[4],
    headerBuffer[5],
    headerBuffer[6],
    headerBuffer[7],
  );

  if (boxType === "ftyp") {
    const majorBrand = String.fromCharCode(
      headerBuffer[8],
      headerBuffer[9],
      headerBuffer[10],
      headerBuffer[11],
    ).toLowerCase();

    if (majorBrand === "qt  ") {
      return {
        valid: true,
        data: { format: "quicktime", majorBrand: "qt  ", hasFtypBox: true },
      };
    }

    if (KNOWN_MP4_BRANDS.has(majorBrand)) {
      return {
        valid: true,
        data: { format: "mp4", majorBrand, hasFtypBox: true },
      };
    }

    // Generic ISO BMFF compatibility
    return {
      valid: true,
      data: { format: "mp4", majorBrand, hasFtypBox: true },
    };
  }

  // QuickTime files can also start with 'moov', 'mdat', 'wide', or 'free'
  if (boxType === "moov" || boxType === "mdat" || boxType === "wide" || boxType === "free") {
    return {
      valid: true,
      data: { format: "quicktime", hasFtypBox: false },
    };
  }

  return {
    valid: false,
    code: "UNSUPPORTED_CONTAINER",
    error: `Unsupported container format or corrupt file header (box type: '${boxType.replace(/[^a-zA-Z0-9]/g, "?")}').`,
  };
}

// ---------------------------------------------------------------------------
// 2. MIME Type & File Size Validation
// ---------------------------------------------------------------------------
export function validateUploadMimeType(mimeType: unknown): ValidationResult<AllowedClipperMimeType> {
  if (typeof mimeType !== "string") {
    return {
      valid: false,
      code: "INVALID_MIME_TYPE",
      error: "MIME type must be a string.",
    };
  }

  const normalized = mimeType.toLowerCase().trim();
  if ((ALLOWED_CLIPPER_MIME_TYPES as readonly string[]).includes(normalized)) {
    return {
      valid: true,
      data: normalized as AllowedClipperMimeType,
    };
  }

  return {
    valid: false,
    code: "UNSUPPORTED_MIME_TYPE",
    error: `Unsupported MIME type: '${mimeType}'. Supported: ${ALLOWED_CLIPPER_MIME_TYPES.join(", ")}.`,
  };
}

export function validateUploadSizeBytes(sizeBytes: unknown): ValidationResult<number> {
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return {
      valid: false,
      code: "INVALID_FILE_SIZE",
      error: "File size must be a positive integer in bytes.",
    };
  }

  const maxBytes = getClipperMaxUploadBytes();
  if (sizeBytes > maxBytes) {
    return {
      valid: false,
      code: "FILE_TOO_LARGE",
      error: `File size (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB) exceeds maximum allowed limit (${(maxBytes / (1024 * 1024)).toFixed(1)} MB).`,
    };
  }

  return { valid: true, data: sizeBytes };
}

// ---------------------------------------------------------------------------
// 3. Metadata Bounds & Visual-Only Path Resolution
// ---------------------------------------------------------------------------
export interface ValidatedMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  isVisualOnly: boolean;
  hasAudio: boolean;
  videoCodec: string;
}

export function validateSourceMetadata(metadata: VideoMetadata): ValidationResult<ValidatedMetadata> {
  const minDuration = getClipperMinSourceDurationSeconds();
  const maxDuration = getClipperMaxSourceDurationSeconds();

  if (
    typeof metadata.durationSeconds !== "number" ||
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds < minDuration
  ) {
    return {
      valid: false,
      code: "DURATION_TOO_SHORT",
      error: `Video duration (${metadata.durationSeconds?.toFixed(1) ?? 0}s) is shorter than minimum required (${minDuration}s).`,
    };
  }

  if (metadata.durationSeconds > maxDuration) {
    return {
      valid: false,
      code: "DURATION_TOO_LONG",
      error: `Video duration (${metadata.durationSeconds.toFixed(1)}s) exceeds maximum allowed limit (${maxDuration}s).`,
    };
  }

  // Batch 7: orientation-neutral limits (portrait, landscape and square alike).
  const dims = checkSourceDimensions(metadata.width, metadata.height);
  if (!dims.ok) {
    return { valid: false, code: dims.code, error: dims.message };
  }

  // Audio track evaluation: if absent, we permit visual-only mode
  const isVisualOnly = !metadata.hasAudio || metadata.audioCodec === null;

  return {
    valid: true,
    data: {
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      isVisualOnly,
      hasAudio: metadata.hasAudio,
      videoCodec: metadata.videoCodec,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Clip Window Boundary Validation
// ---------------------------------------------------------------------------
export function validateClipWindow(params: {
  startTime: number;
  endTime: number;
  sourceDurationSeconds: number;
}): ValidationResult<{ startTime: number; endTime: number; duration: number }> {
  const { startTime, endTime, sourceDurationSeconds } = params;

  if (!Number.isFinite(startTime) || startTime < 0) {
    return {
      valid: false,
      code: "INVALID_START_TIME",
      error: "Clip startTime must be a non-negative finite number.",
    };
  }

  if (!Number.isFinite(endTime) || endTime <= startTime) {
    return {
      valid: false,
      code: "INVALID_END_TIME",
      error: `Clip endTime (${endTime}) must be greater than startTime (${startTime}).`,
    };
  }

  // Allow a tiny floating-point tolerance of 0.1s
  if (endTime > sourceDurationSeconds + 0.1) {
    return {
      valid: false,
      code: "CLIP_EXCEEDS_SOURCE",
      error: `Clip endTime (${endTime.toFixed(2)}s) exceeds source video duration (${sourceDurationSeconds.toFixed(2)}s).`,
    };
  }

  const duration = endTime - startTime;

  if (duration < DEFAULT_MIN_CLIP_DURATION_SECONDS) {
    return {
      valid: false,
      code: "CLIP_TOO_SHORT",
      error: `Clip duration (${duration.toFixed(1)}s) is shorter than minimum allowed (${DEFAULT_MIN_CLIP_DURATION_SECONDS}s).`,
    };
  }

  if (duration > DEFAULT_MAX_CLIP_DURATION_SECONDS) {
    return {
      valid: false,
      code: "CLIP_TOO_LONG",
      error: `Clip duration (${duration.toFixed(1)}s) exceeds maximum allowed (${DEFAULT_MAX_CLIP_DURATION_SECONDS}s).`,
    };
  }

  return {
    valid: true,
    data: { startTime, endTime, duration },
  };
}

// ---------------------------------------------------------------------------
// 5. Settings & Identifier Validation
// ---------------------------------------------------------------------------
export function validateAspectRatio(val: unknown): ValidationResult<ClipperAspectRatio> {
  if (typeof val === "string" && val in CLIPPER_ASPECT_RATIOS) {
    return { valid: true, data: val as ClipperAspectRatio };
  }
  return {
    valid: false,
    code: "INVALID_ASPECT_RATIO",
    error: `Invalid aspect ratio: '${String(val)}'. Supported: ${Object.keys(CLIPPER_ASPECT_RATIOS).join(", ")}.`,
  };
}

export function validateFramingMode(val: unknown): ValidationResult<ClipperFramingMode> {
  if (typeof val === "string" && val in CLIPPER_FRAMING_MODES) {
    return { valid: true, data: val as ClipperFramingMode };
  }
  return {
    valid: false,
    code: "INVALID_FRAMING_MODE",
    error: `Invalid framing mode: '${String(val)}'. Supported: ${Object.keys(CLIPPER_FRAMING_MODES).join(", ")}.`,
  };
}

export function validateIdentifier(name: string, value: unknown): ValidationResult<string> {
  try {
    assertSafeIdentifier(name, value);
    return { valid: true, data: value as string };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, code: "INVALID_IDENTIFIER", error: msg };
  }
}
