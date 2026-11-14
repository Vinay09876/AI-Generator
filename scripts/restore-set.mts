#!/usr/bin/env tsx
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  deriveManifestSigningKey,
  deriveMasterKey,
  verifyManifestSignature,
} from "./lib/backup-crypto.mjs";
import {
  assertSafeRestoreTarget,
  assertSafeStorageRestoreTarget,
} from "./lib/backup-guard.mjs";
import { runStorageRestore } from "./restore-storage.mjs";
import { runDatabaseRestore } from "./restore-db.mjs";
import type { BackupSetManifest } from "./backup-set.mjs";

/**
 * Pixora — Coordinated Disaster Recovery Restore-Set Utility
 *
 * Restoration Sequence Invariants:
 *  1. Verifies Backup Set status === "VERIFIED" and authenticates manifest HMAC signature.
 *  2. Refuses to restore if either target is production unless --confirm-production-overwrite is passed.
 *  3. Restores Storage objects FIRST.
 *  4. Restores Database SECOND (using atomic two-pass streaming).
 */

export interface RestoreSetOptions {
  setDir: string;
  targetDbUrl?: string;
  targetBucket?: string;
  confirmProductionOverwrite: boolean;
  allowUnsignedManifest: boolean;
  forceDestructiveOverwrite: boolean;
  overwrite?: boolean; // Backwards-compatible alias
  verifyOnly: boolean;
  dryRun: boolean;
  passphrase?: string;
  help: boolean;
}

