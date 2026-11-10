#!/usr/bin/env tsx
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  decryptBuffer,
  deriveManifestSigningKey,
  deriveMasterKey,
  deriveSubKey,
  sha256,
  verifyManifestSignature,
} from "./lib/backup-crypto.mjs";
import {
  assertSafeStorageRestoreTarget,
  requireEnvVars,
} from "./lib/backup-guard.mjs";
import type { StorageManifest } from "./backup-storage.mjs";

/**
 * YourAI — Supabase Storage Disaster Recovery Restore Utility
 *
 * Hardened Features:
 *  - Symmetric production target protection (`assertSafeStorageRestoreTarget`).
 *  - Cryptographic manifest verification using HMAC signature (`manifest.json.sig`).
 *  - Pre-flight integrity verification: validates 100% of encrypted objects before uploading.
 *  - Two-tier decryption with backward-compatible fallback for V1 backups.
 *  - Refuses silent overwrites; requires `--confirm-production-overwrite` for production buckets.
 */

export interface StorageRestoreOptions {
  manifestPath: string;
  targetBucket?: string;
  verifyOnly: boolean;
  dryRun: boolean;
  forceDestructiveOverwrite: boolean;
  overwrite?: boolean; // Backwards-compatible alias
  confirmProductionOverwrite: boolean;
  allowUnsignedManifest: boolean;
  help: boolean;
  passphrase?: string;
}

