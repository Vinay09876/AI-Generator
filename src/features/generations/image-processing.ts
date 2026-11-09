import "server-only";
import sharp, { type Metadata, type OutputInfo } from "sharp";
import {
  MAX_IMAGE_DIMENSION,
  MAX_PROVIDER_IMAGE_BYTES,
  MAX_STORED_IMAGE_BYTES,
  MIN_IMAGE_DIMENSION,
  STORED_IMAGE_MIME,
  WEBP_QUALITY,
} from "./config";

/**
 * Provider JPEG → validated WebP (quality 85). The JPEG only ever exists in memory;
 * it is never stored. Decoding is bounded (bytes and pixels) to resist decompression bombs.
 */

export type ImageValidationCode = "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_FORMAT" | "INVALID_IMAGE" | "INVALID_DIMENSIONS" | "CONVERSION_FAILED";

export class ImageValidationError extends Error {
  constructor(
    public readonly code: ImageValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageValidationError";
  }
}

export type ProcessedImage = {
  buffer: Buffer;
  mimeType: typeof STORED_IMAGE_MIME;
  width: number;
  height: number;
  sizeBytes: number;
};

const MAX_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION;
const isJpegSignature = (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isWebpSignature = (b: Buffer) =>
  b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP";

export async function convertProviderImageToWebp(
  input: Buffer,
  options: { maxOutputBytes?: number } = {},
): Promise<ProcessedImage> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_STORED_IMAGE_BYTES;

  if (!input || input.length === 0) throw new ImageValidationError("EMPTY", "Provider returned an empty image.");
  if (input.length > MAX_PROVIDER_IMAGE_BYTES) throw new ImageValidationError("TOO_LARGE", "Provider image exceeds the size limit.");
  // Signature check before handing bytes to the decoder: only JPEG is expected from FLUX.1 Schnell.
  if (!isJpegSignature(input)) throw new ImageValidationError("UNSUPPORTED_FORMAT", "Provider image is not a JPEG.");

  const sharpOptions = { limitInputPixels: MAX_PIXELS, failOn: "error" as const };

  let meta: Metadata;
  try {
    // Header-only read (no pixel decode), so oversized images are reported as
    // INVALID_DIMENSIONS below; the pixel limit still guards the full decode.
    meta = await sharp(input, { limitInputPixels: false, failOn: "error" }).metadata();
  } catch {
    throw new ImageValidationError("INVALID_IMAGE", "Provider image could not be decoded.");
  }
  if (meta.format !== "jpeg") throw new ImageValidationError("UNSUPPORTED_FORMAT", "Provider image is not a JPEG.");
  const { width, height } = meta;
  if (
    !width || !height ||
    width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION ||
    width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
  ) {
    throw new ImageValidationError("INVALID_DIMENSIONS", "Provider image dimensions are out of range.");
  }

  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await sharp(input, sharpOptions).webp({ quality: WEBP_QUALITY }).toBuffer({ resolveWithObject: true });
  } catch {
    // Full decode failed (e.g. truncated data that passed the header check).
    throw new ImageValidationError("INVALID_IMAGE", "Provider image could not be converted.");
  }

  const { data, info } = output;
  if (info.format !== "webp" || !isWebpSignature(data)) {
    throw new ImageValidationError("CONVERSION_FAILED", "Converted image is not a valid WebP.");
  }
  if (info.width !== width || info.height !== height) {
    throw new ImageValidationError("CONVERSION_FAILED", "Converted image dimensions do not match the source.");
  }
  if (data.length === 0 || data.length > maxOutputBytes) {
    throw new ImageValidationError("TOO_LARGE", "Converted image exceeds the storage size limit.");
  }

  return { buffer: data, mimeType: STORED_IMAGE_MIME, width, height, sizeBytes: data.length };
}
