/**
 * Browser API client for the clipper (Batch 5). Every function resolves; none throws.
 * Bodies are validated structurally before being trusted.
 */

import type { ClipJobResponseBody } from "../job-view";

export type ClipperApiError = {
  code: string;
  message: string;
  status: number | null;
  retryAfterSeconds: number | null;
};

export type ClipperApiResult<T> = { ok: true; status: number; data: T } | { ok: false; error: ClipperApiError };

export interface UploadIntent {
  uploadKey: string;
  uploadId: string;
  signedUrl: string;
  contentType: string;
  maxBytes: number;
  expiresAt: string;
}

export interface VerifiedUploadView {
  uploadKey: string;
  sizeBytes: number;
  container: string;
}

export interface ClipJobOptions {
  aspectRatio: "9:16" | "1:1" | "16:9";
  framing: "pillarbox_blur" | "center_crop" | "fit";
  clipCount: number;
}

export type ClipJobSource = { type: "upload"; uploadKey: string } | { type: "platform_asset"; assetId: string };

export interface ApiOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const FALLBACK: Record<string, string> = {
  NETWORK_ERROR: "Network connection lost. Please check your connection.",
  ABORTED: "The request was cancelled.",
  INVALID_RESPONSE: "Unexpected server response. Please try again.",
  UNKNOWN: "Something went wrong. Please try again.",
};

export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value.trim())) return null;
  return Number(value.trim());
}

async function call<T>(
  url: string,
  init: RequestInit,
  isValid: (v: unknown) => v is T,
  options: ApiOptions,
): Promise<ClipperApiResult<T>> {
  const fetchFn = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: options.signal, credentials: "same-origin" });
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    const code = aborted ? "ABORTED" : "NETWORK_ERROR";
    return { ok: false, error: { code, message: FALLBACK[code], status: null, retryAfterSeconds: null } };
  }
  const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && isValid(body)) return { ok: true, status: res.status, data: body };
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof err?.code === "string" ? err.code : res.ok ? "INVALID_RESPONSE" : "UNKNOWN";
  const message = typeof err?.message === "string" ? err.message : FALLBACK[code] ?? FALLBACK.UNKNOWN;
  return { ok: false, error: { code, message, status: res.status, retryAfterSeconds } };
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isIntent = (v: unknown): v is { upload: UploadIntent } =>
  isObj(v) && isObj(v.upload) && typeof v.upload.uploadKey === "string" && typeof v.upload.signedUrl === "string";
const isVerified = (v: unknown): v is { upload: VerifiedUploadView } =>
  isObj(v) && isObj(v.upload) && typeof v.upload.uploadKey === "string" && typeof v.upload.sizeBytes === "number";
const isDeleted = (v: unknown): v is { deleted: true } => isObj(v) && v.deleted === true;
export const isClipJobBody = (v: unknown): v is ClipJobResponseBody =>
  isObj(v) && isObj(v.job) && typeof v.job.id === "string" && typeof v.job.status === "string" && Array.isArray(v.job.clips);

export const requestUploadIntent = (input: { mimeType: string; sizeBytes: number }, o: ApiOptions = {}) =>
  call("/api/clipper/uploads", json(input), isIntent, o);

export const completeUpload = (uploadKey: string, o: ApiOptions = {}) =>
  call("/api/clipper/uploads/complete", json({ uploadKey }), isVerified, o);

export const discardUpload = (uploadKey: string, o: ApiOptions = {}) =>
  call("/api/clipper/uploads/discard", json({ uploadKey }), isDeleted, o);

export function postClipJob(
  input: { idempotencyKey: string; source: ClipJobSource; options: ClipJobOptions; hints?: { durationSeconds: number; width?: number; height?: number } },
  o: ApiOptions = {},
) {
  return call(
    "/api/generations/clip",
    json(
      { source: input.source, ...input.options, ...(input.hints ? { hints: input.hints } : {}) },
      { "Idempotency-Key": input.idempotencyKey },
    ),
    isClipJobBody,
    o,
  );
}

export const getClipJob = (jobId: string, o: ApiOptions = {}) =>
  call(`/api/generations/clip/${encodeURIComponent(jobId)}`, { method: "GET" }, isClipJobBody, o);
