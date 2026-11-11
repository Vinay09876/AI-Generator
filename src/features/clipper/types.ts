/**
 * AI Video Clipper Domain Types & Engine Interfaces.
 *
 * Defines the core abstraction contracts for:
 * - VideoSource memory-safe stream & file abstraction
 * - ClipperEngine interface (MockClipperEngine vs FfmpegClipperEngine)
 * - Video container metadata
 * - Scene cut points and speech transcripts with word-level timestamps
 * - Candidate highlight scoring
 * - Render requests and results
 * - Database settings and audit payloads
 */

import type { ClipperAspectRatio, ClipperFramingMode } from "./config";
import type { VideoSource } from "./source";

// ---------------------------------------------------------------------------
// Video Container & Stream Metadata
// ---------------------------------------------------------------------------
export interface VideoMetadata {
  /** Total media duration in seconds. */
  durationSeconds: number;
  /** Video frame pixel width. */
  width: number;
  /** Video frame pixel height. */
  height: number;
  /** Frame rate in frames per second. */
  fps: number;
  /** Video track codec name (e.g. "h264", "hevc", "vp9", "av1"). */
  videoCodec: string;
  /** Audio track codec name (e.g. "aac", "opus", "mp3"), or null if silent. */
  audioCodec: string | null;
  /** Whether the container contains at least one decodable audio track. */
  hasAudio: boolean;
  /** Audio sampling rate in Hz (e.g. 44100, 48000), or null if silent. */
  sampleRate: number | null;
  /** Audio channel count (e.g. 1 = mono, 2 = stereo), or null if silent. */
  channels: number | null;
  /** Overall container bitrate in bits per second, if known. */
  bitrate: number | null;
  /** Total container byte size, if known. */
  fileSizeBytes: number;
}

// ---------------------------------------------------------------------------
// Scene Detection & Boundary Types
// ---------------------------------------------------------------------------
export interface SceneCut {
  /** Timestamp in seconds where the visual scene transition occurs. */
  timestampSeconds: number;
  /** Confidence / difference score of the transition (0.0 to 1.0). */
  score: number;
  /** Optional frame index in the source stream. */
  frameIndex?: number;
}

// ---------------------------------------------------------------------------
// Speech-to-Text & Subtitle Types
// ---------------------------------------------------------------------------
export interface TranscriptWord {
  /** The single spoken word or token. */
  word: string;
  /** Start time in seconds relative to the audio track. */
  start: number;
  /** End time in seconds relative to the audio track. */
  end: number;
  /** Model confidence score (0.0 to 1.0), if available. */
  confidence?: number;
  /** Whether the word timestamp was linearly interpolated rather than acoustically aligned. */
  isInterpolated?: boolean;
}

export interface TranscriptSegment {
  /** Unique segment identifier. */
  id: string;
  /** Full text of this phrase / sentence. */
  text: string;
  /** Start timestamp in seconds. */
  start: number;
  /** End timestamp in seconds. */
  end: number;
  /** Array of individual words with millisecond/centisecond timestamps. */
  words: TranscriptWord[];
  /** Whether this segment has genuine acoustic word-level timestamps. */
  hasWordLevelAlignment?: boolean;
}

export interface TranscriptResult {
  /** Array of timed speech segments. Empty if video has no audio or is visual-only. */
  segments: TranscriptSegment[];
  /** Full consolidated transcript text. */
  fullText: string;
  /** Detected or assumed language code (e.g. "en", "es", "hi"). */
  language: string;
  /** True if speech transcription was bypassed (no audio track or visual-only mode). */
  isVisualOnly: boolean;
}

// ---------------------------------------------------------------------------
// Candidate Highlight Types
// ---------------------------------------------------------------------------
export interface CandidateHighlight {
  /** Unique highlight identifier within this job (e.g. "highlight-1"). */
  id: string;
  /** Descriptive AI-generated or heuristic title (e.g. "The Core Breakthrough"). */
  title: string;
  /** Clip start timestamp in seconds from source video. */
  startTime: number;
  /** Clip end timestamp in seconds from source video. */
  endTime: number;
  /** Total duration in seconds. */
  durationSeconds: number;
  /** Composite virality / engagement score (0 to 100). */
  score: number;
  /** Short human-readable explanation of why this segment was selected. */
  reason: string;
  /** Transcript text contained within this highlight window. */
  transcriptText: string;
  /** Words occurring within this window, re-indexed relative to clip start. */
  words: TranscriptWord[];
  /** Target export aspect ratio. */
  aspectRatio: ClipperAspectRatio;
  /** Target canvas framing mode. */
  framing: ClipperFramingMode;
}

