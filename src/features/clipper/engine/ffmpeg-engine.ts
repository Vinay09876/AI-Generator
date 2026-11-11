/**
 * FfmpegClipperEngine — real FFmpeg/FFprobe implementation of VideoClipperEngine.
 *
 * - Requires an explicitly injected ProcessRunner. Refuses the offline mock runner unless
 *   `allowMockRunner` is set (tests only), so a misconfigured worker can never silently emit
 *   fake output.
 * - Reuses Batch 3 analysis modules for metadata, scene detection and audio extraction.
 * - Transcription is NOT faked: a transcriber must be injected, otherwise audio-bearing
 *   sources fail with TRANSCRIPTION_UNAVAILABLE. Visual-only sources return an empty transcript.
 * - renderClip writes into a private per-render scratch directory and returns FILE PATHS plus
 *   an idempotent cleanup(); it never returns video or thumbnail buffers.
 */

import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLIPPER_ASPECT_RATIOS, FFMPEG_CLIPPER_ENGINE, getClipperRenderTimeoutMs } from "../config";
import { detectAudioSilence, extractAudioTrack, type SilenceInterval } from "../analysis/audio";
import { extractVideoMetadata } from "../analysis/metadata";
import { isMockProcessRunner, ProcessExecutionError, type ProcessRunner } from "../analysis/runner";
import { detectSceneCuts } from "../analysis/scene";
import { assertAbsoluteLocalPath, buildRenderArgs } from "../render/args";
import { extractClipThumbnail } from "../render/thumbnail";
import { validateRenderedClip } from "../render/validate-output";
import type { VideoSource } from "../source";
import { generateAssSubtitles } from "../subtitles/ass-generator";
import type {
  CandidateHighlight,
  ClipRenderRequest,
  ClipRenderResult,
  SceneCut,
  TranscriptResult,
  VideoClipperEngine,
  VideoMetadata,
} from "../types";
import { validateClipWindow } from "../validation";

export class TranscriptionUnavailableError extends Error {
  readonly code = "TRANSCRIPTION_UNAVAILABLE";
  constructor() {
    super("No speech transcriber is configured for the FFmpeg clipper engine.");
    this.name = "TranscriptionUnavailableError";
  }
}

export class ClipRenderError extends Error {
  constructor(public readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClipRenderError";
  }
}

/** Injectable speech-to-text boundary (e.g. whisper.cpp in a later batch). */
export type SpeechTranscriber = (params: {
  wavPath: string;
  metadata: VideoMetadata;
  signal?: AbortSignal;
}) => Promise<TranscriptResult>;

export interface FfmpegClipperEngineOptions {
  runner: ProcessRunner;
  transcriber?: SpeechTranscriber;
  renderTimeoutMs?: number;
  threads?: number;
  /** Test-only escape hatch permitting the MockProcessRunner. */
  allowMockRunner?: boolean;
}

const SUBTITLE_FILE = "subs.ass";

export class FfmpegClipperEngine implements VideoClipperEngine {
  readonly name = FFMPEG_CLIPPER_ENGINE;
  private readonly runner: ProcessRunner;
  private readonly transcriber?: SpeechTranscriber;
  private readonly renderTimeoutMs: number;
  private readonly threads?: number;

  constructor(options: FfmpegClipperEngineOptions) {
    if (!options?.runner) throw new ClipRenderError("RUNNER_REQUIRED", "FfmpegClipperEngine requires a ProcessRunner.");
    if (isMockProcessRunner(options.runner) && !options.allowMockRunner) {
      throw new ClipRenderError("MOCK_RUNNER_REFUSED", "FfmpegClipperEngine refuses the mock process runner outside tests.");
    }
    this.runner = options.runner;
    this.transcriber = options.transcriber;
    this.renderTimeoutMs = options.renderTimeoutMs ?? getClipperRenderTimeoutMs();
    this.threads = options.threads;
  }

  get hasTranscriber(): boolean {
    return Boolean(this.transcriber);
  }

  extractMetadata(source: VideoSource): Promise<VideoMetadata> {
    return extractVideoMetadata(source, this.runner);
  }

  detectScenes(source: VideoSource): Promise<SceneCut[]> {
    return detectSceneCuts(source, undefined, this.runner);
  }

  /** Acoustic silence detection (dead-air pacing signal). Recognises no speech. */
  detectSilence(source: VideoSource): Promise<SilenceInterval[]> {
    return detectAudioSilence(source, undefined, this.runner);
  }

