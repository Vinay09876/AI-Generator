import "server-only";
import { persistImageAsset, type AssetRecordInput } from "./assets";
import { GenerationUnavailableError } from "./errors";
import type { ProcessedImage } from "./image-processing";
import type { CompletedAssetInput, ImageJobSettings } from "./lifecycle";
import type { ImageProvider, ProviderError, ProviderResult } from "./providers/types";
import type { ObjectStorage } from "./storage/types";
import { validateImageRequest } from "./validation";

/*
 * Synchronous image generation orchestrator (Stage 5).
 *
 * It only decides WHICH Stage 3 lifecycle function to call; every credit and Neuron change
 * happens inside those functions. The provider is never called inside a database
 * transaction, and every step after job creation is guarded by a status transition, so
 * races with reconciliation resolve to exactly one settlement.
 *
 *   validate → resolve provider/storage (config errors here cost nothing)
 *   → reconcile this user's stale jobs (best effort)
 *   → createImageJob (debit + reserve, one transaction)       replay → return, nothing re-runs
 *   → markJobStarted (committed before the provider call)      false → return settled state
 *   → provider.generate (no transaction open, no client abort signal)
 *   → recordProviderSuccess(actual ?? reserved)                false → late response, discard
 *   → convert to WebP → upload → completeImageJobWithAsset (guarded completion + asset row)
 *
 * All dependencies are injected so the flow can be tested without a network or database.
 */

/** The lifecycle functions the orchestrator uses (real ones come from ./lifecycle). */
export type GenerationLifecycle = {
  reconcileStaleJobs(options: { userId?: string; limit?: number }): Promise<unknown>;
  createImageJob(input: { userId: string; prompt: unknown; quality: unknown; idempotencyKey: unknown }): Promise<{
    job: { id: string; userId: string; prompt: string | null; settings: unknown };
    replayed: boolean;
  }>;
  markJobStarted(jobId: string): Promise<boolean>;
  recordProviderSuccess(jobId: string, actualCentiNeurons: number): Promise<boolean>;
  completeImageJobWithAsset(jobId: string, asset: CompletedAssetInput): Promise<unknown>;
  imageAssetExists(jobId: string, assetId: string): Promise<boolean>;
  failJobProviderNotRun(jobId: string, reason: string): Promise<unknown>;
  failJobAfterProviderSuccess(jobId: string, reason: string): Promise<unknown>;
  markProviderOutcomeUnknown(jobId: string, reason: string): Promise<unknown>;
};

export type GenerationLogger = {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
};

export type GenerationDeps = {
  lifecycle: GenerationLifecycle;
  getProvider: () => ImageProvider;
  getStorage: () => ObjectStorage;
  convertImage: (bytes: Buffer) => Promise<ProcessedImage>;
  log?: GenerationLogger;
};

/**
 * How this request ended (for logs/tests). The HTTP layer always re-reads the job, so the
 * client sees the actual persisted state, never this value.
 */
export type GenerationRunOutcome =
  | "replayed"
  | "completed"
  | "failed" // settled + refunded by this request
  | "pending" // provider outcome unknown; reconciliation will settle it
  | "superseded"; // another actor (reconciliation) settled the job first

export type GenerationRunResult = { jobId: string; replayed: boolean; outcome: GenerationRunOutcome };

const consoleLogger: GenerationLogger = {
  info: (message, data) => console.info(`[generate-image] ${message}`, data ?? {}),
  error: (message, data) => console.error(`[generate-image] ${message}`, data ?? {}),
};

// Classes are matched by name: ESM test files and app code can load separate copies.
const isProviderError = (e: unknown): e is ProviderError => (e as Error | null)?.name === "ProviderError";
const isNamedError = (e: unknown, name: string) => (e as Error | null)?.name === name;
const errorCode = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : (e as Error | null)?.name ?? "UNKNOWN";
};

/** Reason codes stored in GenerationJob.errorMessage. Never contain prompts or secrets. */
export const FAILURE_REASONS = {
  providerNotRun: (code: string) => `provider_not_run:${code}`,
  providerRan: (code: string) => `provider_ran:${code}`,
  providerUnknown: (code: string) => `provider_unknown:${code}`,
  imageInvalid: (code: string) => `image_invalid:${code}`,
  storage: (code: string) => `storage_failed:${code}`,
  assetRecord: "asset_record_failed",
} as const;

export async function runImageGeneration(
  input: { userId: string; prompt: unknown; quality: unknown; idempotencyKey: unknown },
  deps: GenerationDeps,
): Promise<GenerationRunResult> {
  const log = deps.log ?? consoleLogger;
  const { lifecycle } = deps;

  // 1. Validate before anything else (throws AccountingError INVALID_INPUT; nothing is charged).
  validateImageRequest(input);

  // 2. Resolve provider and storage BEFORE creating the job: a configuration problem must
  //    never debit credits or reserve Neurons.
  let provider: ImageProvider;
  let storage: ObjectStorage;
  try {
    provider = deps.getProvider();
    storage = deps.getStorage();
  } catch (error) {
    log.error("service not configured", { code: errorCode(error) });
    throw new GenerationUnavailableError();
  }

  // 3. Free this user's own stuck slot, if any (best effort; never blocks the request).
  try {
    await lifecycle.reconcileStaleJobs({ userId: input.userId, limit: 5 });
  } catch (error) {
    log.error("user reconciliation failed", { code: errorCode(error) });
  }

  // 4. Job + debit + reservation in one transaction. AccountingErrors propagate to the caller.
  //    A replay returns the existing job and NEVER re-runs the provider, debit or reservation.
  const { job, replayed } = await lifecycle.createImageJob(input);
  if (replayed) return { jobId: job.id, replayed: true, outcome: "replayed" };

  try {
    return { jobId: job.id, replayed: false, outcome: await processJob(job, provider, storage, deps, log) };
  } catch (error) {
    // A settlement call itself failed (e.g. database unreachable). The job stays PENDING or
    // PROCESSING and reconciliation settles it later; the caller re-reads the actual state.
    log.error("job processing interrupted", { jobId: job.id, code: errorCode(error) });
    return { jobId: job.id, replayed: false, outcome: "pending" };
  }
}

