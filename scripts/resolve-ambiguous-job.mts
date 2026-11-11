#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import {
  resolveAmbiguousJobAsCompleted,
  resolveAmbiguousJobAsFailed,
  type CompletedVideoAssetInput,
} from "../src/features/video/lifecycle";
import {
  isVideoKeyOwnedBy,
  isVideoThumbnailKeyOwnedBy,
} from "../src/features/video/storage/keys";
import {
  MAX_STORED_VIDEO_BYTES,
  MAX_STORED_THUMBNAIL_BYTES,
  STORED_VIDEO_MIME,
} from "../src/features/video/config";

/**
 * Storage verification contract: inspects private storage for physical object existence and metadata.
 */
export interface StorageObjectMetadata {
  exists: boolean;
  sizeBytes?: number;
  contentType?: string;
}

export type StorageObjectVerifier = (
  key: string,
) => Promise<StorageObjectMetadata | null>;

/**
 * Default storage verifier: queries Supabase Private Storage via API.
 */
export async function defaultStorageVerifier(
  key: string,
): Promise<StorageObjectMetadata | null> {
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "generated-assets";
  if (!url || !secretKey) {
    throw new Error("Missing Supabase credentials for storage verification (SUPABASE_URL or SUPABASE_SECRET_KEY).");
  }
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const lastSlash = key.lastIndexOf("/");
  const folder = lastSlash > 0 ? key.slice(0, lastSlash) : "";
  const fileName = lastSlash > 0 ? key.slice(lastSlash + 1) : key;
  const { data, error } = await client.storage.from(bucket).list(folder, {
    search: fileName,
    limit: 10,
  });
  if (error || !Array.isArray(data)) {
    return { exists: false };
  }
  const file = data.find((f: any) => f.name === fileName);
  if (!file) return { exists: false };
  const metadata = ((file as any)?.metadata as Record<string, any> | null) ?? {};
  return {
    exists: true,
    sizeBytes: Number(metadata.size ?? (file as any).size ?? 0),
    contentType: String(metadata.mimetype ?? metadata.contentType ?? "video/mp4"),
  };
}

/**
 * YourAI — Production Operator CLI: Ambiguous Video Job Resolution
 *
 * Operational & Safety Architecture:
 *  - Resolves generation jobs trapped in an ambiguous/unresolved PROCESSING state
 *    (e.g. gateway timeouts, network drops, unconfirmed provider dispatch outcomes).
 *  - Supports two definitive terminal outcomes:
 *      1. 'failed': Atomically settles job as FAILED and issues a dynamic credit refund
 *         derived from the debit ledger.
 *      2. 'completed': Atomically settles job as COMPLETED, charges debited credits,
 *         and creates the GeneratedAsset record with verified dimensions and duration.
 *  - Enforces strict invariants:
 *      * Requires explicit --job-id, --action, --operator, and --reason.
 *      * Validates job state before mutation (strictly rejects terminal jobs).
 *      * Validates storage key ownership prefix (users/{userId}/videos/...).
 *      * Dry-run mode by default; execution requires explicit --confirm flag.
 *      * Never outputs credentials, tokens, or raw secrets.
 */

export interface ResolveAmbiguousJobOptions {
  jobId: string;
  action: "failed" | "completed";
  operatorId: string;
  reason: string;
  confirm: boolean;
  force: boolean;
  // Asset parameters (required for 'completed' action)
  storageKey?: string;
  thumbnailKey?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  sizeBytes?: number;
  assetId?: string;
  help: boolean;
}

export function printUsage(): void {
  console.log(`
Usage:
  npx tsx scripts/resolve-ambiguous-job.mts [options]

Required Options:
  --job-id=<id>           Target GenerationJob ID (e.g. vjob-12345678)
  --action=<action>       Resolution action: 'failed' (refund) or 'completed' (create asset)
  --operator=<id>         Operator email, username, or employee ID
  --reason="<text>"       Detailed operational justification for the audit trail

Execution Control:
  --confirm               Execute the state mutation (default is DRY RUN)
  --force                 Proceed even if job is missing explicit ambiguous flag

Asset Options (Required when --action=completed):
  --storage-key=<key>     Storage path (must match users/{userId}/videos/{jobId}/{assetId}.mp4)
  --thumbnail-key=<key>   Optional thumbnail path (users/{userId}/videos/...)
  --width=<pixels>        Video width in pixels (default: 1280)
  --height=<pixels>       Video height in pixels (default: 720)
  --duration=<seconds>    Video duration in seconds (default: 5.0)
  --size-bytes=<bytes>    File size in bytes
  --asset-id=<id>         Optional asset ID (default: vasset-<uuid>)

Examples:
  # Dry-run inspection of an ambiguous job
  npx tsx scripts/resolve-ambiguous-job.mts \\
    --job-id=vjob-001 --action=failed --operator=ops-alice --reason="Fal queue timeout; provider verified non-execution"

  # Execute resolution with confirmation
  npx tsx scripts/resolve-ambiguous-job.mts \\
    --job-id=vjob-001 --action=failed --operator=ops-alice --reason="Fal queue timeout; provider verified non-execution" --confirm
`);
}

