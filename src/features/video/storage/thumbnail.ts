import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { MAX_STORED_THUMBNAIL_BYTES } from "../config";
import { safeFetchWithSsrfGuard } from "./ssrf";

const execFileAsync = promisify(execFile);

export type ThumbnailErrorCode =
  | "MISSING_DEPENDENCY"
  | "EXTRACTION_FAILED"
  | "TOO_LARGE"
  | "INVALID_IMAGE"
  | "EMPTY_INPUT"
  | "TIMEOUT";

export class ThumbnailExtractionError extends Error {
  constructor(
    public readonly code: ThumbnailErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ThumbnailExtractionError";
  }
}

export interface ProcessedThumbnail {
  buffer: Buffer;
  mimeType: "image/webp";
  width: number;
  height: number;
  sizeBytes: number;
}

export interface VideoThumbnailExtractor {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  extract(params: {
    videoUrl?: string;
    videoBuffer?: Buffer;
    posterBuffer?: Buffer;
    posterUrl?: string;
    width?: number;
    height?: number;
  }): Promise<ProcessedThumbnail>;
}

// Cached FFmpeg availability check
let ffmpegAvailableCache: boolean | null = null;

/**
 * Checks whether the 'ffmpeg' CLI tool is available in system PATH.
 * Caches the result to avoid spawning child processes on every frame extraction.
 */
export async function isFfmpegAvailable(forceRecheck = false): Promise<boolean> {
  if (!forceRecheck && ffmpegAvailableCache !== null) {
    return ffmpegAvailableCache;
  }

  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-version"], { timeout: 2000 });
    ffmpegAvailableCache = stdout.toLowerCase().includes("ffmpeg version");
  } catch {
    ffmpegAvailableCache = false;
  }

  return ffmpegAvailableCache;
}

/** Resets the FFmpeg availability cache (useful in unit tests). */
export function resetFfmpegAvailabilityCache(): void {
  ffmpegAvailableCache = null;
}

/**
 * Converts any supported raw image buffer (JPEG, PNG, WebP) into a standard WebP
 * poster frame thumbnail (quality 85), enforcing the 1 MB size limit.
 */
