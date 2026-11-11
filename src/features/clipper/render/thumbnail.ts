/**
 * Clip poster-frame extraction.
 *
 * FFmpeg writes one PNG frame from the *rendered* clip (so framing and subtitles match what
 * the user sees) into the render scratch directory; sharp converts it file-to-file into WebP.
 * Neither the clip nor the frame is held in a Node.js Buffer.
 */

import fsp from "node:fs/promises";
import sharp from "sharp";
import { CLIPPER_THUMBNAIL_WIDTH, MAX_STORED_CLIP_THUMBNAIL_BYTES } from "../config";
import type { ProcessRunner, RunnerOptions } from "../analysis/runner";
import { assertAbsoluteLocalPath, buildThumbnailArgs } from "./args";

export class ClipThumbnailError extends Error {
  constructor(public readonly code: "THUMBNAIL_EXTRACTION_FAILED" | "THUMBNAIL_TOO_LARGE" | "THUMBNAIL_INVALID", message: string) {
    super(message);
    this.name = "ClipThumbnailError";
  }
}

export interface ClipThumbnail {
  filePath: string;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: "image/webp";
}

/** Poster timestamp: 25% into the clip, never past 3s, always inside the clip. */
export function choosePosterTimestamp(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.max(0, Math.min(durationSeconds * 0.25, 3, durationSeconds - 0.1));
}

export async function extractClipThumbnail(params: {
  clipPath: string;
  framePath: string;
  webpPath: string;
  durationSeconds: number;
  runner: ProcessRunner;
  width?: number;
  maxBytes?: number;
  signal?: RunnerOptions["signal"];
}): Promise<ClipThumbnail> {
  assertAbsoluteLocalPath("webpPath", params.webpPath, ".webp");
  const width = params.width ?? CLIPPER_THUMBNAIL_WIDTH;
  const maxBytes = params.maxBytes ?? MAX_STORED_CLIP_THUMBNAIL_BYTES;

  const args = buildThumbnailArgs({
    clipPath: params.clipPath,
    framePath: params.framePath,
    atSeconds: choosePosterTimestamp(params.durationSeconds),
    width,
  });

  try {
    await params.runner.execute("ffmpeg", args, { timeoutMs: 30_000, maxBufferBytes: 256 * 1024, signal: params.signal });
  } catch (err) {
    if ((err as { code?: string })?.code === "PROCESS_ABORTED") throw err;
    throw new ClipThumbnailError("THUMBNAIL_EXTRACTION_FAILED", "Poster frame extraction failed.");
  }

  try {
    await fsp.stat(params.framePath);
  } catch {
    throw new ClipThumbnailError("THUMBNAIL_EXTRACTION_FAILED", "Poster frame was not produced.");
  }

  let info: { size: number; width: number; height: number };
  try {
    info = await sharp(params.framePath, { failOn: "error", limitInputPixels: 4096 * 4096 })
      .webp({ quality: 82, effort: 4 })
      .toFile(params.webpPath);
  } catch {
    throw new ClipThumbnailError("THUMBNAIL_INVALID", "Poster frame could not be converted to WebP.");
  } finally {
    await fsp.rm(params.framePath, { force: true });
  }

  if (info.size <= 0 || info.size > maxBytes) {
    await fsp.rm(params.webpPath, { force: true });
    throw new ClipThumbnailError("THUMBNAIL_TOO_LARGE", `Thumbnail is ${info.size} bytes (limit ${maxBytes}).`);
  }

  return { filePath: params.webpPath, width: info.width, height: info.height, sizeBytes: info.size, mimeType: "image/webp" };
}
