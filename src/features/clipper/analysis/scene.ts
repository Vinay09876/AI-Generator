/**
 * Visual Scene Cut Detection via FFmpeg.
 *
 * Implements:
 * - Direct execution of FFmpeg scene change filter (select='gt(scene,THRESHOLD)').
 * - Output parser for lavfi metadata and showinfo output.
 * - Monotonic timestamp ordering, minimum duration de-bouncing, and origin fallback.
 * - Safe subprocess execution via ProcessRunner abstraction.
 */

import type { SceneCut } from "../types";
import type { VideoSource } from "../source";
import { getProcessRunner, type ProcessRunner } from "./runner";

// ---------------------------------------------------------------------------
// Options & Defaults
// ---------------------------------------------------------------------------
export interface SceneDetectOptions {
  /** Scene change sensitivity threshold (0.0 to 1.0). Default: 0.3. Higher = only drastic cuts. */
  threshold?: number;
  /** Minimum duration in seconds between consecutive scene cuts to prevent jitter. Default: 1.0s. */
  minSceneDurationSeconds?: number;
}

export const DEFAULT_SCENE_THRESHOLD = 0.3;
export const DEFAULT_MIN_SCENE_DURATION_SECONDS = 1.0;

// ---------------------------------------------------------------------------
// FFmpeg Scene Output Parser
// ---------------------------------------------------------------------------
/**
 * Parses FFmpeg select/metadata print output:
 * Example lines:
 *   frame:120  pts:200200   pts_time:2.002
 *   lavfi.scene_score=0.452109
 */
export function parseFfmpegSceneOutput(
  output: string,
  minDurationSeconds: number = DEFAULT_MIN_SCENE_DURATION_SECONDS,
): SceneCut[] {
  const cuts: SceneCut[] = [];
  const lines = output.split("\n");

  let currentPtsTime: number | null = null;
  let currentFrame: number | undefined = undefined;

  for (const line of lines) {
    // Match pts_time and frame index:
    // e.g. "frame:145 pts:290290 pts_time:2.9029" or "pts_time:12.34"
    const ptsMatch = line.match(/pts_time:\s*([0-9.]+)/);
    if (ptsMatch) {
      currentPtsTime = parseFloat(ptsMatch[1]);
    }

    const frameMatch = line.match(/frame:\s*(\d+)/);
    if (frameMatch) {
      currentFrame = parseInt(frameMatch[1], 10);
    }

    // Match scene score:
    // e.g. "lavfi.scene_score=0.384521"
    const scoreMatch = line.match(/lavfi\.scene_score=([0-9.]+)/);
    if (scoreMatch && currentPtsTime !== null) {
      const score = parseFloat(scoreMatch[1]);
      const timestampSeconds = Math.round(currentPtsTime * 1000) / 1000;

      // De-bounce: only add if at least minDurationSeconds after previous cut
      const lastCut = cuts[cuts.length - 1];
      if (!lastCut || timestampSeconds - lastCut.timestampSeconds >= minDurationSeconds) {
        cuts.push({
          timestampSeconds,
          score: Math.round(score * 1000) / 1000,
          frameIndex: currentFrame,
        });
      }

      currentPtsTime = null;
      currentFrame = undefined;
    }
  }

  // Always ensure origin cut exists (0.0s)
  if (cuts.length === 0 || cuts[0].timestampSeconds > 0.5) {
    cuts.unshift({
      timestampSeconds: 0,
      score: 1.0,
      frameIndex: 0,
    });
  }

  return cuts.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
}

// ---------------------------------------------------------------------------
// Scene Detection Orchestrator
// ---------------------------------------------------------------------------
export async function detectSceneCuts(
  source: VideoSource,
  options?: SceneDetectOptions,
  runner?: ProcessRunner,
): Promise<SceneCut[]> {
  const activeRunner = runner ?? getProcessRunner();
  const threshold = options?.threshold ?? DEFAULT_SCENE_THRESHOLD;
  const minDuration = options?.minSceneDurationSeconds ?? DEFAULT_MIN_SCENE_DURATION_SECONDS;

  const materialized = await source.materialize();
  try {
    const args = [
      "-i",
      materialized.localPath,
      "-filter:v",
      `select='gt(scene,${threshold})',metadata=print:file=-`,
      "-f",
      "null",
      "-",
    ];

    const result = await activeRunner.execute("ffmpeg", args, { timeoutMs: 30_000 });
    // FFmpeg metadata filter can write to either stdout or stderr depending on build
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    return parseFfmpegSceneOutput(combinedOutput, minDuration);
  } finally {
    await materialized.cleanup();
  }
}
