/**
 * FFmpeg argument builders for clip rendering and poster-frame extraction.
 *
 * Security invariants:
 * - Arguments are returned as arrays for execFile (no shell is ever involved).
 * - Inputs and outputs must be absolute local filesystem paths; "-protocol_whitelist file"
 *   additionally restricts FFmpeg to the local file protocol for the input.
 * - "-n" refuses to overwrite an existing output; "-nostdin" prevents interactive reads.
 * - "-fs" caps the output file size; "-threads" caps CPU fan-out; the caller applies a timeout.
 * - All metadata/chapters/subtitle/data streams are dropped (strips e.g. phone GPS metadata).
 * - Every argument is checked by assertSafeSubprocessArgs (remote/pseudo-protocol rejection).
 */

import path from "node:path";
import { assertSafeSubprocessArgs } from "../analysis/runner";
import {
  CLIPPER_AUDIO_BITRATE_KBPS,
  getClipperFfmpegThreads,
  getClipperVideoMaxrateKbps,
  MAX_STORED_CLIP_BYTES,
  type ClipperAspectRatio,
  type ClipperFramingMode,
} from "../config";
import { buildClipFilterGraph, RenderConfigError, type FilterGraph } from "./filter-graph";

export function assertAbsoluteLocalPath(name: string, value: string, extension?: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new RenderConfigError("INVALID_PATH", `${name} must be a non-empty path.`);
  }
  if (!path.isAbsolute(value)) {
    throw new RenderConfigError("INVALID_PATH", `${name} must be an absolute local path.`);
  }
  if (value.startsWith("-") || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new RenderConfigError("INVALID_PATH", `${name} contains forbidden characters.`);
  }
  // Reject anything FFmpeg could interpret as a protocol URL (a Windows drive letter is a single char).
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(value)) {
    throw new RenderConfigError("INVALID_PATH", `${name} must not contain a URL scheme.`);
  }
  if (extension && path.extname(value).toLowerCase() !== extension) {
    throw new RenderConfigError("INVALID_PATH", `${name} must use the ${extension} extension.`);
  }
}

function seconds(value: number): string {
  return value.toFixed(3);
}

export interface RenderArgsInput {
  inputPath: string;
  outputPath: string;
  startTime: number;
  endTime: number;
  aspectRatio: ClipperAspectRatio;
  framing: ClipperFramingMode;
  hasAudio: boolean;
  sourceFps: number;
  subtitleFileName?: string | null;
  threads?: number;
  maxOutputBytes?: number;
  videoMaxrateKbps?: number;
}

export interface RenderArgs {
  args: string[];
  filter: FilterGraph;
  durationSeconds: number;
}

export function buildRenderArgs(input: RenderArgsInput): RenderArgs {
  assertAbsoluteLocalPath("inputPath", input.inputPath);
  assertAbsoluteLocalPath("outputPath", input.outputPath, ".mp4");
  if (path.resolve(input.inputPath) === path.resolve(input.outputPath)) {
    throw new RenderConfigError("INVALID_PATH", "outputPath must differ from inputPath.");
  }
  if (!Number.isFinite(input.startTime) || input.startTime < 0) {
    throw new RenderConfigError("INVALID_WINDOW", "startTime must be a non-negative finite number.");
  }
  if (!Number.isFinite(input.endTime) || input.endTime <= input.startTime) {
    throw new RenderConfigError("INVALID_WINDOW", "endTime must be greater than startTime.");
  }

  const threads = input.threads ?? getClipperFfmpegThreads();
  const maxOutputBytes = input.maxOutputBytes ?? MAX_STORED_CLIP_BYTES;
  const maxrate = input.videoMaxrateKbps ?? getClipperVideoMaxrateKbps();
  for (const [name, v] of [["threads", threads], ["maxOutputBytes", maxOutputBytes], ["videoMaxrateKbps", maxrate]] as const) {
    if (!Number.isInteger(v) || v <= 0) throw new RenderConfigError("INVALID_LIMIT", `${name} must be a positive integer.`);
  }

  const durationSeconds = input.endTime - input.startTime;
  const filter = buildClipFilterGraph({
    aspectRatio: input.aspectRatio,
    framing: input.framing,
    hasAudio: input.hasAudio,
    sourceFps: input.sourceFps,
    subtitleFileName: input.subtitleFileName,
  });

  const args: string[] = [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-loglevel", "error",
    "-n",
    "-threads", String(threads),
    "-filter_complex_threads", String(threads),
    // Input options: fast input seek + bounded read window. Output timestamps start at 0,
    // which matches clip-relative subtitle timing.
    "-protocol_whitelist", "file",
    "-ss", seconds(input.startTime),
    "-t", seconds(durationSeconds),
    "-i", input.inputPath,
    "-filter_complex", filter.graph,
    "-map", filter.videoLabel,
  ];

  if (filter.audioLabel) {
    args.push(
      "-map", filter.audioLabel,
      "-c:a", "aac",
      "-b:a", `${CLIPPER_AUDIO_BITRATE_KBPS}k`,
      "-ar", "48000",
      "-ac", "2",
    );
  } else {
    args.push("-an");
  }

  args.push(
    "-sn",
    "-dn",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-maxrate", `${maxrate}k`,
    "-bufsize", `${maxrate * 2}k`,
    "-t", seconds(durationSeconds),
    "-fs", String(maxOutputBytes),
    "-movflags", "+faststart",
    "-f", "mp4",
    input.outputPath,
  );

  assertSafeSubprocessArgs(args);
  return { args, filter, durationSeconds };
}

export interface ThumbnailArgsInput {
  clipPath: string;
  framePath: string;
  atSeconds: number;
  width: number;
}

/** Extracts one poster frame from the rendered clip as PNG (later converted to WebP by sharp). */
export function buildThumbnailArgs(input: ThumbnailArgsInput): string[] {
  assertAbsoluteLocalPath("clipPath", input.clipPath, ".mp4");
  assertAbsoluteLocalPath("framePath", input.framePath, ".png");
  if (!Number.isFinite(input.atSeconds) || input.atSeconds < 0) {
    throw new RenderConfigError("INVALID_WINDOW", "Thumbnail timestamp must be non-negative.");
  }
  if (!Number.isInteger(input.width) || input.width < 16 || input.width > 1920) {
    throw new RenderConfigError("INVALID_LIMIT", "Thumbnail width out of range.");
  }
  const args = [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-loglevel", "error",
    "-n",
    "-threads", "1",
    "-protocol_whitelist", "file",
    "-ss", seconds(input.atSeconds),
    "-i", input.clipPath,
    "-frames:v", "1",
    "-vf", `scale=${input.width}:-2`,
    "-an",
    "-f", "image2",
    "-c:v", "png",
    input.framePath,
  ];
  assertSafeSubprocessArgs(args);
  return args;
}