async function processJob(
  job: { id: string; userId: string; prompt: string | null; settings: unknown },
  provider: ImageProvider,
  storage: ObjectStorage,
  deps: GenerationDeps,
  log: GenerationLogger,
): Promise<GenerationRunOutcome> {
  const { lifecycle } = deps;
  const settings = job.settings as ImageJobSettings;

  // 5. Commit PROCESSING before calling the provider. False → reconciliation already settled it.
  if (!(await lifecycle.markJobStarted(job.id))) {
    log.info("job settled before start; provider not called", { jobId: job.id });
    return "superseded";
  }

  // 6. Provider call, outside any transaction. The client's abort signal is deliberately NOT
  //    passed: a closed browser tab must not turn a normal run into an "unknown" outcome.
  let result: ProviderResult;
  try {
    result = await provider.generate({ prompt: job.prompt ?? "", steps: settings.steps });
  } catch (error) {
    return settleProviderFailure(job.id, error, lifecycle, log);
  }

  // 7. Record actual usage; a missing/invalid usage value is charged at the reserved amount.
  const actual = result.usage.centiNeurons ?? settings.reservedCentiNeurons;
  if (!(await lifecycle.recordProviderSuccess(job.id, actual))) {
    // Late response: reconciliation settled the job while the provider was running.
    // The image is discarded and nothing is uploaded.
    log.info("late provider response discarded", { jobId: job.id });
    return "superseded";
  }

  // 8. Validate the JPEG and convert to WebP (in memory).
  let image: ProcessedImage;
  try {
    image = await deps.convertImage(result.bytes);
  } catch (error) {
    log.error("provider image rejected", { jobId: job.id, code: errorCode(error) });
    await lifecycle.failJobAfterProviderSuccess(job.id, FAILURE_REASONS.imageInvalid(errorCode(error)));
    return "failed";
  }

  // 9. Upload, then complete the job and insert the asset row in one transaction.
  //    If that transaction fails (or the job was settled meanwhile) the upload is deleted.
  let superseded = false;
  try {
    await persistImageAsset({
      storage,
      userId: job.userId,
      jobId: job.id,
      image,
      save: async (record: AssetRecordInput) => {
        try {
          return await lifecycle.completeImageJobWithAsset(job.id, { userId: job.userId, ...record });
        } catch (error) {
          if (isNamedError(error, "JobNotCompletableError")) {
            superseded = true;
            throw error;
          }
          // Ambiguous commit (e.g. connection lost after COMMIT): if the row exists, the job
          // completed and the object must be kept.
          if (await lifecycle.imageAssetExists(job.id, record.assetId).catch(() => false)) return null;
          throw error;
        }
      },
    });
  } catch (error) {
    const orphaned = isNamedError(error, "AssetPersistenceError") && Boolean((error as { orphanedKey?: string | null }).orphanedKey);
    if (orphaned) log.error("orphaned storage object (manual cleanup needed)", { jobId: job.id });
    if (superseded) {
      // Reconciliation settled the job first: the job state is final, the upload was removed.
      log.info("job settled during upload; upload discarded", { jobId: job.id });
      return "superseded";
    }
    const reason = isNamedError(error, "AssetPersistenceError")
      ? FAILURE_REASONS.assetRecord
      : FAILURE_REASONS.storage(errorCode(error));
    log.error("asset persistence failed", { jobId: job.id, code: errorCode(error) });
    await lifecycle.failJobAfterProviderSuccess(job.id, reason);
    return "failed";
  }

  log.info("job completed", { jobId: job.id, latencyMs: result.latencyMs, usageSource: result.usage.source });
  return "completed";
}

/** Map a provider failure to exactly one Stage 3 settlement path. */
async function settleProviderFailure(
  jobId: string,
  error: unknown,
  lifecycle: GenerationLifecycle,
  log: GenerationLogger,
): Promise<GenerationRunOutcome> {
  if (!isProviderError(error)) {
    // Unexpected exception: we cannot prove the request was not sent.
    log.error("unexpected provider exception", { jobId, code: errorCode(error) });
    await lifecycle.markProviderOutcomeUnknown(jobId, FAILURE_REASONS.providerUnknown("EXCEPTION"));
    return "pending";
  }

  log.error("provider error", { jobId, ...error.toLog() });
  switch (error.outcome) {
    case "not_run":
      await lifecycle.failJobProviderNotRun(jobId, FAILURE_REASONS.providerNotRun(error.code));
      return "failed";
    case "ran": {
      // Record reported usage first; without it, failJobAfterProviderSuccess charges the
      // reserved amount (conservative). If the job was settled meanwhile both are no-ops.
      const reported = error.usage?.centiNeurons ?? null;
      if (reported !== null) await lifecycle.recordProviderSuccess(jobId, reported);
      await lifecycle.failJobAfterProviderSuccess(jobId, FAILURE_REASONS.providerRan(error.code));
      return "failed";
    }
    default:
      // The provider may have run: no settlement and no refund while a request could be in
      // flight. reconcileStaleJobs settles it after PROCESSING_STALE_MS.
      await lifecycle.markProviderOutcomeUnknown(jobId, FAILURE_REASONS.providerUnknown(error.code));
      return "pending";
  }
}
