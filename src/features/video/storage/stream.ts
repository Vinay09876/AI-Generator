import { Readable, Transform } from "node:stream";
import { MAX_PROVIDER_VIDEO_BYTES } from "../config";
import { safePinnedHttpsDownload, type SsrfValidationOptions } from "./ssrf";
import { VideoStorageError } from "./types";

/**
 * Checks whether the initial 8 bytes of an ISO Base Media File Format (ISOBMFF)
 * container define an 'ftyp' box at offset 4..8.
 *
 * NOTE: This verifies the container signature and file format conformity.
 * It does NOT guarantee that the video stream within 'mdat' is decodable
 * by a specific codec (e.g. H.264 profile/level compatibility requires SPS/PPS
 * parameter set inspection in the 'avcC' box).
 */
export function validateMp4MagicBytes(headerBuffer: Buffer): boolean {
  if (!Buffer.isBuffer(headerBuffer) || headerBuffer.length < 8) {
    return false;
  }
  const boxType = headerBuffer.toString("ascii", 4, 8);
  return boxType === "ftyp";
}

export interface VideoStreamMeter {
  stream: Transform;
  getBytesRead: () => number;
}

/**
 * Creates a chunk-safe Node.js Transform stream that:
 * 1. Accumulates initial incoming bytes across arbitrary chunk boundaries until
 *    at least 8 bytes have arrived to inspect the MP4 'ftyp' signature.
 * 2. Emits an error in flush() if the stream terminates before 8 bytes are delivered.
 * 3. Enforces the maxBytes size limit continuously without buffering the video into memory.
 */
export function createVideoStreamMeter(options?: {
  maxBytes?: number;
  validateSignature?: boolean;
}): VideoStreamMeter {
  const maxBytes = options?.maxBytes ?? MAX_PROVIDER_VIDEO_BYTES;
  const validateSig = options?.validateSignature !== false;

  let bytesRead = 0;
  let headerBuffer = Buffer.alloc(0);
  let signatureChecked = false;

  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.length;

      // 1. Chunk-safe header accumulation (only up to the required 8 bytes)
      if (validateSig && !signatureChecked) {
        const needed = 8 - headerBuffer.length;
        const slice = chunk.subarray(0, needed);
        headerBuffer = Buffer.concat([headerBuffer, slice]);

        if (headerBuffer.length >= 8) {
          signatureChecked = true;
          if (!validateMp4MagicBytes(headerBuffer)) {
            const receivedType = headerBuffer.toString("ascii", 4, 8);
            return callback(
              new VideoStorageError(
                "INVALID_SIGNATURE",
                `Stream does not begin with an MP4 container header (box type is '${receivedType}', expected 'ftyp').`,
              ),
            );
          }
        }
      }

      // 2. Continuous size enforcement
      if (bytesRead > maxBytes) {
        return callback(
          new VideoStorageError(
            "TOO_LARGE",
            `Streamed video exceeds the maximum allowed size of ${maxBytes} bytes (received ${bytesRead} bytes).`,
          ),
        );
      }

      callback(null, chunk);
    },

    flush(callback) {
      // 3. Reject streams that terminated prematurely before 8 header bytes arrived
      if (validateSig && !signatureChecked) {
        return callback(
          new VideoStorageError(
            "INVALID_SIGNATURE",
            `Stream terminated prematurely (${bytesRead} bytes received) before complete MP4 container header (8 bytes) could be verified.`,
          ),
        );
      }
      callback();
    },
  });

  return {
    stream: transform,
    getBytesRead: () => bytesRead,
  };
}

export interface StreamDownloadResult {
  stream: Readable;
  mimeType: string;
  expectedSizeBytes: number | null;
  abort: () => void;
  getBytesRead: () => number;
}

/**
 * Downloads a video from an upstream provider URL using streaming with connection pinning.
 * Pins the validated public IP on the TLS socket connection, inspects the initial ISOBMFF header
 * across chunk boundaries, enforces maximum bytes, and avoids buffering the full video in memory.
 */
