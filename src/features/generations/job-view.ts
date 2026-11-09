import { AWAITING_RECONCILIATION_PREFIX, GENERATION_POLL_INTERVAL_S, isImageQuality, type ImageQuality } from "./config";

/**
 * Client-facing shape of an image job. Pure mapping (no database access): internal fields
 * (errorMessage reason codes, storage keys, provider details, settings) never leave here
 * except as user-safe values. The prompt is the user's own, returned only to its owner.
 */

export type ImageJobRecord = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  prompt: string | null;
  settings: unknown;
  chargedCredits: number;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
  assets: { id: string; width: number | null; height: number | null; mimeType: string | null; fileSize: bigint | null }[];
};

export type JobFailureReason = "SERVICE_BUSY" | "PROMPT_REJECTED" | "TIMED_OUT" | "FAILED";

export type ImageJobView = {
  id: string;
  status: ImageJobRecord["status"];
  quality: ImageQuality | null;
  prompt: string | null;
  creditsCharged: number;
  createdAt: string;
  completedAt: string | null;
  /** True while the provider outcome is unknown and the job awaits reconciliation (≤ ~5 min). */
  outcomeUnknown: boolean;
  error: { code: "GENERATION_FAILED"; reason: JobFailureReason; message: string; refunded: true } | null;
};

export type AssetView = { id: string; url: string; width: number | null; height: number | null; mimeType: string | null; sizeBytes: number | null };

export type JobResponseBody = { job: ImageJobView; asset: AssetView | null; replayed: boolean; balance: number | null };

const FAILURE_MESSAGES: Record<JobFailureReason, string> = {
  SERVICE_BUSY: "The image service is busy right now. Your credits were refunded — please try again later.",
  PROMPT_REJECTED: "This prompt couldn't be processed. Your credits were refunded.",
  TIMED_OUT: "The generation took too long and was cancelled. Your credits were refunded.",
  FAILED: "The image couldn't be generated. Your credits were refunded.",
};

/** Map an internal reason code to a user-safe category. Unknown codes fall back to FAILED. */
export function failureReasonFor(errorMessage: string | null): JobFailureReason {
  const m = errorMessage ?? "";
  if (/^provider_not_run:(QUOTA_EXHAUSTED|RATE_LIMITED)$/.test(m)) return "SERVICE_BUSY";
  if (m === "provider_not_run:INVALID_REQUEST") return "PROMPT_REJECTED";
  if (m.startsWith("provider_unknown:TIMEOUT") || m === "Generation timed out" || m === "Generation did not start in time") return "TIMED_OUT";
  return "FAILED";
}

export const assetUrl = (assetId: string) => `/api/assets/${encodeURIComponent(assetId)}`;

export function toJobView(record: ImageJobRecord): { job: ImageJobView; asset: AssetView | null } {
  const quality = (record.settings as { quality?: unknown } | null)?.quality;
  const failed = record.status === "FAILED" || record.status === "CANCELLED";
  const reason = failed ? failureReasonFor(record.errorMessage) : null;
  const a = record.status === "COMPLETED" ? record.assets[0] : undefined;

  return {
    job: {
      id: record.id,
      status: record.status,
      quality: isImageQuality(quality) ? quality : null,
      prompt: record.prompt,
      creditsCharged: record.chargedCredits,
      createdAt: record.createdAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
      outcomeUnknown: record.status === "PROCESSING" && (record.errorMessage ?? "").startsWith(AWAITING_RECONCILIATION_PREFIX),
      error: reason ? { code: "GENERATION_FAILED", reason, message: FAILURE_MESSAGES[reason], refunded: true } : null,
    },
    asset: a
      ? {
          id: a.id,
          url: assetUrl(a.id),
          width: a.width,
          height: a.height,
          mimeType: a.mimeType,
          sizeBytes: a.fileSize === null ? null : Number(a.fileSize),
        }
      : null,
  };
}

export const isJobInProgress = (status: ImageJobRecord["status"]) => status === "PENDING" || status === "PROCESSING";

/**
 * HTTP status for a job response (approved contract):
 *  - in progress (incl. unknown outcome)  → 202 (client polls GET /api/generations/{id})
 *  - fresh COMPLETED → 201;  fresh FAILED (refunded) → 502
 *  - replayed or fetched COMPLETED/FAILED → 200 (the job's own status says what happened)
 */
export function jobResponseStatus(status: ImageJobRecord["status"], mode: "created" | "replayed" | "fetched"): number {
  if (isJobInProgress(status)) return mode === "fetched" ? 200 : 202;
  if (mode !== "created") return 200;
  return status === "COMPLETED" ? 201 : 502;
}

export const POLL_AFTER_SECONDS = GENERATION_POLL_INTERVAL_S;
