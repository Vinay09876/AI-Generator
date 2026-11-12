/**
 * Video Container & Stream Metadata Extraction via FFprobe.
 *
 * Implements:
 * - Direct execution via ProcessRunner abstraction (safe argument arrays).
 * - Full ISOBMFF/Matroska parsing (never assumes moov atom in first 256 KB).
 * - Visual-only / silent video detection (hasAudio = false).
 * - Monotonic duration, fractional frame-rate parsing, and dimension extraction.
 * - Integration with VideoSource memory-safe stream lifecycle.
 */

import type { VideoMetadata } from "../types";
import type { VideoSource } from "../source";
import { getProcessRunner, type ProcessRunner, ProcessExecutionError } from "./runner";
import { validateSourceMetadata } from "../validation";

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------
export class MetadataExtractionError extends Error {
  readonly code: string;

  constructor(message: string, code = "METADATA_EXTRACTION_FAILED") {
    super(message);
    this.name = "MetadataExtractionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Frame Rate Helper
// ---------------------------------------------------------------------------
export function parseFpsFraction(fraction: string | undefined): number {
  if (!fraction || typeof fraction !== "string") return 30.0;
  const parts = fraction.split("/");
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const val = Math.round((num / den) * 100) / 100;
      return Math.max(1, Math.min(val, 120));
    }
  }
  const direct = parseFloat(fraction);
  return Number.isFinite(direct) && direct > 0 ? direct : 30.0;
}

// ---------------------------------------------------------------------------
// Probe Output Interface (FFprobe -print_format json)
// ---------------------------------------------------------------------------
export interface FfprobeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  side_data_list?: Array<Record<string, any>>;
  tags?: Record<string, string>;
}

export interface FfprobeFormat {
  filename?: string;
  nb_streams?: number;
  format_name?: string;
  format_long_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

export interface FfprobeJsonOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

// ---------------------------------------------------------------------------
// Rotation Degrees Helper
// ---------------------------------------------------------------------------
/**
 * Normalises rotation metadata from FFprobe stream side data or tags to 0, 90, 180, or 270 degrees.
 * Returns 0 if no rotation metadata is present or if the value cannot be parsed.
 */
export function parseRotationDegrees(stream: Record<string, any> | undefined): number {
  if (!stream || typeof stream !== "object") return 0;
  let rawAngle: number | undefined;

  if (Array.isArray(stream.side_data_list)) {
    for (const item of stream.side_data_list) {
      if (item && item.rotation !== undefined) {
        const parsed = parseFloat(String(item.rotation));
        if (Number.isFinite(parsed)) {
          rawAngle = parsed;
          break;
        }
      }
    }
  }

  if (rawAngle === undefined && stream.tags && stream.tags.rotate !== undefined) {
    const parsed = parseFloat(String(stream.tags.rotate));
    if (Number.isFinite(parsed)) {
      rawAngle = parsed;
    }
  }

  if (rawAngle === undefined || !Number.isFinite(rawAngle)) {
    return 0;
  }

  const deg = ((Math.round(rawAngle) % 360) + 360) % 360;
  return deg === 360 ? 0 : deg;
}

// ---------------------------------------------------------------------------
// Pure Metadata Parser from FFprobe JSON
// ---------------------------------------------------------------------------
export function parseFfprobeJson(jsonStr: string, fallbackSizeBytes?: number): VideoMetadata {
  let parsed: FfprobeJsonOutput;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err: any) {
    throw new MetadataExtractionError(
      `Failed to parse ffprobe JSON output: ${err.message}`,
      "INVALID_PROBE_JSON",
    );
  }

  const streams = parsed.streams ?? [];
  const format = parsed.format ?? {};

  const videoStream = streams.find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new MetadataExtractionError(
      "No video stream found in media container.",
      "NO_VIDEO_STREAM",
    );
  }

  const audioStream = streams.find((s) => s.codec_type === "audio");

  // Duration derivation
  const rawDuration =
    format.duration ?? videoStream.duration ?? (audioStream ? audioStream.duration : undefined);
  const durationSeconds = rawDuration ? parseFloat(rawDuration) : 0;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MetadataExtractionError(
      "Unable to determine valid media duration from container headers.",
      "INVALID_DURATION",
    );
  }

  // Dimensions & rotation handling
  const codedWidth = videoStream.width ?? 0;
  const codedHeight = videoStream.height ?? 0;
  if (codedWidth <= 0 || codedHeight <= 0) {
    throw new MetadataExtractionError(
      `Invalid video dimensions: ${codedWidth}x${codedHeight}`,
      "INVALID_DIMENSIONS",
    );
  }

  const rotationDegrees = parseRotationDegrees(videoStream);
  const isTransposed = rotationDegrees === 90 || rotationDegrees === 270;
  const width = isTransposed ? codedHeight : codedWidth;
  const height = isTransposed ? codedWidth : codedHeight;

  // FPS
  const fps = parseFpsFraction(videoStream.r_frame_rate ?? videoStream.avg_frame_rate);

  // File size
  const rawSize = format.size ? parseInt(format.size, 10) : undefined;
  const fileSizeBytes = rawSize && Number.isFinite(rawSize) && rawSize > 0
    ? rawSize
    : (fallbackSizeBytes ?? 0);

  // Bitrate
  const rawBitrate = format.bit_rate ?? videoStream.bit_rate;
  const bitrate = rawBitrate ? parseInt(rawBitrate, 10) : null;

  // Audio presence & properties
  const hasAudio = Boolean(audioStream && audioStream.codec_name);
  const audioCodec = hasAudio ? audioStream!.codec_name ?? null : null;
  const sampleRate = hasAudio && audioStream!.sample_rate ? parseInt(audioStream!.sample_rate, 10) : null;
  const channels = hasAudio && audioStream!.channels ? audioStream!.channels : null;

  return {
    durationSeconds: Math.round(durationSeconds * 100) / 100,
    width,
    height,
    fps,
    videoCodec: videoStream.codec_name ?? "unknown",
    audioCodec,
    hasAudio,
    sampleRate,
    channels,
    bitrate: Number.isFinite(bitrate) ? bitrate : null,
    fileSizeBytes,
    rotationDegrees,
    codedWidth,
    codedHeight,
  };
}

// ---------------------------------------------------------------------------
// VideoSource Metadata Extraction Orchestrator
// ---------------------------------------------------------------------------
export async function extractVideoMetadata(
  source: VideoSource,
  runner?: ProcessRunner,
): Promise<VideoMetadata> {
  const activeRunner = runner ?? getProcessRunner();
  const materialized = await source.materialize();

  try {
    const args = [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      materialized.localPath,
    ];

    const result = await activeRunner.execute("ffprobe", args, { timeoutMs: 15_000 });
    const metadata = parseFfprobeJson(result.stdout, source.fileSizeBytes);

    // Validate against domain bounds
    const validation = validateSourceMetadata(metadata);
    if (!validation.valid) {
      throw new MetadataExtractionError(
        `Video metadata violates domain limits: ${validation.error}`,
        validation.code,
      );
    }

    return metadata;
  } catch (err: any) {
    if (err instanceof MetadataExtractionError || err instanceof ProcessExecutionError) {
      throw err;
    }
    throw new MetadataExtractionError(
      `Unexpected error inspecting video metadata: ${err.message}`,
      "PROBE_FAILED",
    );
  } finally {
    await materialized.cleanup();
  }
}