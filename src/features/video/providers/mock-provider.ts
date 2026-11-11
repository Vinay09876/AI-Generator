import {
  MOCK_VIDEO_MODEL,
  MOCK_VIDEO_PROVIDER,
  VIDEO_ASPECT_RATIOS,
  type VideoAspectRatio,
} from "../config";
import {
  VideoProviderError,
  type CompletedVideoMetadata,
  type VideoCancelResult,
  type VideoGenerationRequest,
  type VideoJobStatusResult,
  type VideoProviderAdapter,
  type VideoProviderStatus,
  type VideoSubmitResult,
  type WebhookVerificationInput,
  type WebhookVerificationResult,
} from "../types";
import {
  MOCK_MP4_DATA_URI,
  MOCK_MP4_FIXTURE_BUFFER,
  MOCK_MP4_PLAYABLE_DATA_URI,
  MOCK_MP4_PLAYABLE_FIXTURE_BUFFER,
  MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER,
  createMockMp4Buffer,
} from "./fixture";

interface MockJobRecord {
  id: string;
  prompt: string;
  aspectRatio: VideoAspectRatio;
  duration: number;
  resolution: string;
  fps: number;
  status: VideoProviderStatus;
  checkCount: number;
  createdAt: number;
  failureTrigger?: "not_run" | "ran" | "unknown" | "policy" | "network";
  slowMode?: boolean;
}

export interface MockVideoProviderOptions {
  /** Speed of state transition. 0 = immediate completion on first check. Default is 1 check per state. */
  transitionSteps?: number;
  /**
   * Fixture mode:
   * - "structural": lightweight 631-byte ISOBMFF container (default for unit tests and aspect ratio checks)
   * - "playable": fully decodable 19,190-byte H.264 video container (for player rendering and storage tests)
   */
  fixtureMode?: "structural" | "playable";
}

/**
 * Deterministic Offline Mock Video Provider.
 *
 * Implements the VideoProviderAdapter contract with zero external network dependencies,
 * deterministic job IDs, simulated lifecycle progressions, failure triggers, and valid MP4 fixtures.
 */
export class MockVideoProvider implements VideoProviderAdapter {
  readonly id: string = MOCK_VIDEO_PROVIDER;
  readonly model: string = MOCK_VIDEO_MODEL;

  private jobs = new Map<string, MockJobRecord>();
  private jobCounter = 0;
  private readonly transitionSteps: number;
  private readonly fixtureMode: "structural" | "playable";

  constructor(options?: MockVideoProviderOptions) {
    this.transitionSteps = options?.transitionSteps ?? 1;
    this.fixtureMode = options?.fixtureMode ?? "structural";
  }

  /**
   * Resets internal in-memory job registry (useful between test runs).
   */
  reset(): void {
    this.jobs.clear();
    this.jobCounter = 0;
  }

  /**
   * Submit an asynchronous video generation request.
   */
  async submit(request: VideoGenerationRequest): Promise<VideoSubmitResult> {
    const prompt = request.prompt ?? "";

    // Simulated network failure on submit
    if (prompt.includes("[mock:fail:network]")) {
      throw new VideoProviderError({
        code: "NETWORK",
        outcome: "not_run",
        message: "Simulated network failure connecting to mock video provider",
      });
    }

    // Simulated immediate submit-time policy rejection
    if (prompt.includes("[mock:fail:immediate_policy]")) {
      throw new VideoProviderError({
        code: "CONTENT_POLICY",
        outcome: "not_run",
        message: "Prompt rejected by mock content moderation filter",
        httpStatus: 400,
      });
    }

    this.jobCounter++;
    const providerJobId = `mock-vjob-${Date.now()}-${this.jobCounter.toString().padStart(4, "0")}`;

    const aspectRatio: VideoAspectRatio =
      request.settings?.aspectRatio ?? "16:9";
    const duration = request.settings?.duration ?? 5;
    const resolution = request.settings?.resolution ?? "720p";
    const fps = request.settings?.fps ?? 16;

    let failureTrigger: MockJobRecord["failureTrigger"];
    if (prompt.includes("[mock:fail:not_run]")) failureTrigger = "not_run";
    else if (prompt.includes("[mock:fail:ran]")) failureTrigger = "ran";
    else if (prompt.includes("[mock:fail:unknown]")) failureTrigger = "unknown";
    else if (prompt.includes("[mock:fail:policy]")) failureTrigger = "policy";

    const slowMode = prompt.includes("[mock:slow]");

    const record: MockJobRecord = {
      id: providerJobId,
      prompt,
      aspectRatio,
      duration,
      resolution,
      fps,
      status: "PENDING",
      checkCount: 0,
      createdAt: Date.now(),
      failureTrigger,
      slowMode,
    };

    this.jobs.set(providerJobId, record);

    return {
      provider: this.id,
      model: this.model,
      providerJobId,
      status: "PENDING",
      queuePosition: 1,
      estimatedSeconds: 30,
    };
  }