export function parseArgs(args: string[]): RestoreSetOptions {
  const options: RestoreSetOptions = {
    setDir: "",
    confirmProductionOverwrite: false,
    allowUnsignedManifest: false,
    forceDestructiveOverwrite: false,
    verifyOnly: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--set" && i + 1 < args.length) {
      options.setDir = args[++i];
    } else if (arg === "--target-db" && i + 1 < args.length) {
      options.targetDbUrl = args[++i];
    } else if (arg === "--target-bucket" && i + 1 < args.length) {
      options.targetBucket = args[++i];
    } else if (arg === "--confirm-production-overwrite") {
      options.confirmProductionOverwrite = true;
    } else if (arg === "--allow-unsigned-manifest") {
      options.allowUnsignedManifest = true;
    } else if (arg === "--force-destructive-overwrite" || arg === "--overwrite") {
      options.forceDestructiveOverwrite = true;
    } else if (arg === "--verify-only") {
      options.verifyOnly = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--passphrase" && i + 1 < args.length) {
      options.passphrase = args[++i];
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
Pixora Coordinated Disaster Recovery Restore-Set Utility
========================================================

Safely restores a complete coordinated backup set:
1. Validates set status and authenticates manifest signature.
2. Restores Storage objects first (per-object safe reconciliation).
3. Restores Database second (using two-pass streaming).

Usage:
  npx tsx scripts/restore-set.mts --set <path_to_backup_set_dir> [options]

Options:
  --set <dir>                    Path to backup set directory containing backup-set.json (required).
  --target-db <url>              Destination database URL (defaults to TEST_DATABASE_URL).
  --target-bucket <bucket>       Destination storage bucket.
  --force-destructive-overwrite  Allow overwriting differing existing storage objects.
  --confirm-production-overwrite Explicit safety flag required if restoring to production.
  --verify-only                  Verify all archives and checksums without modifying target services.
  --dry-run                      Validate paths and configuration without restoring.
  --passphrase <key>             Decryption passphrase (defaults to BACKUP_ENCRYPTION_KEY).
  -h, --help                     Show this documentation.
`);
}

export async function runRestoreSet(options: RestoreSetOptions): Promise<void> {
  if (options.help || !options.setDir) {
    printHelp();
    return;
  }

  const setDir = resolve(process.cwd(), options.setDir);
  const manifestPath = join(setDir, "backup-set.json");

  if (!existsSync(manifestPath)) {
    console.error(`ERROR: Backup set manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifestRaw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as BackupSetManifest;

  console.log(`=======================================================`);
  console.log(`Restoring Coordinated Backup Set: ${manifest.backupSetId}`);
  console.log(`Set Created At: ${manifest.createdAt}`);
  console.log(`Status:         ${manifest.status}`);
  console.log(`=======================================================\n`);

  if (manifest.status !== "VERIFIED") {
    console.error(`ERROR: Backup set status is "${manifest.status}". Refusing to restore an unverified set.`);
    process.exit(1);
  }

  const passphrase = options.passphrase ?? process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!passphrase) {
    console.error("ERROR: BACKUP_ENCRYPTION_KEY is required to restore the backup set.");
    process.exit(1);
  }

  // DR-04A: Derive Master Key and dedicated domain-separated signing key
  const masterSalt = Buffer.from(`yourai:backupset:${manifest.backupSetId}:salt`);
  const masterKey = deriveMasterKey(passphrase, masterSalt);
  const signingKey = deriveManifestSigningKey(masterKey);
  const sigPath = `${manifestPath}.sig`;

  // DR-04B: Fail closed if manifest signature is missing or tampered
  if (!existsSync(sigPath)) {
    if (options.allowUnsignedManifest) {
      console.warn(`[restore-set] ⚠️ WARNING: Backup-set manifest signature (.sig) is missing. Allowed by explicit flag --allow-unsigned-manifest.`);
    } else {
      console.error(`ERROR: Backup-set manifest HMAC signature (${sigPath}) is missing. Refusing to restore unsigned backup set.`);
      console.error(`To restore legacy or unsigned backup sets, explicitly pass --allow-unsigned-manifest.`);
      process.exit(1);
    }
  } else {
    const sig = readFileSync(sigPath, "utf8").trim();
    if (!verifyManifestSignature(manifestRaw, sig, signingKey)) {
      console.error("ERROR: Backup set manifest HMAC signature verification FAILED! Manifest has been tampered with or passphrase is incorrect.");
      process.exit(1);
    }
    console.log(`[restore-set] ✅ Backup-set manifest HMAC signature verified authentic.`);
  }

  const targetDb = options.targetDbUrl || process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  const targetBucket = options.targetBucket || process.env.SUPABASE_STORAGE_BUCKET?.trim() || manifest.storage.bucket;
  const supabaseUrl = process.env.SUPABASE_URL?.trim();

  // Safety Guards
  assertSafeRestoreTarget(targetDb!, process.env.DATABASE_URL?.trim(), options.confirmProductionOverwrite);
  assertSafeStorageRestoreTarget(
    targetBucket,
    supabaseUrl,
    process.env.SUPABASE_STORAGE_BUCKET?.trim(),
    supabaseUrl,
    options.confirmProductionOverwrite
  );

  const storageManifestPath = join(setDir, "storage", "manifest.json");
  const dbDumpPath = join(setDir, "db", manifest.database.filename);

  if (options.verifyOnly) {
    console.log(`[restore-set] Running Pre-Flight Verification on Storage & Database archives...`);
    await runStorageRestore({
      manifestPath: storageManifestPath,
      targetBucket,
      verifyOnly: true,
      dryRun: false,
      forceDestructiveOverwrite: false,
      confirmProductionOverwrite: options.confirmProductionOverwrite,
      allowUnsignedManifest: options.allowUnsignedManifest,
      passphrase,
      help: false,
    });
    await runDatabaseRestore({
      file: dbDumpPath,
      targetUrl: targetDb,
      verifyOnly: true,
      dryRun: false,
      confirmProductionOverwrite: options.confirmProductionOverwrite,
      passphrase,
      help: false,
    });
    console.log(`\n[restore-set] ✅ Full Backup Set Pre-Flight Verification PASSED!`);
    return;
  }

  // STEP 1: RESTORE STORAGE FIRST (DR-03: Per-object safe reconciliation; requires explicit --force-destructive-overwrite for conflicts)
  console.log(`\n[restore-set] [Step 1/2] Reconciling Storage objects in bucket "${targetBucket}" (forceDestructiveOverwrite: ${options.forceDestructiveOverwrite})...`);
  await runStorageRestore({
    manifestPath: storageManifestPath,
    targetBucket,
    verifyOnly: false,
    dryRun: options.dryRun,
    forceDestructiveOverwrite: options.forceDestructiveOverwrite,
    confirmProductionOverwrite: options.confirmProductionOverwrite,
    allowUnsignedManifest: options.allowUnsignedManifest,
    passphrase,
    help: false,
  });

  // STEP 2: RESTORE DATABASE SECOND
  console.log(`\n[restore-set] [Step 2/2] Restoring Database from verified dump...`);
  await runDatabaseRestore({
    file: dbDumpPath,
    targetUrl: targetDb,
    verifyOnly: false,
    dryRun: options.dryRun,
    confirmProductionOverwrite: options.confirmProductionOverwrite,
    passphrase,
    help: false,
  });

  console.log(`\n=======================================================`);
  console.log(`✅ Coordinated Backup Set Restored Successfully!`);
  console.log(`=======================================================\n`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const options = parseArgs(process.argv.slice(2));
  runRestoreSet(options).catch((err) => {
    console.error("[restore-set] FATAL:", (err as Error).message);
    process.exit(1);
  });
}
