/**
 * Single-pass FFmpeg filter graph builder for clip framing, subtitles and audio normalization.
 *
 * Pure functions only: every value interpolated into the graph is either a validated number
 * or a validated bare subtitle filename. No user text ever reaches the filter graph.
 *
 * Framing modes (target canvas W x H):
 *   center_crop     scale to cover the canvas, then centre-crop.
 *   fit             scale to fit inside the canvas, then pad with black borders.
 *   pillarbox_blur  blurred, cover-scaled background (computed at 1/6 resolution for cost)
 *                   with the fit-scaled sharp foreground overlaid in the centre.
 *
 * Output labels: [vout] always; [aout] only when the source has audio.
 */

import {
  CLIPPER_ASPECT_RATIOS,
  CLIPPER_FRAMING_MODES,
  CLIPPER_LOUDNORM,
  CLIPPER_MAX_OUTPUT_FPS,
  type ClipperAspectRatio,
  type ClipperFramingMode,
} from "../config";

export class RenderConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RenderConfigError";
  }
}

/** Bare ASS filename only (resolved against the render scratch directory via the process cwd). */
export const SUBTITLE_FILENAME_REGEX = /^[A-Za-z0-9_-]{1,64}\.ass$/;

/** Background blur is computed on a canvas downscaled by this factor (keeps all sizes even). */
export const BLUR_DOWNSCALE_FACTOR = 6;

export interface FilterGraphInput {
  aspectRatio: ClipperAspectRatio;
  framing: ClipperFramingMode;
  hasAudio: boolean;
  /** Source frame rate; output is capped at CLIPPER_MAX_OUTPUT_FPS. */
  sourceFps: number;
  /** Bare ASS filename to burn in, or null/undefined for no subtitles. */
  subtitleFileName?: string | null;
}

export interface FilterGraph {
  graph: string;
  videoLabel: "[vout]";
  audioLabel: "[aout]" | null;
  width: number;
  height: number;
  outputFps: number;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function resolveOutputFps(sourceFps: number): number {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return CLIPPER_MAX_OUTPUT_FPS;
  return Math.min(CLIPPER_MAX_OUTPUT_FPS, Math.round(sourceFps * 1000) / 1000);
}

function framingChain(framing: ClipperFramingMode, w: number, h: number): string {
  switch (framing) {
    case "center_crop":
      return `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[vbase]`;
    case "fit":
      return (
        `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[vbase]`
      );
    case "pillarbox_blur": {
      const bw = even(w / BLUR_DOWNSCALE_FACTOR);
      const bh = even(h / BLUR_DOWNSCALE_FACTOR);
      return (
        `[0:v]split=2[bgsrc][fgsrc];` +
        `[bgsrc]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
        `boxblur=8:2,scale=${w}:${h},setsar=1[bg];` +
        `[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[vbase]`
      );
    }
    default: {
      const exhaustive: never = framing;
      throw new RenderConfigError("INVALID_FRAMING", `Unsupported framing mode: ${String(exhaustive)}`);
    }
  }
}

export function buildClipFilterGraph(input: FilterGraphInput): FilterGraph {
  const canvas = CLIPPER_ASPECT_RATIOS[input.aspectRatio];
  if (!canvas) {
    throw new RenderConfigError("INVALID_ASPECT_RATIO", `Unsupported aspect ratio: ${String(input.aspectRatio)}`);
  }
  if (!(input.framing in CLIPPER_FRAMING_MODES)) {
    throw new RenderConfigError("INVALID_FRAMING", `Unsupported framing mode: ${String(input.framing)}`);
  }

  const subtitle = input.subtitleFileName ?? null;
  if (subtitle !== null && !SUBTITLE_FILENAME_REGEX.test(subtitle)) {
    throw new RenderConfigError("INVALID_SUBTITLE_FILENAME", "Subtitle file must be a bare *.ass filename.");
  }

  const { width: w, height: h } = canvas;
  const outputFps = resolveOutputFps(input.sourceFps);

  const chains: string[] = [framingChain(input.framing, w, h)];

  const post: string[] = [`fps=${outputFps}`];
  if (subtitle) post.push(`subtitles=filename=${subtitle}`);
  post.push("format=yuv420p");
  chains.push(`[vbase]${post.join(",")}[vout]`);

  let audioLabel: FilterGraph["audioLabel"] = null;
  if (input.hasAudio) {
    const { integratedLufs, truePeakDb, loudnessRange } = CLIPPER_LOUDNORM;
    chains.push(
      `[0:a:0]loudnorm=I=${integratedLufs}:TP=${truePeakDb}:LRA=${loudnessRange},` +
        `aresample=48000,aformat=channel_layouts=stereo[aout]`,
    );
    audioLabel = "[aout]";
  }

  return { graph: chains.join(";"), videoLabel: "[vout]", audioLabel, width: w, height: h, outputFps };
}
