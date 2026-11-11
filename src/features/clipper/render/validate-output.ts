/**
 * Rendered clip output validation.
 *
 * Never trusts the file extension or FFmpeg's exit code alone. Verifies:
 *   1. Regular file, 1..maxBytes in size (fs.stat — no buffering).
 *   2. ISOBMFF 'ftyp' signature (reads only the first 12 bytes via a file handle).
 *   3. FFprobe: MP4 container, H.264 video, exact dimensions, duration within tolerance,
 *      audio presence matching expectation (AAC when present).
 */

import fsp from "node:fs/promises";
import { CLIPPER_OUTPUT_DURATION_TOLERANCE_SECONDS, MAX_STORED_CLIP_BYTES } from "../config";
import type { ProcessRunner, RunnerOptions } from "../analysis/runner";
import type { FfprobeJsonOutput } from "../analysis/metadata";
import { assertAbsoluteLocalPath } from "./args";

export type OutputValidationCode =
  | "OUTPUT_MISSING"
  | "OUTPUT_EMPTY"
  | "OUTPUT_TOO_LARGE"
  | "OUTPUT_BAD_SIGNATURE"
  | "OUTPUT_PROBE_FAILED"
  | "OUTPUT_BAD_CONTAINER"
  | "OUTPUT_BAD_CODEC"
  | "OUTPUT_BAD_DIMENSIONS"
  | "OUTPUT_BAD_DURATION"
  | "OUTPUT_AUDIO_MISMATCH";

export class OutputValidationError extends Error {
  constructor(public readonly code: OutputValidationCode, message: string) {
    super(message);
    this.name = "OutputValidationError";
  }
}

export interface ExpectedClipOutput {
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
  maxBytes?: number;
  durationToleranceSeconds?: number;
}

export interface ValidatedClipOutput {
  width: number;
  height: number;
  durationSeconds: number;
  fileSizeBytes: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string | null;
}

/** Reads at most 12 bytes to confirm an ISOBMFF ftyp box. */
export async function hasMp4Signature(filePath: string): Promise<boolean> {
  const handle = await fsp.open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    return bytesRead >= 8 && header.toString("ascii", 4, 8) === "ftyp";
  } finally {
    await handle.close();
  }
}

export async function validateRenderedClip(
  filePath: string,
  expected: ExpectedClipOutput,
  runner: ProcessRunner,
  options?: Pick<RunnerOptions, "signal">,
): Promise<ValidatedClipOutput> {
  assertAbsoluteLocalPath("filePath", filePath, ".mp4");
  const maxBytes = expected.maxBytes ?? MAX_STORED_CLIP_BYTES;
  const tolerance = expected.durationToleranceSeconds ?? CLIPPER_OUTPUT_DURATION_TOLERANCE_SECONDS;

  let size: number;
  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) throw new Error("not a file");
    size = stats.size;
  } catch {
    throw new OutputValidationError("OUTPUT_MISSING", "Rendered clip file was not produced.");
  }
  if (size === 0) throw new OutputValidationError("OUTPUT_EMPTY", "Rendered clip file is empty.");
  if (size > maxBytes) {
    throw new OutputValidationError("OUTPUT_TOO_LARGE", `Rendered clip is ${size} bytes (limit ${maxBytes}).`);
  }
  if (!(await hasMp4Signature(filePath))) {
    throw new OutputValidationError("OUTPUT_BAD_SIGNATURE", "Rendered clip is not an MP4 container.");
  }

  let probe: FfprobeJsonOutput & { format?: { format_name?: string } };
  try {
    const result = await runner.execute(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeoutMs: 15_000, maxBufferBytes: 1024 * 1024, signal: options?.signal },
    );
    probe = JSON.parse(result.stdout);
  } catch (err) {
    if ((err as { code?: string })?.code === "PROCESS_ABORTED") throw err;
    throw new OutputValidationError("OUTPUT_PROBE_FAILED", "Rendered clip could not be probed.");
  }

  const formatName = probe.format?.format_name ?? "";
  if (!formatName.split(",").includes("mp4")) {
    throw new OutputValidationError("OUTPUT_BAD_CONTAINER", `Unexpected container: ${formatName || "unknown"}.`);
  }

  const streams = probe.streams ?? [];
  const video = streams.filter((s) => s.codec_type === "video");
  const audio = streams.filter((s) => s.codec_type === "audio");
  if (video.length !== 1 || video[0].codec_name !== "h264") {
    throw new OutputValidationError(
      "OUTPUT_BAD_CODEC",
      `Expected exactly one H.264 video stream, found ${video.map((v) => v.codec_name).join(",") || "none"}.`,
    );
  }
  if (video[0].width !== expected.width || video[0].height !== expected.height) {
    throw new OutputValidationError(
      "OUTPUT_BAD_DIMENSIONS",
      `Rendered ${video[0].width}x${video[0].height}, expected ${expected.width}x${expected.height}.`,
    );
  }

  const durationSeconds = parseFloat(probe.format?.duration ?? video[0].duration ?? "NaN");
  if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds - expected.durationSeconds) > tolerance) {
    throw new OutputValidationError(
      "OUTPUT_BAD_DURATION",
      `Rendered duration ${durationSeconds}s differs from requested ${expected.durationSeconds}s (tolerance ${tolerance}s).`,
    );
  }

  if (expected.hasAudio) {
    if (audio.length !== 1 || audio[0].codec_name !== "aac") {
      throw new OutputValidationError("OUTPUT_AUDIO_MISMATCH", "Expected exactly one AAC audio stream.");
    }
  } else if (audio.length > 0) {
    throw new OutputValidationError("OUTPUT_AUDIO_MISMATCH", "Visual-only clip unexpectedly contains audio.");
  }

  return {
    width: expected.width,
    height: expected.height,
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    fileSizeBytes: size,
    hasAudio: audio.length > 0,
    videoCodec: "h264",
    audioCodec: audio[0]?.codec_name ?? null,
  };
}
