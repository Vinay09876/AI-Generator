/**
 * Deterministic Offline Mock Clipper Engine.
 *
 * Implements the VideoClipperEngine interface for offline unit testing, CI/CD,
 * and zero-dependency local development:
 * 1. Operates over the VideoSource abstraction with verified cleanup.
 * 2. Returns deterministic metadata, scene cuts, and word-level transcripts.
 * 3. Supports visual-only videos lacking audio (cleanly bypassing transcription).
 * 4. Generates structural mock MP4 containers for testing without system FFmpeg.
 *
 * DISCLAIMER:
 * Mock MP4 output emitted by this engine is a synthetic test fixture for offline
 * development and contract verification only; it is not a genuinely re-encoded video.
 */

import { CLIPPER_ASPECT_RATIOS, MOCK_CLIPPER_ENGINE } from "../config";
import type { VideoSource } from "../source";
import type {
  ClipRenderRequest,
  ClipRenderResult,
  SceneCut,
  TranscriptResult,
  TranscriptSegment,
  TranscriptWord,
  VideoClipperEngine,
  VideoMetadata,
} from "../types";
import { createMockMp4Buffer } from "../../video/providers/fixture";

// ---------------------------------------------------------------------------
// Synthetic WebP Thumbnail Header (Minimal 30-byte container)
// ---------------------------------------------------------------------------
const MOCK_WEBP_THUMBNAIL_BUFFER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x1a, 0x00, 0x00, 0x00, // file length - 8
  0x57, 0x45, 0x42, 0x50, // "WEBP"
  0x56, 0x50, 0x38, 0x20, // "VP8 "
  0x0e, 0x00, 0x00, 0x00, // chunk size
  0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01, 0x00, 0x00, 0x00, 0x00,
]);

export class MockClipperEngine implements VideoClipperEngine {
  readonly name = MOCK_CLIPPER_ENGINE;

  /**
   * Extracts deterministic container metadata from the video source.
   */
  async extractMetadata(source: VideoSource): Promise<VideoMetadata> {
    const { localPath, cleanup } = await source.materialize();
    try {
      const isSilent =
        source.identifier.toLowerCase().includes("silent") ||
        source.identifier.toLowerCase().includes("no_audio") ||
        localPath.toLowerCase().includes("silent") ||
        localPath.toLowerCase().includes("no_audio");

      return {
        durationSeconds: 60.0,
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: "h264",
        audioCodec: isSilent ? null : "aac",
        hasAudio: !isSilent,
        sampleRate: isSilent ? null : 44100,
        channels: isSilent ? null : 2,
        bitrate: 5000000,
        fileSizeBytes: source.fileSizeBytes ?? 1024 * 1024,
      };
    } finally {
      await cleanup();
    }
  }

  /**
   * Detects deterministic scene boundaries across the duration.
   */
  async detectScenes(source: VideoSource): Promise<SceneCut[]> {
    const { cleanup } = await source.materialize();
    try {
      return [
        { timestampSeconds: 5.2, score: 0.82, frameIndex: 156 },
        { timestampSeconds: 14.8, score: 0.91, frameIndex: 444 },
        { timestampSeconds: 28.5, score: 0.74, frameIndex: 855 },
        { timestampSeconds: 42.1, score: 0.88, frameIndex: 1263 },
        { timestampSeconds: 55.0, score: 0.69, frameIndex: 1650 },
      ];
    } finally {
      await cleanup();
    }
  }