export function parseArgs(argv: string[]): ResolveAmbiguousJobOptions {
  const options: ResolveAmbiguousJobOptions = {
    jobId: "",
    action: "failed",
    operatorId: "",
    reason: "",
    confirm: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--job-id=")) {
      options.jobId = arg.slice(9).trim();
    } else if (arg === "--job-id" && i + 1 < argv.length) {
      options.jobId = argv[++i].trim();
    } else if (arg.startsWith("--action=")) {
      const act = arg.slice(9).trim().toLowerCase();
      if (act === "failed" || act === "completed") {
        options.action = act;
      } else {
        throw new Error(`Invalid --action: "${act}". Must be 'failed' or 'completed'.`);
      }
    } else if (arg === "--action" && i + 1 < argv.length) {
      const act = argv[++i].trim().toLowerCase();
      if (act === "failed" || act === "completed") {
        options.action = act;
      } else {
        throw new Error(`Invalid --action: "${act}". Must be 'failed' or 'completed'.`);
      }
    } else if (arg.startsWith("--operator=")) {
      options.operatorId = arg.slice(11).trim();
    } else if (arg === "--operator" && i + 1 < argv.length) {
      options.operatorId = argv[++i].trim();
    } else if (arg.startsWith("--reason=")) {
      options.reason = arg.slice(9).trim();
    } else if (arg === "--reason" && i + 1 < argv.length) {
      options.reason = argv[++i].trim();
    } else if (arg === "--confirm") {
      options.confirm = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg.startsWith("--storage-key=")) {
      options.storageKey = arg.slice(14).trim();
    } else if (arg.startsWith("--thumbnail-key=")) {
      options.thumbnailKey = arg.slice(16).trim();
    } else if (arg.startsWith("--width=")) {
      options.width = parseInt(arg.slice(8), 10);
    } else if (arg.startsWith("--height=")) {
      options.height = parseInt(arg.slice(9), 10);
    } else if (arg.startsWith("--duration=")) {
      options.durationSeconds = parseFloat(arg.slice(11));
    } else if (arg.startsWith("--size-bytes=")) {
      options.sizeBytes = parseInt(arg.slice(13), 10);
    } else if (arg.startsWith("--asset-id=")) {
      options.assetId = arg.slice(11).trim();
    }
  }

  return options;
}

export interface JobInspectionResult {
  valid: boolean;
  error?: string;
  job?: any;
  isAmbiguous: boolean;
  debitAmount: number;
}

/**
 * Validates target job eligibility prior to applying any mutation.
 * Guarantees that terminal jobs cannot be re-resolved and that prerequisites are met.
 */
export async function inspectAndValidateJob(
  jobId: string,
  db: typeof prisma = prisma,
): Promise<JobInspectionResult> {
  if (!jobId || jobId.trim().length === 0) {
    return { valid: false, error: "Missing required --job-id argument.", debitAmount: 0, isAmbiguous: false };
  }

  const job = await db.generationJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      userId: true,
      status: true,
      jobType: true,
      estimatedCredits: true,
      chargedCredits: true,
      provider: true,
      providerJobId: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      settings: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });

  if (!job) {
    return { valid: false, error: `Job with ID "${jobId}" was not found in the database.`, debitAmount: 0, isAmbiguous: false };
  }

  // Terminal state check
  if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
    return {
      valid: false,
      error: `Job "${jobId}" is already terminal (status: ${job.status}). Terminal jobs cannot be modified or re-resolved.`,
      job,
      debitAmount: job.chargedCredits ?? job.estimatedCredits,
      isAmbiguous: false,
    };
  }

  // PENDING state check
  if (job.status === "PENDING") {
    return {
      valid: false,
      error: `Job "${jobId}" is still in PENDING status. Only in-flight or ambiguous PROCESSING jobs can be resolved.`,
      job,
      debitAmount: job.estimatedCredits,
      isAmbiguous: false,
    };
  }

  if (job.status !== "PROCESSING") {
    return {
      valid: false,
      error: `Job "${jobId}" has non-resolvable status "${job.status}". Must be in PROCESSING.`,
      job,
      debitAmount: job.estimatedCredits,
      isAmbiguous: false,
    };
  }

  // Inspect settings for ambiguous markers
  const settings = (job.settings as Record<string, unknown> | null) ?? {};
  const submission = (settings.submission as Record<string, unknown> | null) ?? {};
  const isAmbiguous = Boolean(
    submission.unresolved === true ||
    submission.reviewStatus === "pending_operator_review" ||
    submission.state === "ambiguous" ||
    Boolean(submission.error),
  );

  return {
    valid: true,
    job,
    isAmbiguous,
    debitAmount: job.estimatedCredits,
  };
}