// ---------------------------------------------------------------------------
// Render Pipeline Contracts
// ---------------------------------------------------------------------------
export interface ClipRenderRequest {
  /** Parent generation job ID. */
  jobId: string;
  /** Owner user ID. */
  userId: string;
  /** Index of this clip within the batch (0, 1, 2). */
  clipIndex: number;
  /** Memory-safe VideoSource abstraction (local worker file or storage reference). */
  source: VideoSource;
  /** Start timestamp in seconds from source video. */
  startTime: number;
  /** End timestamp in seconds from source video. */
  endTime: number;
  /** Target aspect ratio canvas. */
  aspectRatio: ClipperAspectRatio;
  /** Canvas framing mode (e.g. "pillarbox_blur", "center_crop"). */
  framing: ClipperFramingMode;
  /** Whether to burn styled karaoke subtitles into the video. */
  burnSubtitles: boolean;
  /** Word-level transcript items for subtitle generation. */
  words?: TranscriptWord[];
  /** Optional title for metadata or watermark. */
  title?: string;
  /** Pre-extracted source metadata (avoids re-probing per clip). Real engines probe if absent. */
  sourceMetadata?: VideoMetadata;
  /** Aborts in-flight subprocesses (e.g. when the worker lease is lost). */
  signal?: AbortSignal;
  /** Parent directory for the per-render scratch directory. Defaults to os.tmpdir(). */
  scratchDir?: string;
}

export interface ClipRenderResult {
  /** Unique ID generated for this clip. */
  clipId: string;
  /** Output MP4 video buffer (in memory or temporary path for testing). */
  videoBuffer?: Buffer;
  /** Output video file path, if written to disk by worker. */
  videoFilePath?: string;
  /** Output poster frame thumbnail buffer (WebP format). */
  thumbnailBuffer?: Buffer;
  /** Exact duration of the rendered clip in seconds. */
  durationSeconds: number;
  /** Rendered width in pixels. */
  width: number;
  /** Rendered height in pixels. */
  height: number;
  /** Total file size in bytes of the rendered MP4. */
  fileSizeBytes: number;
  /** Output MIME type (always "video/mp4"). */
  mimeType: "video/mp4";
  /** Explicit disclaimer noting whether output is a genuine render or synthetic mock. */
  isMockOutput?: boolean;
  /** Poster WebP file path (real engines; never a buffer). */
  thumbnailFilePath?: string;
  /** Poster WebP size in bytes. */
  thumbnailSizeBytes?: number;
  /** Whether the rendered clip contains an audio stream. */
  hasAudio?: boolean;
  /** Removes the per-render scratch directory. Idempotent; the caller must invoke it. */
  cleanup?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Pluggable Clipper Engine Interface
// ---------------------------------------------------------------------------
export interface VideoClipperEngine {
  /** Identifier of the engine implementation. */
  readonly name: string;

  /**
   * Extracts container metadata (dimensions, duration, codecs, audio presence).
   * Operates over a memory-safe VideoSource abstraction.
   */
  extractMetadata(source: VideoSource): Promise<VideoMetadata>;

  /**
   * Detects visual scene changes and potential cut points.
   */
  detectScenes(source: VideoSource): Promise<SceneCut[]>;

  /**
   * Transcribes speech audio to word-level timestamped tokens.
   * If the video has no audio or is visual-only, returns empty segments with isVisualOnly=true.
   */
  transcribeAudio(source: VideoSource): Promise<TranscriptResult>;

  /**
   * Trims, frames, adds subtitles, and renders an individual output clip.
   */
  renderClip(request: ClipRenderRequest): Promise<ClipRenderResult>;
}

// ---------------------------------------------------------------------------
// Persisted Job Settings (Stored in GenerationJob.settings)
// ---------------------------------------------------------------------------
export interface RenderedClipRecord {
  clipId: string;
  assetId?: string;
  storageKey: string;
  thumbnailKey?: string;
  durationSeconds: number;
  width: number;
  height: number;
  fileSizeBytes: number;
  aspectRatio: ClipperAspectRatio;
  title: string;
}

export interface CleanupAuditRecord {
  key: string;
  action: "delete";
  timestamp: string;
  success: boolean;
  error?: string;
}

export interface ClipperJobSettings {
  sourceType: "upload" | "platform_asset";
  sourceAssetId?: string;
  sourceKey: string;
  sourceDurationSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  isVisualOnly: boolean;
  targetAspectRatio: ClipperAspectRatio;
  targetFraming: ClipperFramingMode;
  burnSubtitles: boolean;
  requestedClipsCount: number;
  engine: string;
  highlights?: CandidateHighlight[];
  renderedClips?: RenderedClipRecord[];
  pendingCleanups?: string[];
  /** needs_review: keys were removed from automatic retry (ineligible or attempt cap) — see cleanupAudit. */
  cleanupStatus?: "pending" | "cleaned" | "failed" | "needs_review";
  cleanupAudit?: CleanupAuditRecord[];
  /**
   * Batch 5: duration/dimensions/audio in these settings are client HINTS for uploads
   * ("client_hint") or copied from a GeneratedAsset row ("asset_record"). The worker's FFprobe
   * result is always authoritative.
   */
  sourceMetadataOrigin?: "client_hint" | "asset_record";
  /** Verified object size at job creation. */
  sourceSizeBytes?: number;
  /** Explicit analysis limitations (scene/pacing only; no speech analysis or captions). */
  analysis?: {
    highlightMode: "scene_pacing";
    speechAnalysis: "unavailable";
    captions: "unavailable";
    originalAudio: "preserved";
  };
}

// ---------------------------------------------------------------------------
// Generic Validation Result Envelope
// ---------------------------------------------------------------------------
export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string; code: string };
