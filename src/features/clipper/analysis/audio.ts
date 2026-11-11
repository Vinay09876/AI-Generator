/**
 * Audio Stream Detection, Extraction & Silence Analysis via FFmpeg.
 *
 * Implements:
 * - Safe audio demuxing to 16kHz mono WAV for downstream Whisper processing.
 * - Visual-only video bypass: returns { hasAudio: false, audioPath: null } without failing.
 * - FFmpeg silencedetect filter parser for dead-air detection and penalty scoring.
 * - Bounded subprocess execution with timeout and output limits.
 */

import type { VideoSource } from "../source";
import { getProcessRunner, type ProcessRunner } from "./runner";
import { extractVideoMetadata } from "./metadata";

// ---------------------------------------------------------------------------
// Types & Options
// ---------------------------------------------------------------------------
export interface AudioExtractionResult {
  hasAudio: boolean;
  audioPath: string | null;
  sampleRate?: number;
  channels?: number;
  audioCodec?: string | null;
}

export interface SilenceDetectOptions {
  /** Silence threshold in decibels (e.g. -30dB). Default: -30dB. */
  noiseThresholdDb?: number;
  /** Minimum silence duration in seconds to trigger detection. Default: 0.5s. */
  minDurationSeconds?: number;
}

export interface SilenceInterval {
  start: number;
  end: number;
  duration: number;
}

// ---------------------------------------------------------------------------
// Silence Output Parser (FFmpeg stderr output)
// ---------------------------------------------------------------------------
export function parseFfmpegSilenceOutput(stderr: string, mediaDurationSeconds?: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  const lines = stderr.split("\n");

  let currentStart: number | null = null;

  for (const line of lines) {
    // Matches: [silencedetect @ 0x...] silence_start: 14.25
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      currentStart = parseFloat(startMatch[1]);
      continue;
    }

    // Matches: [silencedetect @ 0x...] silence_end: 18.50 | silence_duration: 4.25
    const endMatch = line.match(/silence_end:\s*([0-9.]+)(?:\s*\|\s*silence_duration:\s*([0-9.]+))?/);
    if (endMatch && currentStart !== null) {
      const end = parseFloat(endMatch[1]);
      const duration = endMatch[2] ? parseFloat(endMatch[2]) : Math.max(0, end - currentStart);

      intervals.push({
        start: Math.round(currentStart * 100) / 100,
        end: Math.round(end * 100) / 100,
        duration: Math.round(duration * 100) / 100,
      });

      currentStart = null;
    }
  }

  // Handle trailing silence where video ended while silent
  if (currentStart !== null && mediaDurationSeconds && mediaDurationSeconds > currentStart) {
    const end = mediaDurationSeconds;
    intervals.push({
      start: Math.round(currentStart * 100) / 100,
      end: Math.round(end * 100) / 100,
      duration: Math.round((end - currentStart) * 100) / 100,
    });
  }

  return intervals;
}

// ---------------------------------------------------------------------------
// Audio Extraction Orchestrator
// ---------------------------------------------------------------------------
export async function extractAudioTrack(
  source: VideoSource,
  outputWavPath: string,
  runner?: ProcessRunner,
): Promise<AudioExtractionResult> {
  const activeRunner = runner ?? getProcessRunner();

  // 1. Inspect metadata first to verify audio stream existence
  const metadata = await extractVideoMetadata(source, activeRunner);
  if (!metadata.hasAudio) {
    // Visual-only bypass: do not run FFmpeg audio extraction
    return {
      hasAudio: false,
      audioPath: null,
      audioCodec: null,
    };
  }

  // 2. Demux audio to 16kHz mono WAV (standard for Whisper / speech processing)
  const materialized = await source.materialize();
  try {
    const args = [
      "-y",
      "-i",
      materialized.localPath,
      "-vn", // Disable video recording
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000", // 16 kHz sample rate
      "-ac",
      "1", // Mono channel
      outputWavPath,
    ];

    await activeRunner.execute("ffmpeg", args, { timeoutMs: 30_000 });

    return {
      hasAudio: true,
      audioPath: outputWavPath,
      sampleRate: 16000,
      channels: 1,
      audioCodec: metadata.audioCodec,
    };
  } finally {
    await materialized.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Silence Detection Orchestrator
// ---------------------------------------------------------------------------
export async function detectAudioSilence(
  source: VideoSource,
  options?: SilenceDetectOptions,
  runner?: ProcessRunner,
): Promise<SilenceInterval[]> {
  const activeRunner = runner ?? getProcessRunner();

  // Verify audio existence
  const metadata = await extractVideoMetadata(source, activeRunner);
  if (!metadata.hasAudio) {
    return []; // No audio track = no acoustic silence events
  }

  const noiseDb = options?.noiseThresholdDb ?? -30;
  const minDuration = options?.minDurationSeconds ?? 0.5;

  const materialized = await source.materialize();
  try {
    const args = [
      "-i",
      materialized.localPath,
      "-af",
      `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
      "-f",
      "null",
      "-",
    ];

    const result = await activeRunner.execute("ffmpeg", args, { timeoutMs: 30_000 });
    return parseFfmpegSilenceOutput(result.stderr, metadata.durationSeconds);
  } finally {
    await materialized.cleanup();
  }
}
