"use client";

import type { LocalVideoMetadata } from "@/features/clipper/client";

/**
 * Reads duration and dimensions from a local file in the browser (no upload). Resolves null when
 * the browser cannot decode the container/codec or after a timeout. Used only for local checks and
 * as a hint; the worker's FFprobe result is authoritative.
 */
export function readVideoMetadata(file: Blob, timeoutMs = 30_000): Promise<LocalVideoMetadata | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let done = false;
    const finish = (value: LocalVideoMetadata | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      finish(
        Number.isFinite(video.duration) && video.duration > 0
          ? { durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight }
          : null,
      );
    video.onerror = () => finish(null);
    video.src = url;
  });
}