export function parseArgs(args: string[]): StorageRestoreOptions {
  const options: StorageRestoreOptions = {
    manifestPath: "backups/storage/manifest.json",
    verifyOnly: false,
    dryRun: false,
    forceDestructiveOverwrite: false,
    confirmProductionOverwrite: false,
    allowUnsignedManifest: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--verify-only") {
      options.verifyOnly = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force-destructive-overwrite" || arg === "--overwrite") {
      options.forceDestructiveOverwrite = true;
    } else if (arg === "--confirm-production-overwrite") {
      options.confirmProductionOverwrite = true;
    } else if (arg === "--allow-unsigned-manifest") {
      options.allowUnsignedManifest = true;
    } else if (arg === "--manifest" && i + 1 < args.length) {
      options.manifestPath = args[++i];
    } else if (arg === "--bucket" && i + 1 < args.length) {
      options.targetBucket = args[++i];
    } else if (arg === "--passphrase" && i + 1 < args.length) {
      options.passphrase = args[++i];
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
YourAI Supabase Storage Disaster Recovery Restore Utility
========================================================

Verifies and restores objects from an encrypted storage backup into a bucket using safe reconciliation.

Usage:
  npx tsx scripts/restore-storage.mts [options]

Options:
  --manifest <path>                  Path to manifest.json (default: "backups/storage/manifest.json").
  --bucket <name>                    Destination bucket name (defaults to SUPABASE_STORAGE_BUCKET).
  --force-destructive-overwrite      Allow overwriting differing existing objects in target bucket (defaults to false).
  --confirm-production-overwrite     Required safety confirmation if restoring/overwriting into the production bucket.
  --verify-only                      Verify encryption authentication tags and checksums without uploading.
  --dry-run                          Inspect manifest and target without uploading.
  --passphrase <key>                 Decryption passphrase (defaults to BACKUP_ENCRYPTION_KEY).
  -h, --help                         Show this documentation.
`);
}

export interface ReconcileResult {
  action: "uploaded" | "skipped" | "overwritten" | "conflict" | "error";
  key: string;
  error?: string;
}

/**
 * DR-03: Per-object safe reconciliation logic.
 *  1. Checks if object exists in destination bucket.
 *  2. If missing: uploads with upsert: false.
 *  3. If exists and plaintext SHA-256 matches: skips upload (safe retry).
 *  4. If exists and plaintext SHA-256 differs: fails closed with conflict unless forceDestructiveOverwrite is true.
 */
export async function reconcileStorageObject(
  client: { storage: { from: (bucket: string) => any } },
  bucket: string,
  key: string,
  buffer: Buffer,
  forceDestructiveOverwrite: boolean
): Promise<ReconcileResult> {
  const expectedSha256 = sha256(buffer);

  // 1. Check if object exists
  let existingData: any = null;
  let exists = false;

  try {
    const { data, error } = await client.storage.from(bucket).download(key);
    if (!error && data) {
      existingData = data;
      exists = true;
    }
  } catch {
    exists = false;
  }

  if (!exists || !existingData) {
    // Missing: upload with upsert: false
    const { error } = await client.storage.from(bucket).upload(key, buffer, {
      contentType: "image/webp",
      upsert: false,
    });
    if (error) {
      return { action: "error", key, error: error.message };
    }
    return { action: "uploaded", key };
  }

  // 2. Object exists: compare content checksum
  let existingBytes: Buffer;
  if (Buffer.isBuffer(existingData)) {
    existingBytes = existingData;
  } else if (typeof existingData.arrayBuffer === "function") {
    existingBytes = Buffer.from(await existingData.arrayBuffer());
  } else {
    existingBytes = Buffer.from(existingData);
  }

  const existingSha256 = sha256(existingBytes);

  if (existingSha256 === expectedSha256) {
    // Exact match: skip safely without destructive write
    return { action: "skipped", key };
  }

  // Differing content
  if (forceDestructiveOverwrite) {
    const { error } = await client.storage.from(bucket).upload(key, buffer, {
      contentType: "image/webp",
      upsert: true,
    });
    if (error) {
      return { action: "error", key, error: error.message };
    }
    return { action: "overwritten", key };
  }

  return {
    action: "conflict",
    key,
    error: `Target bucket contains differing object (target: ${existingSha256}, backup: ${expectedSha256}). Refusing to overwrite without --force-destructive-overwrite.`,
  };
}

export async function runStorageRestore(options: StorageRestoreOptions): Promise<void> {
  if (options.help) {
    printHelp();
    return;
  }

  const resolvedManifestPath = resolve(process.cwd(), options.manifestPath);
  if (!existsSync(resolvedManifestPath)) {
    console.error(`ERROR: Storage manifest not found: ${resolvedManifestPath}`);
    process.exit(1);
  }

  const manifestDir = dirname(resolvedManifestPath);
  const manifestRaw = readFileSync(resolvedManifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as StorageManifest;

  console.log(
    `[restore-storage] Loaded manifest with ${Object.keys(manifest.objects).length} object(s). Snapshot timestamp: ${manifest.snapshotTimestamp}`
  );

  const passphrase = options.passphrase ?? process.env.BACKUP_ENCRYPTION_KEY?.trim();
  const isEncrypted = manifest.encryption === "AES-256-GCM";

  if (isEncrypted && !passphrase) {
    console.error("ERROR: Backup is encrypted, but BACKUP_ENCRYPTION_KEY is not configured.");
    process.exit(1);
  }

  // Derive Master Key and dedicated domain-separated signing key if encrypted
  let masterKey: Buffer | undefined;
  if (isEncrypted && passphrase) {
    const masterSalt = Buffer.from(`yourai:storage:${manifest.bucket}:salt`);
    masterKey = deriveMasterKey(passphrase, masterSalt);
    const signingKey = deriveManifestSigningKey(masterKey);

    // DR-04B: Verify manifest signature sidecar with fail-closed security
    const sigPath = `${resolvedManifestPath}.sig`;
    if (existsSync(sigPath)) {
      const sig = readFileSync(sigPath, "utf8").trim();
      const validSig = verifyManifestSignature(manifestRaw, sig, signingKey);
      if (!validSig) {
        console.error("ERROR: Manifest HMAC signature verification FAILED! Manifest has been tampered with or passphrase is incorrect.");
        process.exit(1);
      }
      console.log(`[restore-storage] ✅ Manifest HMAC signature verified authentic.`);
    } else {
      if (options.allowUnsignedManifest) {
        console.warn(`[restore-storage] ⚠️ WARNING: No manifest signature (.sig) found. Proceeding because --allow-unsigned-manifest was specified.`);
      } else {
        console.error(`ERROR: Manifest HMAC signature (.sig) is missing. Refusing to restore unsigned storage backup.`);
        console.error(`To restore legacy or unsigned backups, explicitly provide --allow-unsigned-manifest.`);
        process.exit(1);
      }
    }
  }

  console.log(`[restore-storage] Verifying local backup files...`);
  let validCount = 0;
  let errorCount = 0;

  const verifiedBuffers: Map<string, Buffer> = new Map();
  const entries = Object.values(manifest.objects);

  for (const entry of entries) {
    // If object was marked deleted at snapshot time, skip restoring it
    if (entry.isDeleted) {
      continue;
    }

    const diskPath = resolve(manifestDir, entry.encryptedFile);
    if (!existsSync(diskPath)) {
      console.error(`  ❌ Missing file on disk for key "${entry.storageKey}": ${diskPath}`);
      errorCount++;
      continue;
    }

    try {
      const diskBytes = readFileSync(diskPath);
      let plainBytes: Buffer;

      if (isEncrypted) {
        try {
          // Attempt V2 HKDF subkey decryption first
          if (masterKey) {
            const subKey = deriveSubKey(masterKey, `storage:${entry.storageKey}`);
            plainBytes = decryptBuffer(diskBytes, subKey, true);
          } else {
            plainBytes = decryptBuffer(diskBytes, passphrase!);
          }
        } catch {
          // Fallback to legacy V1 direct passphrase decryption
          plainBytes = decryptBuffer(diskBytes, passphrase!);
        }
      } else {
        plainBytes = diskBytes;
      }

      // Verify SHA-256 checksum
      const computedSha256 = sha256(plainBytes);
      if (computedSha256 !== entry.sha256) {
        throw new Error(`Checksum mismatch! Expected ${entry.sha256}, got ${computedSha256}`);
      }

      if (plainBytes.length !== entry.size) {
        throw new Error(`Size mismatch! Expected ${entry.size} bytes, got ${plainBytes.length}`);
      }

      verifiedBuffers.set(entry.storageKey, plainBytes);
      validCount++;
    } catch (err) {
      console.error(`  ❌ Integrity validation failed for "${entry.storageKey}": ${(err as Error).message}`);
      errorCount++;
    }
  }

  console.log(`[restore-storage] Verification results: ${validCount} valid, ${errorCount} errors.`);

  if (errorCount > 0) {
    console.error("ERROR: One or more backup files failed integrity verification. Aborting.");
    process.exit(1);
  }

  if (options.verifyOnly) {
    console.log("[restore-storage] ✅ All objects verified successfully! (Verify-only mode, no upload).");
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const targetBucket = options.targetBucket || process.env.SUPABASE_STORAGE_BUCKET?.trim() || manifest.bucket;

  requireEnvVars([
    { name: "SUPABASE_URL", value: supabaseUrl },
    { name: "SUPABASE_SECRET_KEY", value: secretKey },
  ]);

  // ACCIDENTAL PRODUCTION OVERWRITE GUARD
  const prodBucket = process.env.SUPABASE_STORAGE_BUCKET?.trim();
  const { isProductionBucket } = assertSafeStorageRestoreTarget(
    targetBucket,
    supabaseUrl,
    prodBucket,
    supabaseUrl,
    options.confirmProductionOverwrite
  );

  console.log(
    `[restore-storage] Destination Bucket: "${targetBucket}" ${
      isProductionBucket ? "[PRODUCTION BUCKET]" : "[NON-PRODUCTION BUCKET]"
    }`
  );

  if (options.dryRun) {
    console.log(`[restore-storage] DRY-RUN SUCCESSFUL:`);
    console.log(`  - Target Bucket:              ${targetBucket}`);
    console.log(`  - Verified Count:             ${verifiedBuffers.size} objects ready for safe reconciliation`);
    console.log(`  - Force Destructive Overwrite: ${options.forceDestructiveOverwrite ? "Enabled" : "Disabled"}`);
    console.log("No objects were uploaded (dry run).");
    return;
  }

  const client = createClient(supabaseUrl!, secretKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`[restore-storage] Reconciling ${verifiedBuffers.size} objects in bucket "${targetBucket}"...`);
  let uploadedCount = 0;
  let skippedCount = 0;
  let overwrittenCount = 0;
  let conflictCount = 0;

  for (const [key, buffer] of verifiedBuffers.entries()) {
    const result = await reconcileStorageObject(
      client,
      targetBucket,
      key,
      buffer,
      options.forceDestructiveOverwrite
    );

    if (result.action === "uploaded") {
      console.log(`  ✅ Uploaded missing object: ${key} (${buffer.length} bytes)`);
      uploadedCount++;
    } else if (result.action === "skipped") {
      console.log(`  ⏩ Skipped identical object: ${key} (SHA-256 match, safe retry)`);
      skippedCount++;
    } else if (result.action === "overwritten") {
      console.warn(`  ⚠️ Overwritten differing object: ${key} (--force-destructive-overwrite applied)`);
      overwrittenCount++;
    } else if (result.action === "conflict") {
      console.error(`  ❌ CONFLICT for "${key}": ${result.error}`);
      conflictCount++;
      errorCount++;
    } else {
      console.error(`  ❌ Failed to upload "${key}": ${result.error}`);
      errorCount++;
    }
  }

  console.log(
    `\n[restore-storage] Finished: ${uploadedCount} uploaded, ${skippedCount} skipped, ${overwrittenCount} overwritten, ${conflictCount} conflicts, ${errorCount} errors.`
  );
  if (errorCount > 0) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const options = parseArgs(process.argv.slice(2));
  runStorageRestore(options).catch((err) => {
    console.error("[restore-storage] Fatal error:", (err as Error).message);
    process.exit(1);
  });
}