  /**
   * Checks status of an existing mock job. Progresses state deterministically.
   */
  async checkStatus(
    providerJobId: string,
    signal?: AbortSignal
  ): Promise<VideoJobStatusResult> {
    if (signal?.aborted) {
      throw new VideoProviderError({
        code: "CANCELLED",
        outcome: "unknown",
        message: "Check status request aborted by caller",
        providerJobId,
      });
    }

    const job = this.jobs.get(providerJobId);
    if (!job) {
      throw new VideoProviderError({
        code: "INVALID_REQUEST",
        outcome: "not_run",
        message: `Mock job '${providerJobId}' not found`,
        httpStatus: 404,
        providerJobId,
      });
    }

    // Terminal states never progress further (idempotent checks)
    if (job.status === "COMPLETED") {
      return {
        providerJobId,
        status: "COMPLETED",
        metadata: this.buildMetadataForJob(job),
        metrics: { queueTimeMs: 1500, inferenceTimeMs: 3200, latencyMs: 4700 },
      };
    }

    if (job.status === "FAILED") {
      return {
        providerJobId,
        status: "FAILED",
        error: {
          code: job.failureTrigger === "policy" ? "CONTENT_POLICY" : "UPSTREAM_FAILURE",
          message: `Simulated mock failure: ${job.failureTrigger}`,
        },
      };
    }

    if (job.status === "CANCELLED") {
      return {
        providerJobId,
        status: "CANCELLED",
        error: {
          code: "CANCELLED",
          message: "Job was cancelled by user request",
        },
      };
    }

    // Handle failure triggers before moving to completed
    job.checkCount++;

    if (job.failureTrigger) {
      if (job.checkCount >= 1) {
        job.status = "FAILED";
        return {
          providerJobId,
          status: "FAILED",
          error: {
            code: job.failureTrigger === "policy" ? "CONTENT_POLICY" : "SIMULATED_FAILURE",
            message: `Simulated mock failure: ${job.failureTrigger}`,
          },
        };
      }
    }

    // Progression logic based on transitionSteps
    const threshold = job.slowMode ? 3 : this.transitionSteps;

    if (job.status === "PENDING") {
      if (job.checkCount > threshold) {
        job.status = "PROCESSING";
      }
      return {
        providerJobId,
        status: job.status,
        metrics: { queueTimeMs: 1200 },
      };
    }

    if (job.status === "PROCESSING") {
      if (job.checkCount > threshold * 2) {
        job.status = "COMPLETED";
        return {
          providerJobId,
          status: "COMPLETED",
          metadata: this.buildMetadataForJob(job),
          metrics: { queueTimeMs: 1500, inferenceTimeMs: 3200, latencyMs: 4700 },
        };
      }
      return {
        providerJobId,
        status: "PROCESSING",
        metrics: { queueTimeMs: 1500, inferenceTimeMs: 1800 },
      };
    }

    return {
      providerJobId,
      status: job.status,
    };
  }

  /**
   * Cancel an active or queued generation job.
   */
  async cancel(
    providerJobId: string,
    signal?: AbortSignal
  ): Promise<VideoCancelResult> {
    if (signal?.aborted) {
      return { providerJobId, cancelled: false, reason: "Cancellation aborted" };
    }

    const job = this.jobs.get(providerJobId);
    if (!job) {
      return {
        providerJobId,
        cancelled: false,
        reason: "Job not found",
      };
    }

    if (job.status === "COMPLETED") {
      return {
        providerJobId,
        cancelled: false,
        reason: "Job has already completed",
      };
    }

    if (job.status === "FAILED") {
      return {
        providerJobId,
        cancelled: false,
        reason: "Job has already failed",
      };
    }

    job.status = "CANCELLED";
    return {
      providerJobId,
      cancelled: true,
      reason: "Job cancelled successfully",
    };
  }

  /**
   * Build completed metadata with dimensions matching the job's requested aspect ratio.
   * If playable mode is selected (or requested via [mock:playable]), returns the 100% decodable H.264 video.
   */
  private buildMetadataForJob(job: MockJobRecord): CompletedVideoMetadata {
    const isPlayable =
      this.fixtureMode === "playable" || job.prompt.includes("[mock:playable]");

    if (isPlayable) {
      return {
        videoUrl: MOCK_MP4_PLAYABLE_DATA_URI,
        mimeType: "video/mp4",
        fileSizeBytes: MOCK_MP4_PLAYABLE_FIXTURE_BUFFER.length,
        width: 128,
        height: 96,
        durationSeconds: 1,
        fps: 16,
        thumbnailUrl: `data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA`,
      };
    }

    const dimensions = VIDEO_ASPECT_RATIOS[job.aspectRatio] ?? VIDEO_ASPECT_RATIOS["16:9"];
    const width = dimensions.width;
    const height = dimensions.height;

    // Use custom buffer if non-default dimensions, else default structural fixture buffer
    const buffer =
      width === 1280 && height === 720
        ? MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER
        : createMockMp4Buffer({ width, height, durationSeconds: job.duration });

    const videoUrl =
      width === 1280 && height === 720
        ? MOCK_MP4_DATA_URI
        : `data:video/mp4;base64,${buffer.toString("base64")}`;

    return {
      videoUrl,
      mimeType: "video/mp4",
      fileSizeBytes: buffer.length,
      width,
      height,
      durationSeconds: job.duration,
      fps: job.fps,
      thumbnailUrl: `data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA`, // 1x1 WebP placeholder
    };
  }
}