  /**
   * Generates deterministic word-level speech transcripts.
   * If the video has no audio or is marked silent, returns an empty transcript with isVisualOnly=true.
   */
  async transcribeAudio(source: VideoSource): Promise<TranscriptResult> {
    const { localPath, cleanup } = await source.materialize();
    try {
      const isSilent =
        source.identifier.toLowerCase().includes("silent") ||
        source.identifier.toLowerCase().includes("no_audio") ||
        localPath.toLowerCase().includes("silent") ||
        localPath.toLowerCase().includes("no_audio");

      if (isSilent) {
        return {
          segments: [],
          fullText: "",
          language: "en",
          isVisualOnly: true,
        };
      }

      const segments: TranscriptSegment[] = [
        {
          id: "seg-1",
          text: "Welcome to this comprehensive tutorial on building AI applications.",
          start: 0.5,
          end: 4.8,
          words: [
            { word: "Welcome", start: 0.5, end: 1.0, confidence: 0.99 },
            { word: "to", start: 1.05, end: 1.2, confidence: 0.99 },
            { word: "this", start: 1.25, end: 1.5, confidence: 0.99 },
            { word: "comprehensive", start: 1.55, end: 2.3, confidence: 0.97 },
            { word: "tutorial", start: 2.35, end: 2.9, confidence: 0.98 },
            { word: "on", start: 2.95, end: 3.1, confidence: 0.99 },
            { word: "building", start: 3.15, end: 3.6, confidence: 0.98 },
            { word: "AI", start: 3.65, end: 4.0, confidence: 0.99 },
            { word: "applications.", start: 4.05, end: 4.8, confidence: 0.97 },
          ],
        },
        {
          id: "seg-2",
          text: "Today we will break down the essential architecture and key principles.",
          start: 5.5,
          end: 10.2,
          words: [
            { word: "Today", start: 5.5, end: 5.9, confidence: 0.99 },
            { word: "we", start: 5.95, end: 6.1, confidence: 0.99 },
            { word: "will", start: 6.15, end: 6.35, confidence: 0.99 },
            { word: "break", start: 6.4, end: 6.7, confidence: 0.98 },
            { word: "down", start: 6.75, end: 7.0, confidence: 0.98 },
            { word: "the", start: 7.05, end: 7.2, confidence: 0.99 },
            { word: "essential", start: 7.25, end: 7.8, confidence: 0.96 },
            { word: "architecture", start: 7.85, end: 8.6, confidence: 0.98 },
            { word: "and", start: 8.65, end: 8.85, confidence: 0.99 },
            { word: "key", start: 8.9, end: 9.2, confidence: 0.98 },
            { word: "principles.", start: 9.25, end: 10.2, confidence: 0.97 },
          ],
        },
        {
          id: "seg-3",
          text: "Let us examine how modern generative models process incoming requests.",
          start: 15.0,
          end: 20.0,
          words: [
            { word: "Let", start: 15.0, end: 15.25, confidence: 0.99 },
            { word: "us", start: 15.3, end: 15.5, confidence: 0.99 },
            { word: "examine", start: 15.55, end: 16.1, confidence: 0.97 },
            { word: "how", start: 16.15, end: 16.35, confidence: 0.99 },
            { word: "modern", start: 16.4, end: 16.85, confidence: 0.98 },
            { word: "generative", start: 16.9, end: 17.55, confidence: 0.96 },
            { word: "models", start: 17.6, end: 18.05, confidence: 0.98 },
            { word: "process", start: 18.1, end: 18.6, confidence: 0.98 },
            { word: "incoming", start: 18.65, end: 19.15, confidence: 0.97 },
            { word: "requests.", start: 19.2, end: 20.0, confidence: 0.98 },
          ],
        },
        {
          id: "seg-4",
          text: "Notice the difference when we optimize streaming and asynchronous pipelines.",
          start: 29.5,
          end: 34.5,
          words: [
            { word: "Notice", start: 29.5, end: 29.9, confidence: 0.99 },
            { word: "the", start: 29.95, end: 30.1, confidence: 0.99 },
            { word: "difference", start: 30.15, end: 30.7, confidence: 0.98 },
            { word: "when", start: 30.75, end: 31.0, confidence: 0.99 },
            { word: "we", start: 31.05, end: 31.2, confidence: 0.99 },
            { word: "optimize", start: 31.25, end: 31.8, confidence: 0.97 },
            { word: "streaming", start: 31.85, end: 32.4, confidence: 0.98 },
            { word: "and", start: 32.45, end: 32.65, confidence: 0.99 },
            { word: "asynchronous", start: 32.7, end: 33.6, confidence: 0.96 },
            { word: "pipelines.", start: 33.65, end: 34.5, confidence: 0.98 },
          ],
        },
      ];

      const fullText = segments.map((s) => s.text).join(" ");

      return {
        segments,
        fullText,
        language: "en",
        isVisualOnly: false,
      };
    } finally {
      await cleanup();
    }
  }

  /**
   * Renders a mock clip output conforming strictly to requested dimensions and duration.
   */
  async renderClip(request: ClipRenderRequest): Promise<ClipRenderResult> {
    const { cleanup } = await request.source.materialize();
    try {
      const aspectConfig = CLIPPER_ASPECT_RATIOS[request.aspectRatio];
      const width = aspectConfig.width;
      const height = aspectConfig.height;
      const durationSeconds = Math.max(1, request.endTime - request.startTime);

      // Create a deterministic structural MP4 buffer matching the aspect ratio and duration
      const mockMp4 = createMockMp4Buffer({
        width,
        height,
        durationSeconds,
      });

      const clipId = `mock_clip_${request.clipIndex + 1}_${Date.now().toString(36)}`;

      return {
        clipId,
        videoBuffer: mockMp4,
        thumbnailBuffer: MOCK_WEBP_THUMBNAIL_BUFFER,
        durationSeconds,
        width,
        height,
        fileSizeBytes: mockMp4.length,
        mimeType: "video/mp4",
        isMockOutput: true,
      };
    } finally {
      await cleanup();
    }
  }
}
