/**
 * VideoSource Abstraction & Controlled Resource Management.
 *
 * Provides a memory-safe, stream-friendly abstraction for video media:
 * 1. Prevents buffering entire multi-megabyte videos in application heap.
 * 2. Unifies local worker file paths and remote storage keys under one interface.
 * 3. Enforces bounded streaming/download into controlled temporary storage.
 * 4. Ensures explicit cleanup ownership so temporary scratch files are always unlinked.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Readable } from "node:stream";
import { getClipperMaxUploadBytes } from "./config";

export type VideoSourceKind = "local_file" | "storage_reference";

export interface VideoSourceMaterialization {
  /** Absolute local file system path where the video is accessible for FFmpeg/probe. */
  localPath: string;
  /** Explicit cleanup handler to release and unlink the localized file when finished. */
  cleanup: () => Promise<void>;
}

export interface MaterializeOptions {
  /** Directory for temporary staging files. Defaults to system tmpdir / scratch. */
  scratchDir?: string;
  /** Maximum bytes allowed to be materialized. Defaults to getClipperMaxUploadBytes(). */
  maxBytes?: number;
  /** Custom storage download stream provider (injected by storage adapters). */
  downloadStreamProvider?: (storageKey: string) => Promise<Readable>;
}

export interface VideoSource {
  readonly kind: VideoSourceKind;
  /** Human-readable or debug identifier (e.g. file path or storage key). */
  readonly identifier: string;
  /** Known file size in bytes, if available prior to materialization. */
  readonly fileSizeBytes?: number;
  /** MIME type, if known (e.g. "video/mp4"). */
  readonly mimeType?: string;

  /**
   * Resolves the video source to a verified local file path for worker processing.
   * If the source is already a local file, returns the path with a no-op or owner cleanup.
   * If the source is a remote storage reference, streams it into a bounded scratch file.
   */
  materialize(options?: MaterializeOptions): Promise<VideoSourceMaterialization>;

  /**
   * Explicitly disposes of any resources held directly by this source descriptor.
   */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 1. Local File Video Source
// ---------------------------------------------------------------------------
export class LocalFileVideoSource implements VideoSource {
  readonly kind = "local_file" as const;
  readonly identifier: string;
  readonly filePath: string;
  readonly fileSizeBytes?: number;
  readonly mimeType?: string;
  private readonly autoCleanup: boolean;
  private isDisposed = false;

  constructor(params: {
    filePath: string;
    fileSizeBytes?: number;
    mimeType?: string;
    /** If true, calling dispose() will unlink the local file. Default false. */
    autoCleanup?: boolean;
  }) {
    this.filePath = path.resolve(params.filePath);
    this.identifier = this.filePath;
    this.fileSizeBytes = params.fileSizeBytes;
    this.mimeType = params.mimeType;
    this.autoCleanup = Boolean(params.autoCleanup);
  }

  async materialize(): Promise<VideoSourceMaterialization> {
    if (this.isDisposed) {
      throw new Error(`Cannot materialize disposed LocalFileVideoSource: ${this.filePath}`);
    }
    // Verify file exists on disk
    try {
      const stats = await fsp.stat(this.filePath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a regular file: ${this.filePath}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Local video source file not accessible (${this.filePath}): ${msg}`);
    }

    return {
      localPath: this.filePath,
      cleanup: async () => {
        // Local files are owned by the caller unless autoCleanup was explicitly set
        if (this.autoCleanup && !this.isDisposed) {
          await this.dispose();
        }
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.autoCleanup) {
      try {
        await fsp.unlink(this.filePath);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Storage Reference Video Source
// ---------------------------------------------------------------------------
export class StorageReferenceVideoSource implements VideoSource {
  readonly kind = "storage_reference" as const;
  readonly identifier: string;
  readonly storageKey: string;
  readonly fileSizeBytes?: number;
  readonly mimeType?: string;
  private readonly activeMaterializations: Set<string> = new Set();
  private isDisposed = false;

  constructor(params: {
    storageKey: string;
    fileSizeBytes?: number;
    mimeType?: string;
  }) {
    this.storageKey = params.storageKey;
    this.identifier = params.storageKey;
    this.fileSizeBytes = params.fileSizeBytes;
    this.mimeType = params.mimeType;
  }

  async materialize(options?: MaterializeOptions): Promise<VideoSourceMaterialization> {
    if (this.isDisposed) {
      throw new Error(`Cannot materialize disposed StorageReferenceVideoSource: ${this.storageKey}`);
    }

    const maxBytes = options?.maxBytes ?? getClipperMaxUploadBytes();
    if (this.fileSizeBytes && this.fileSizeBytes > maxBytes) {
      throw new Error(
        `Storage video file size (${this.fileSizeBytes} bytes) exceeds maximum allowed size (${maxBytes} bytes).`,
      );
    }

    const scratchDir = options?.scratchDir ?? os.tmpdir();
    await fsp.mkdir(scratchDir, { recursive: true });

    const safeStem = path.basename(this.storageKey).replace(/[^A-Za-z0-9_-]/g, "_");
    const tempFileName = `clipper_src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeStem}.tmp`;
    const tempFilePath = path.join(scratchDir, tempFileName);

    if (!options?.downloadStreamProvider) {
      // In tests or mock environments without a live storage provider, create an empty placeholder or throw
      throw new Error(
        `downloadStreamProvider is required to materialize storage reference: ${this.storageKey}`,
      );
    }

    const readable = await options.downloadStreamProvider(this.storageKey);
    const writeStream = fs.createWriteStream(tempFilePath);

    let bytesReceived = 0;

    await new Promise<void>((resolve, reject) => {
      readable.on("data", (chunk: Buffer | Uint8Array) => {
        bytesReceived += chunk.length;
        if (bytesReceived > maxBytes) {
          readable.destroy();
          writeStream.destroy();
          fsp.unlink(tempFilePath).catch(() => {});
          reject(
            new Error(
              `Streamed storage source exceeded maximum size limit (${maxBytes} bytes). Transfer aborted.`,
            ),
          );
        }
      });

      readable.on("error", (err) => {
        writeStream.destroy();
        fsp.unlink(tempFilePath).catch(() => {});
        reject(err);
      });

      writeStream.on("error", (err) => {
        readable.destroy();
        fsp.unlink(tempFilePath).catch(() => {});
        reject(err);
      });

      writeStream.on("finish", () => {
        resolve();
      });

      readable.pipe(writeStream);
    });

    this.activeMaterializations.add(tempFilePath);

    const cleanup = async () => {
      this.activeMaterializations.delete(tempFilePath);
      try {
        await fsp.unlink(tempFilePath);
      } catch {
        // Best effort
      }
    };

    return { localPath: tempFilePath, cleanup };
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const tempPath of this.activeMaterializations) {
      try {
        await fsp.unlink(tempPath);
      } catch {
        // Best effort
      }
    }
    this.activeMaterializations.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory Helpers
// ---------------------------------------------------------------------------
export function createLocalFileSource(filePath: string, options?: { fileSizeBytes?: number; mimeType?: string; autoCleanup?: boolean }): LocalFileVideoSource {
  return new LocalFileVideoSource({
    filePath,
    fileSizeBytes: options?.fileSizeBytes,
    mimeType: options?.mimeType,
    autoCleanup: options?.autoCleanup,
  });
}

export function createStorageReferenceSource(storageKey: string, options?: { fileSizeBytes?: number; mimeType?: string }): StorageReferenceVideoSource {
  return new StorageReferenceVideoSource({
    storageKey,
    fileSizeBytes: options?.fileSizeBytes,
    mimeType: options?.mimeType,
  });
}