  async transcribeAudio(source: VideoSource): Promise<TranscriptResult> {
    const metadata = await this.extractMetadata(source);
    if (!metadata.hasAudio) {
      return { segments: [], fullText: "", language: "und", isVisualOnly: true };
    }
    if (!this.transcriber) throw new TranscriptionUnavailableError();

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper-asr-"));
    try {
      const wavPath = path.join(dir, "audio.wav");
      const extracted = await extractAudioTrack(source, wavPath, this.runner);
      if (!extracted.hasAudio || !extracted.audioPath) {
        return { segments: [], fullText: "", language: "und", isVisualOnly: true };
      }
      return await this.transcriber({ wavPath: extracted.audioPath, metadata });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  async renderClip(request: ClipRenderRequest): Promise<ClipRenderResult> {
    const canvas = CLIPPER_ASPECT_RATIOS[request.aspectRatio];
    if (!canvas) throw new ClipRenderError("INVALID_ASPECT_RATIO", "Unsupported aspect ratio.");

    const metadata = request.sourceMetadata ?? (await this.extractMetadata(request.source));
    const window = validateClipWindow({
      startTime: request.startTime,
      endTime: request.endTime,
      sourceDurationSeconds: metadata.durationSeconds,
    });
    if (!window.valid) throw new ClipRenderError(window.code, window.error);

    const materialized = await request.source.materialize();
    const parent = request.scratchDir ?? os.tmpdir();
    await fsp.mkdir(parent, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(parent, "clipper-render-"));
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await fsp.rm(dir, { recursive: true, force: true });
    };

    try {
      assertAbsoluteLocalPath("inputPath", materialized.localPath);

      const words = request.words ?? [];
      const burn = request.burnSubtitles && metadata.hasAudio && words.length > 0;
      if (burn) {
        const subtitleClip: CandidateHighlight = {
          id: `clip-${request.clipIndex + 1}`,
          title: request.title ?? "",
          startTime: 0,
          endTime: window.data.duration,
          durationSeconds: window.data.duration,
          score: 0,
          reason: "",
          transcriptText: "",
          words,
          aspectRatio: request.aspectRatio,
          framing: request.framing,
        };
        await fsp.writeFile(path.join(dir, SUBTITLE_FILE), generateAssSubtitles(subtitleClip), { encoding: "utf8", flag: "wx" });
      }

      const outputPath = path.join(dir, "clip.mp4");
      const { args, durationSeconds } = buildRenderArgs({
        inputPath: materialized.localPath,
        outputPath,
        startTime: window.data.startTime,
        endTime: window.data.endTime,
        aspectRatio: request.aspectRatio,
        framing: request.framing,
        hasAudio: metadata.hasAudio,
        sourceFps: metadata.fps,
        subtitleFileName: burn ? SUBTITLE_FILE : null,
        threads: this.threads,
      });

      // cwd = scratch dir so the subtitles filter resolves the bare filename without
      // any platform-specific path escaping inside the filter graph.
      await this.runner.execute("ffmpeg", args, {
        timeoutMs: this.renderTimeoutMs,
        maxBufferBytes: 1024 * 1024,
        cwd: dir,
        signal: request.signal,
      });

      const validated = await validateRenderedClip(
        outputPath,
        { width: canvas.width, height: canvas.height, durationSeconds, hasAudio: metadata.hasAudio },
        this.runner,
        { signal: request.signal },
      );

      const thumbnail = await extractClipThumbnail({
        clipPath: outputPath,
        framePath: path.join(dir, "poster.png"),
        webpPath: path.join(dir, "poster.webp"),
        durationSeconds: validated.durationSeconds,
        runner: this.runner,
        signal: request.signal,
      });

      return {
        clipId: randomUUID(),
        videoFilePath: outputPath,
        thumbnailFilePath: thumbnail.filePath,
        thumbnailSizeBytes: thumbnail.sizeBytes,
        durationSeconds: validated.durationSeconds,
        width: validated.width,
        height: validated.height,
        fileSizeBytes: validated.fileSizeBytes,
        hasAudio: validated.hasAudio,
        mimeType: "video/mp4",
        isMockOutput: false,
        cleanup,
      };
    } catch (err) {
      await cleanup();
      const isProcessError =
        err instanceof ProcessExecutionError || (err as { name?: unknown })?.name === "ProcessExecutionError";
      const code = (err as { code?: unknown })?.code;
      if (isProcessError && code !== "PROCESS_ABORTED") {
        // stderr/paths are deliberately not propagated into the message.
        throw new ClipRenderError(
          code === "PROCESS_TIMEOUT" ? "RENDER_TIMEOUT" : "RENDER_FAILED",
          code === "PROCESS_TIMEOUT" ? "Clip rendering timed out." : "FFmpeg clip rendering failed.",
          { cause: err },
        );
      }
      throw err;
    } finally {
      await materialized.cleanup();
    }
  }
}