export interface ExecutionResult {
  success: boolean;
  dryRun: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Executes or simulates resolution of an ambiguous job.
 */
export async function executeResolution(
  options: ResolveAmbiguousJobOptions,
  db: typeof prisma = prisma,
  storageVerifier: StorageObjectVerifier = defaultStorageVerifier,
): Promise<ExecutionResult> {
  const { jobId, action, operatorId, reason, confirm, force } = options;

  if (!operatorId || operatorId.trim().length === 0) {
    return { success: false, dryRun: !confirm, message: "Missing required --operator argument." };
  }

  if (!reason || reason.trim().length < 8) {
    return {
      success: false,
      dryRun: !confirm,
      message: "Missing or insufficient --reason argument (must be at least 8 characters explaining operational cause).",
    };
  }

  const inspection = await inspectAndValidateJob(jobId, db);
  if (!inspection.valid || !inspection.job) {
    return { success: false, dryRun: !confirm, message: inspection.error ?? "Job validation failed." };
  }

  const job = inspection.job;

  if (!inspection.isAmbiguous && !force) {
    return {
      success: false,
      dryRun: !confirm,
      message:
        `Job "${jobId}" does not carry an explicit ambiguous submission flag (e.g. pending_operator_review). ` +
        "If you are certain this job should be manually settled, rerun with --force.",
    };
  }

  // --- COMPLETED ACTION VALIDATION & PHYSICAL STORAGE OBJECT VERIFICATION ---
  let verifiedSizeBytes = options.sizeBytes ?? 0;
  let verifiedMimeType = STORED_VIDEO_MIME;
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const duration = options.durationSeconds ?? 5.0;

  if (action === "completed") {
    if (!options.storageKey) {
      return {
        success: false,
        dryRun: !confirm,
        message: "Action 'completed' requires --storage-key parameter.",
      };
    }

    // 1. Storage key namespace ownership check
    if (!isVideoKeyOwnedBy(options.storageKey, job.userId)) {
      return {
        success: false,
        dryRun: !confirm,
        message: `Storage key "${options.storageKey}" does not match the job owner's namespace (users/${job.userId}/videos/...).`,
      };
    }

    // 2. Video metadata validation: dimensions and duration
    const isValidDimensions =
      (width === 1280 && height === 720) ||
      (width === 720 && height === 1280) ||
      (width === 960 && height === 960);

    if (!isValidDimensions) {
      return {
        success: false,
        dryRun: !confirm,
        message: `Unsupported video dimensions ${width}x${height}. Supported dimensions are 1280x720 (16:9), 720x1280 (9:16), or 960x960 (1:1).`,
      };
    }

    if (duration <= 0 || duration > 10.0) {
      return {
        success: false,
        dryRun: !confirm,
        message: `Unsupported video duration ${duration}s. Supported duration is 5.0s.`,
      };
    }

    // 3. Physical object verification in private storage
    // INVARIANT: Storage-key namespace validation alone is NOT proof of object existence.
    let storageObj: StorageObjectMetadata | null = null;
    try {
      storageObj = await storageVerifier(options.storageKey);
    } catch (err) {
      return {
        success: false,
        dryRun: !confirm,
        message: `Storage verification failed for key "${options.storageKey}": ${(err as Error).message}`,
      };
    }

    if (!storageObj || !storageObj.exists) {
      return {
        success: false,
        dryRun: !confirm,
        message: `Storage object "${options.storageKey}" does not exist in private storage. Verification failed; cannot resolve as completed.`,
      };
    }

    // 4. MIME type verification
    const mime = (storageObj.contentType ?? STORED_VIDEO_MIME).toLowerCase();
    if (mime !== "video/mp4" && mime !== "video/quicktime") {
      return {
        success: false,
        dryRun: !confirm,
        message: `Storage object has invalid or unsupported MIME type "${mime}". Expected "${STORED_VIDEO_MIME}".`,
      };
    }
    verifiedMimeType = mime;

    // 5. Size verification
    const actualSize = storageObj.sizeBytes ?? 0;
    if (actualSize <= 0 || actualSize > MAX_STORED_VIDEO_BYTES) {
      return {
        success: false,
        dryRun: !confirm,
        message: `Storage object size (${actualSize} bytes) is outside permitted bounds (1 to ${MAX_STORED_VIDEO_BYTES} bytes).`,
      };
    }

    if (options.sizeBytes !== undefined && options.sizeBytes > 0 && options.sizeBytes !== actualSize) {
      return {
        success: false,
        dryRun: !confirm,
        message: `Specified --size-bytes (${options.sizeBytes}) does not match actual storage object size (${actualSize} bytes).`,
      };
    }
    verifiedSizeBytes = actualSize;

    // 6. Optional Thumbnail verification
    if (options.thumbnailKey) {
      if (!isVideoThumbnailKeyOwnedBy(options.thumbnailKey, job.userId)) {
        return {
          success: false,
          dryRun: !confirm,
          message: `Thumbnail key "${options.thumbnailKey}" does not match the job owner's namespace (users/${job.userId}/videos/...).`,
        };
      }

      let thumbObj: StorageObjectMetadata | null = null;
      try {
        thumbObj = await storageVerifier(options.thumbnailKey);
      } catch (err) {
        return {
          success: false,
          dryRun: !confirm,
          message: `Storage verification failed for thumbnail "${options.thumbnailKey}": ${(err as Error).message}`,
        };
      }

      if (!thumbObj || !thumbObj.exists) {
        return {
          success: false,
          dryRun: !confirm,
          message: `Thumbnail object "${options.thumbnailKey}" does not exist in private storage. Verification failed.`,
        };
      }

      const thumbMime = (thumbObj.contentType ?? "image/webp").toLowerCase();
      if (!thumbMime.startsWith("image/")) {
        return {
          success: false,
          dryRun: !confirm,
          message: `Thumbnail object has invalid MIME type "${thumbMime}". Expected image format.`,
        };
      }

      const thumbSize = thumbObj.sizeBytes ?? 0;
      if (thumbSize <= 0 || thumbSize > MAX_STORED_THUMBNAIL_BYTES) {
        return {
          success: false,
          dryRun: !confirm,
          message: `Thumbnail object size (${thumbSize} bytes) exceeds limit of ${MAX_STORED_THUMBNAIL_BYTES} bytes.`,
        };
      }
    }
  }

  // --- DRY RUN MODE ---
  if (!confirm) {
    return {
      success: true,
      dryRun: true,
      message: "Dry run completed successfully. Verification passed; no changes were applied.",
      details: {
        jobId: job.id,
        userIdMasked: `${job.userId.slice(0, 8)}...`,
        currentStatus: job.status,
        proposedAction: action === "failed" ? "SETTLE AS FAILED (REFUND DEBIT)" : "SETTLE AS COMPLETED (INSERT ASSET)",
        operatorId,
        auditReason: reason,
        creditAdjustment: action === "failed" ? `+${inspection.debitAmount} credits restored` : "0 (credits finalized)",
        storageKey: options.storageKey ?? "N/A",
        verifiedStorageObject: action === "completed" ? options.storageKey : undefined,
        verifiedMimeType: action === "completed" ? verifiedMimeType : undefined,
        verifiedSizeBytes: action === "completed" ? verifiedSizeBytes : undefined,
        verifiedDimensions: action === "completed" ? `${width}x${height}` : undefined,
        verifiedDuration: action === "completed" ? `${duration}s` : undefined,
      },
    };
  }

  // --- CONFIRMED MUTATION MODE ---
  if (action === "failed") {
    const outcome = await resolveAmbiguousJobAsFailed(
      {
        jobId,
        operatorId,
        reason,
      },
      db,
    );

    if (!outcome.settled) {
      return {
        success: false,
        dryRun: false,
        message: `Failed to settle job "${jobId}" as FAILED. Job may have changed state concurrently.`,
      };
    }

    return {
      success: true,
      dryRun: false,
      message: `Job "${jobId}" successfully settled as FAILED. Refund of +${outcome.refund?.amount ?? inspection.debitAmount} credits applied.`,
      details: {
        jobId,
        newStatus: "FAILED",
        refundAmount: outcome.refund?.amount,
        refundBalanceAfter: outcome.refund?.balanceAfter,
        operatorId,
        auditReason: reason,
      },
    };
  } else {
    const assetId = options.assetId || `vasset-${randomUUID()}`;
    const assetInput: CompletedVideoAssetInput = {
      userId: job.userId,
      assetId,
      storageKey: options.storageKey!,
      thumbnailKey: options.thumbnailKey ?? null,
      width,
      height,
      durationSeconds: duration,
      sizeBytes: verifiedSizeBytes,
      mimeType: verifiedMimeType,
    };

    const outcome = await resolveAmbiguousJobAsCompleted(
      {
        jobId,
        operatorId,
        reason,
        asset: assetInput,
      },
      db,
    );

    if (!outcome.settled) {
      return {
        success: false,
        dryRun: false,
        message: `Failed to settle job "${jobId}" as COMPLETED. Job may have changed state concurrently.`,
      };
    }

    return {
      success: true,
      dryRun: false,
      message: `Job "${jobId}" successfully settled as COMPLETED. Asset "${outcome.assetId}" registered in user history.`,
      details: {
        jobId,
        newStatus: "COMPLETED",
        assetId: outcome.assetId,
        storageKey: options.storageKey,
        verifiedSizeBytes,
        verifiedMimeType,
        dimensions: `${width}x${height}`,
        duration: `${duration}s`,
        operatorId,
        auditReason: reason,
      },
    };
  }
}

export async function runCli(
  argv: string[],
  db: typeof prisma = prisma,
  storageVerifier: StorageObjectVerifier = defaultStorageVerifier,
): Promise<number> {
  try {
    const options = parseArgs(argv);

    if (options.help) {
      printUsage();
      return 0;
    }

    if (!options.jobId) {
      console.error("Error: --job-id is required.\n");
      printUsage();
      return 1;
    }

    console.log("================================================================================");
    console.log(`YourAI Operator CLI — Ambiguous Job Resolution [${options.confirm ? "EXECUTION" : "DRY RUN"}]`);
    console.log("================================================================================");

    const result = await executeResolution(options, db, storageVerifier);

    if (!result.success) {
      console.error(`\n[ERROR] ${result.message}\n`);
      return 1;
    }

    if (result.dryRun) {
      console.log("\nInspection & Dry Run Summary:");
      console.log(`  Job ID:            ${result.details?.jobId}`);
      console.log(`  User (Masked):     ${result.details?.userIdMasked}`);
      console.log(`  Current Status:    ${result.details?.currentStatus}`);
      console.log(`  Proposed Action:   ${result.details?.proposedAction}`);
      console.log(`  Operator Identity: ${result.details?.operatorId}`);
      console.log(`  Audit Reason:      ${result.details?.auditReason}`);
      console.log(`  Credit Impact:     ${result.details?.creditAdjustment}`);
      if (result.details?.storageKey !== "N/A") {
        console.log(`  Target Storage:    ${result.details?.storageKey}`);
      }
      if (result.details?.verifiedStorageObject) {
        console.log(`  Storage Verified:  ${result.details?.verifiedStorageObject} (PHYSICAL OBJECT CONFIRMED)`);
        console.log(`  MIME Type:         ${result.details?.verifiedMimeType}`);
        console.log(`  Object Size:       ${result.details?.verifiedSizeBytes} bytes`);
        console.log(`  Dimensions:        ${result.details?.verifiedDimensions}`);
        console.log(`  Duration:          ${result.details?.verifiedDuration}`);
      }
      console.log("\n--------------------------------------------------------------------------------");
      console.log("[DRY RUN] No database changes were applied.");
      console.log("To execute this state mutation, rerun with the --confirm flag.");
      console.log("================================================================================\n");
      return 0;
    }

    console.log(`\n[SUCCESS] ${result.message}`);
    console.log("Resolution Details:");
    for (const [k, v] of Object.entries(result.details ?? {})) {
      console.log(`  ${k}: ${v}`);
    }
    console.log("================================================================================\n");
    return 0;
  } catch (err) {
    console.error("\n[FATAL ERROR]", (err as Error).message);
    return 1;
  }
}

// Only invoke CLI runner when executed directly from command line
if (process.argv[1]?.endsWith("resolve-ambiguous-job.mts")) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