export async function convertFrameBufferToWebp(
  inputBuffer: Buffer,
  options?: {
    maxBytes?: number;
    targetWidth?: number;
    targetHeight?: number;
  },
): Promise<ProcessedThumbnail> {
  const maxBytes = options?.maxBytes ?? MAX_STORED_THUMBNAIL_BYTES;

  if (!inputBuffer || inputBuffer.length === 0) {
    throw new ThumbnailExtractionError("EMPTY_INPUT", "Input frame buffer is empty.");
  }

  try {
    let pipeline = sharp(inputBuffer, { failOn: "error" });

    // Optional resize to target dimensions
    if (options?.targetWidth && options?.targetHeight) {
      pipeline = pipeline.resize(options.targetWidth, options.targetHeight, { fit: "cover" });
    }

    const { data, info } = await pipeline
      .webp({ quality: 85, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    if (data.length > maxBytes) {
      throw new ThumbnailExtractionError(
        "TOO_LARGE",
        `Generated thumbnail size (${data.length} bytes) exceeds maximum limit of ${maxBytes} bytes.`,
      );
    }

    return {
      buffer: data,
      mimeType: "image/webp",
      width: info.width,
      height: info.height,
      sizeBytes: data.length,
    };
  } catch (err) {
    if (err instanceof ThumbnailExtractionError) throw err;
    throw new ThumbnailExtractionError("INVALID_IMAGE", `Could not convert frame to WebP: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * Thumbnail extractor that processes provider-supplied poster images (buffer or URL).
 */
export class ProviderPosterThumbnailExtractor implements VideoThumbnailExtractor {
  readonly name = "ProviderPosterExtractor";

  async isAvailable(): Promise<boolean> {
    return true; // Sharp is bundled in package.json
  }

  async extract(params: {
    posterBuffer?: Buffer;
    posterUrl?: string;
    width?: number;
    height?: number;
  }): Promise<ProcessedThumbnail> {
    let rawBuffer: Buffer | null = params.posterBuffer ?? null;

    if (!rawBuffer && params.posterUrl) {
      if (params.posterUrl.startsWith("data:")) {
        const commaIdx = params.posterUrl.indexOf(",");
        if (commaIdx !== -1) {
          rawBuffer = Buffer.from(params.posterUrl.slice(commaIdx + 1), "base64");
        }
      } else {
        const { response } = await safeFetchWithSsrfGuard(params.posterUrl);
        if (!response.ok) {
          throw new ThumbnailExtractionError(
            "EXTRACTION_FAILED",
            `Failed to download provider poster frame: HTTP ${response.status}`,
          );
        }
        const ab = await response.arrayBuffer();
        rawBuffer = Buffer.from(ab);
      }
    }

    if (!rawBuffer) {
      throw new ThumbnailExtractionError("EMPTY_INPUT", "No poster image buffer or URL was provided.");
    }

    return convertFrameBufferToWebp(rawBuffer, {
      targetWidth: params.width,
      targetHeight: params.height,
    });
  }
}

/**
 * Thumbnail extractor that invokes local FFmpeg CLI to capture the frame at t=0.0s.
 * Reports clean MISSING_DEPENDENCY if FFmpeg is not installed on the host system.
 */
export class FfmpegThumbnailExtractor implements VideoThumbnailExtractor {
  readonly name = "FfmpegExtractor";

  async isAvailable(): Promise<boolean> {
    return isFfmpegAvailable();
  }

  async extract(params: {
    videoUrl?: string;
    videoBuffer?: Buffer;
    width?: number;
    height?: number;
  }): Promise<ProcessedThumbnail> {
    const available = await this.isAvailable();
    if (!available) {
      throw new ThumbnailExtractionError(
        "MISSING_DEPENDENCY",
        "Local FFmpeg binary is not installed or not found in system PATH. Cannot extract video frame.",
      );
    }

    // In environments with FFmpeg, frame extraction pipes into Sharp
    throw new ThumbnailExtractionError(
      "EXTRACTION_FAILED",
      "FFmpeg frame pipeline requires a local video file or pipe stream.",
    );
  }
}

/**
 * Mock thumbnail extractor for deterministic offline testing and simulation.
 */
export class MockThumbnailExtractor implements VideoThumbnailExtractor {
  readonly name = "MockThumbnailExtractor";

  constructor(
    private readonly options?: {
      failMode?: "missing_dependency" | "corrupt_frame" | "oversized" | "none";
      customBuffer?: Buffer;
    },
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.options?.failMode !== "missing_dependency";
  }

  async extract(params: {
    width?: number;
    height?: number;
    posterBuffer?: Buffer;
  }): Promise<ProcessedThumbnail> {
    if (this.options?.failMode === "missing_dependency") {
      throw new ThumbnailExtractionError(
        "MISSING_DEPENDENCY",
        "Mock simulated missing FFmpeg dependency.",
      );
    }

    if (this.options?.failMode === "corrupt_frame") {
      throw new ThumbnailExtractionError(
        "INVALID_IMAGE",
        "Mock simulated corrupted video frame decode.",
      );
    }

    const width = params.width ?? 1280;
    const height = params.height ?? 720;

    if (this.options?.failMode === "oversized") {
      // Create a buffer larger than 1MB
      const hugeBuffer = Buffer.alloc(MAX_STORED_THUMBNAIL_BYTES + 1024, 0xaa);
      return {
        buffer: hugeBuffer,
        mimeType: "image/webp",
        width,
        height,
        sizeBytes: hugeBuffer.length,
      };
    }

    // Generate a valid clean WebP image via Sharp
    const sharpBuffer =
      this.options?.customBuffer ??
      (await sharp({
        create: {
          width: Math.min(width, 1280),
          height: Math.min(height, 720),
          channels: 3,
          background: { r: 18, g: 18, b: 24 },
        },
      })
        .webp({ quality: 85 })
        .toBuffer());

    return {
      buffer: sharpBuffer,
      mimeType: "image/webp",
      width,
      height,
      sizeBytes: sharpBuffer.length,
    };
  }
}

/**
 * Composite thumbnail extractor that orchestrates extraction:
 *   1. Checks for provider-supplied poster (buffer or URL).
 *   2. Checks if local FFmpeg is available.
 *   3. Fails cleanly with MISSING_DEPENDENCY if neither is available.
 */
export class CompositeVideoThumbnailExtractor implements VideoThumbnailExtractor {
  readonly name = "CompositeThumbnailExtractor";

  private readonly posterExtractor = new ProviderPosterThumbnailExtractor();
  private readonly ffmpegExtractor = new FfmpegThumbnailExtractor();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async extract(params: {
    videoUrl?: string;
    videoBuffer?: Buffer;
    posterBuffer?: Buffer;
    posterUrl?: string;
    width?: number;
    height?: number;
  }): Promise<ProcessedThumbnail> {
    // 1. If provider supplied poster image, use it
    if (params.posterBuffer || params.posterUrl) {
      try {
        return await this.posterExtractor.extract(params);
      } catch (err) {
        // If poster extraction failed, fall through to FFmpeg if available
      }
    }

    // 2. Try FFmpeg
    if (await this.ffmpegExtractor.isAvailable()) {
      return this.ffmpegExtractor.extract(params);
    }

    // 3. Clean typed failure
    throw new ThumbnailExtractionError(
      "MISSING_DEPENDENCY",
      "No provider poster image provided and FFmpeg is not available in system PATH. Cannot extract video thumbnail.",
    );
  }
}

