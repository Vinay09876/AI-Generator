/**
 * Public clip-job view. Never exposes storage keys, lease tokens, internal error detail or
 * cleanup audit data. Always states the analysis limitations explicitly.
 */

import { CLIPPER_ANALYSIS_CAPABILITIES, type ClipperAspectRatio, type ClipperFramingMode } from "./config";
import type { ClipperJobSettings } from "./types";

export interface ClipJobRecord {
  id: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  estimatedCredits: number;
  chargedCredits: number;
  settings: unknown;
  assets: Array<{ id: string; thumbnailKey: string | null; width: number | null; height: number | null; durationSeconds: number | null }>;
}

export interface ClipView {
  assetId: string;
  title: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
}

export interface ClipJobView {
  id: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  aspectRatio: ClipperAspectRatio | null;
  framing: ClipperFramingMode | null;
  requestedClips: number | null;
  credits: { estimated: number; charged: number };
  analysis: typeof CLIPPER_ANALYSIS_CAPABILITIES;
  error: { code: string; message: string } | null;
  clips: ClipView[];
}

export interface ClipJobResponseBody {
  job: ClipJobView;
  replayed: boolean;
  balance: number | null;
}

const FAILURE_MESSAGES: Record<string, string> = {
  INSUFFICIENT_HIGHLIGHTS: "We couldn't find enough distinct moments for the clips you asked for. Credits were refunded.",
  SOURCE_TOO_SHORT: "The video is shorter than the minimum length. Credits were refunded.",
  SOURCE_TOO_LONG: "The video is longer than the maximum length. Credits were refunded.",
  RENDER_TIMEOUT: "Rendering took too long. Credits were refunded.",
  WORKER_SHUTDOWN: "Processing was interrupted. Credits were refunded.",
};

export function parseFailureCode(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  const m = /\(([A-Z][A-Z0-9_]{2,63})\)/.exec(errorMessage);
  return m ? m[1] : null;
}

export function isClipJobInProgress(status: string): boolean {
  return status === "PENDING" || status === "PROCESSING";
}

export function toClipJobView(
  record: ClipJobRecord,
  signed: Map<string, { videoUrl: string | null; thumbnailUrl: string | null }> = new Map(),
): ClipJobView {
  const s = (record.settings ?? {}) as Partial<ClipperJobSettings>;
  const titles = new Map((s.renderedClips ?? []).map((c) => [c.assetId, c.title] as const));

  let error: ClipJobView["error"] = null;
  if (record.status === "FAILED" || record.status === "CANCELLED") {
    const code = parseFailureCode(record.errorMessage) ?? (record.status === "CANCELLED" ? "CANCELLED" : "FAILED");
    error = { code, message: FAILURE_MESSAGES[code] ?? "Video clipping failed. Credits were refunded." };
  }

  return {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    aspectRatio: s.targetAspectRatio ?? null,
    framing: s.targetFraming ?? null,
    requestedClips: s.requestedClipsCount ?? null,
    credits: { estimated: record.estimatedCredits, charged: record.chargedCredits },
    analysis: CLIPPER_ANALYSIS_CAPABILITIES,
    error,
    clips:
      record.status === "COMPLETED"
        ? record.assets.map((a, i) => ({
            assetId: a.id,
            title: titles.get(a.id) ?? `Clip ${i + 1}`,
            durationSeconds: a.durationSeconds,
            width: a.width,
            height: a.height,
            videoUrl: signed.get(a.id)?.videoUrl ?? null,
            thumbnailUrl: signed.get(a.id)?.thumbnailUrl ?? null,
          }))
        : [],
  };
}