export async function downloadVideoStream(params: {
  videoUrl: string;
  maxBytes?: number;
  timeoutMs?: number;
  validationOptions?: SsrfValidationOptions;
}): Promise<StreamDownloadResult> {
  const { videoUrl, maxBytes = MAX_PROVIDER_VIDEO_BYTES, timeoutMs = 60_000 } = params;

  // Handle data URIs (e.g. offline mock provider fixtures)
  if (videoUrl.startsWith("data:")) {
    const commaIdx = videoUrl.indexOf(",");
    if (commaIdx === -1) {
      throw new VideoStorageError("INVALID_SIGNATURE", "Malformed data URI for video.");
    }

    const mime = videoUrl.slice(5, commaIdx).split(";")[0] || "video/mp4";
    if (mime !== "video/mp4" && mime !== "video/quicktime") {
      throw new VideoStorageError("INVALID_MIME", `Unsupported video MIME type: ${mime}`);
    }

    const isBase64 = videoUrl.slice(5, commaIdx).includes(";base64");
    const payload = isBase64
      ? Buffer.from(videoUrl.slice(commaIdx + 1), "base64")
      : Buffer.from(decodeURIComponent(videoUrl.slice(commaIdx + 1)));

    if (payload.length > maxBytes) {
      throw new VideoStorageError("TOO_LARGE", `Video exceeds maximum size limit of ${maxBytes} bytes.`);
    }

    if (!validateMp4MagicBytes(payload)) {
      throw new VideoStorageError("INVALID_SIGNATURE", "Data URI payload is not a valid MP4 container.");
    }

    const readable = Readable.from(payload);
    return {
      stream: readable,
      mimeType: "video/mp4",
      expectedSizeBytes: payload.length,
      abort: () => {},
      getBytesRead: () => payload.length,
    };
  }

  // HTTP/HTTPS Download with connection pinning and SSRF protection
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await safePinnedHttpsDownload(
      videoUrl,
      {
        method: "GET",
        headers: { Accept: "video/mp4,video/*;q=0.9,*/*;q=0.5" },
        timeoutMs,
        signal: controller.signal,
      },
      params.validationOptions,
    );

    clearTimeout(timer);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.stream.destroy();
      throw new VideoStorageError(
        "STREAM_ERROR",
        `Failed to retrieve video from provider: HTTP ${response.statusCode}`,
        response.statusCode,
      );
    }

    const contentType = (response.headers["content-type"] ?? "").toLowerCase();
    if (contentType && !contentType.includes("video/") && !contentType.includes("application/octet-stream")) {
      response.stream.destroy();
      throw new VideoStorageError("INVALID_MIME", `Unexpected content-type for video download: ${contentType}`);
    }

    const contentLengthHeader = response.headers["content-length"];
    let expectedSizeBytes: number | null = null;
    if (contentLengthHeader) {
      const parsed = parseInt(contentLengthHeader, 10);
      if (!isNaN(parsed)) {
        expectedSizeBytes = parsed;
        if (parsed > maxBytes) {
          response.stream.destroy();
          throw new VideoStorageError(
            "TOO_LARGE",
            `Provider video Content-Length (${parsed} bytes) exceeds maximum limit of ${maxBytes} bytes.`,
          );
        }
      }
    }

    // Pipe response stream through chunk-safe meter transform
    const meter = createVideoStreamMeter({ maxBytes, validateSignature: true });
    const meteredStream = response.stream.pipe(meter.stream);

    response.stream.on("error", (err) => {
      meter.stream.destroy(err);
    });

    return {
      stream: meteredStream,
      mimeType: "video/mp4",
      expectedSizeBytes,
      abort: () => {
        controller.abort();
        response.stream.destroy();
      },
      getBytesRead: meter.getBytesRead,
    };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError" || (err as Error).message?.includes("aborted")) {
      throw new VideoStorageError("STREAM_ERROR", `Video download timed out or was aborted.`);
    }
    if (err instanceof VideoStorageError) throw err;
    throw new VideoStorageError("STREAM_ERROR", `Failed to download video stream: ${(err as Error).message}`, null, {
      cause: err,
    });
  }
}
