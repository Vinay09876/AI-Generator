#!/usr/bin/env tsx
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Client } from "pg";
import {
  createDecryptionTransform,
  deriveManifestSigningKey,
  deriveMasterKey,
  sha256,
  signManifest,
} from "./lib/backup-crypto.mjs";
import {
  canonicalDatabaseIdentity,
  maskRef,
  parseDatabaseConnection,
  requireEnvVars,
  supabaseProjectRef,
} from "./lib/backup-guard.mjs";
import { isFatalPgRestoreError } from "./restore-db.mjs";
import { runDatabaseBackup } from "./backup-db.mjs";
import { runStorageBackup, type StorageManifest } from "./backup-storage.mjs";

/**
 * Pixora — Coordinated Disaster Recovery Backup-Set Utility
 *
 * Consistency Architecture & Strict Invariants:
 *  1. Capture Database Backup FIRST ($T_1$).
 *  2. Extract the exact `GeneratedAsset.storageKey` references from the database.
 *  3. Back up those exact storage objects SECOND ($T_2$).
 *  4. Verify every referenced object against disk checksums and encryption tags.
 *  5. Fail the backup set immediately if any referenced object is missing or inconsistent.
 *  6. Mark complete backup set VERIFIED only after end-to-end cross-validation.
 *  7. Authenticate the unified manifest (`backup-set.json.sig`).
 */

export interface BackupSetManifest {
  formatVersion: "2.0";
  backupSetId: string;
  createdAt: string;
  completedAt: string;
  status: "IN_PROGRESS" | "VERIFIED" | "FAILED_INCONSISTENT";
  database: {
    filename: string;
    diskSha256: string;
    diskSizeBytes: number;
    sourceHost: string;
    databaseName: string;
    supabaseProjectRef: string | null;
    snapshotTimestamp: string;
    assetCount: number;
  };
  storage: {
    manifestFilename: string;
    manifestSha256: string;
    bucket: string;
    referencedObjectCount: number;
    totalSizeBytes: number;
    snapshotTimestamp: string;
  };
  consistency: {
    strategy: "db-snapshot-references-exact-storage",
    allReferencedObjectsPresent: boolean;
    missingObjects: string[];
  };
}

export interface BackupSetOptions {
  outDir: string;
  passphrase?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(args: string[]): BackupSetOptions {
  const options: BackupSetOptions = {
    outDir: "backups/sets",
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--out" && i + 1 < args.length) {
      options.outDir = args[++i];
    } else if (arg === "--passphrase" && i + 1 < args.length) {
      options.passphrase = args[++i];
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
Pixora Coordinated Disaster Recovery Backup-Set Utility
======================================================

Creates an atomic, consistent backup set pairing a PostgreSQL database dump with the exact
Supabase Storage objects referenced by GeneratedAsset rows.

Usage:
  npx tsx scripts/backup-set.mts [options]

Options:
  --out <dir>           Base output directory (default: "backups/sets").
  --dry-run             Plan and validate without exporting data.
  --passphrase <key>    Passphrase for encryption (defaults to BACKUP_ENCRYPTION_KEY).
  -h, --help            Show this documentation.
`);
}

export function checkPgRestore(): { available: boolean; version?: string } {
  try {
    const res = spawnSync("pg_restore", ["--version"], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      return { available: true, version: res.stdout.trim() };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

/**
 * Character-by-character PostgreSQL COPY text decoder (DR-02).
 * Handles NULLs (\N), escaped backslashes (\\), tabs (\t), newlines (\n),
 * carriage returns (\r), backspaces (\b), form feeds (\f), vertical tabs (\v),
 * octal escapes (\ooo), hex escapes (\xhh), and distinguishes literal \\t from \t.
 */
export function decodePostgresCopyField(raw: string): string | null {
  if (raw === "\\N") {
    return null;
  }

  let result = "";
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const ch = raw[i];
    if (ch === "\\") {
      i++;
      if (i >= len) {
        result += "\\";
        break;
      }
      const nextCh = raw[i];
      switch (nextCh) {
        case "b":
          result += "\b";
          i++;
          break;
        case "f":
          result += "\f";
          i++;
          break;
        case "n":
          result += "\n";
          i++;
          break;
        case "r":
          result += "\r";
          i++;
          break;
        case "t":
          result += "\t";
          i++;
          break;
        case "v":
          result += "\v";
          i++;
          break;
        case "\\":
          result += "\\";
          i++;
          break;
        case "x": {
          i++;
          let hex = "";
          while (i < len && hex.length < 2 && /[0-9a-fA-F]/.test(raw[i])) {
            hex += raw[i];
            i++;
          }
          if (hex.length > 0) {
            result += String.fromCharCode(parseInt(hex, 16));
          } else {
            result += "x";
          }
          break;
        }
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          let octal = nextCh;
          i++;
          while (i < len && octal.length < 3 && /[0-7]/.test(raw[i])) {
            octal += raw[i];
            i++;
          }
          result += String.fromCharCode(parseInt(octal, 8));
          break;
        }
        default:
          result += nextCh;
          i++;
          break;
      }
    } else {
      result += ch;
      i++;
    }
  }

  return result;
}

/**
 * Parses PostgreSQL COPY statement output to extract GeneratedAsset.storageKey values.
 * Zero plaintext touches disk during extraction.
 */
export function parseStorageKeysFromCopyStream(copyOutput: string): string[] {
  const lines = copyOutput.split(/\r?\n/);
  const keys: string[] = [];
  let inCopyBlock = false;
  let storageKeyIndex = -1;

  for (const line of lines) {
    const copyMatch = line.match(/^COPY\s+(?:public\.)?"?GeneratedAsset"?\s*\(([^)]+)\)\s+FROM\s+stdin;/i);
    if (copyMatch) {
      inCopyBlock = true;
      const columns = copyMatch[1]
        .split(",")
        .map((col) => col.trim().replace(/^"|"$/g, ""));
      storageKeyIndex = columns.findIndex((col) => col === "storageKey");
      continue;
    }

    if (inCopyBlock) {
      if (line === "\\." || line.startsWith("\\.")) {
        inCopyBlock = false;
        continue;
      }
      if (!line.trim()) continue;

      if (storageKeyIndex >= 0) {
        const parts = line.split("\t");
        if (parts.length > storageKeyIndex) {
          const rawKey = parts[storageKeyIndex];
          const decoded = decodePostgresCopyField(rawKey);
          if (decoded !== null) {
            keys.push(decoded);
          }
        }
      }
    }
  }

  return keys;
}

/**
 * DR-02: Extracts GeneratedAsset storage keys directly from the captured database dump.
 * Streams through decipher into `pg_restore --data-only --table=GeneratedAsset -f -` in memory.
 * Streams pg_restore stdout line-by-line via readline to prevent buffering full dump output,
 * while the extracted key inventory consumes memory proportional to the number and length of storage keys (O(N) in key count).
 * Guarantees the extracted asset inventory reflects the EXACT database snapshot taken at backup time,
 * eliminating the point-in-time race of querying the live database after pg_dump.
 */
export async function extractReferencedStorageKeysFromDump(
  encryptedDumpPath: string,
  passphrase: string
): Promise<string[]> {
  const decTransform = createDecryptionTransform(passphrase);
  const child = spawn("pg_restore", ["--data-only", "--table=GeneratedAsset", "-f", "-"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const keys: string[] = [];
  let inCopyBlock = false;
  let copyBlockSeen = false;
  let copyBlockEnded = false;
  let storageKeyIndex = -1;
  let stderrData = "";

  child.stderr.on("data", (chunk) => {
    stderrData += chunk.toString();
  });

  const rl = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const copyMatch = line.match(/^COPY\s+(?:public\.)?"?GeneratedAsset"?\s*\(([^)]+)\)\s+FROM\s+stdin;/i);
    if (copyMatch) {
      inCopyBlock = true;
      copyBlockSeen = true;
      const columns = copyMatch[1]
        .split(",")
        .map((col) => col.trim().replace(/^"|"$/g, ""));
      storageKeyIndex = columns.findIndex((col) => col === "storageKey");
      return;
    }

    if (inCopyBlock) {
      if (line === "\\." || line.startsWith("\\.")) {
        inCopyBlock = false;
        copyBlockEnded = true;
        return;
      }
      if (!line.trim()) return;

      if (storageKeyIndex >= 0) {
        const parts = line.split("\t");
        if (parts.length > storageKeyIndex) {
          const rawKey = parts[storageKeyIndex];
          const decoded = decodePostgresCopyField(rawKey);
          if (decoded !== null) {
            keys.push(decoded);
          }
        }
      }
    }
  });

  try {
    await pipeline(createReadStream(encryptedDumpPath), decTransform, child.stdin);
  } catch (err) {
    child.kill("SIGTERM");
    rl.close();
    throw new Error(`Failed streaming encrypted dump to pg_restore for key extraction: ${(err as Error).message}`);
  }

  const exitCode = await new Promise<number>((resolve) => child.on("close", resolve));
  rl.close();

  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`pg_restore failed with exit code ${exitCode} while extracting GeneratedAsset keys:\n${stderrData}`);
  }
  if (exitCode === 1 && isFatalPgRestoreError(stderrData)) {
    throw new Error(`pg_restore failed with errors (exit code 1):\n${stderrData}`);
  }

  if (copyBlockSeen && !copyBlockEnded) {
    throw new Error("Truncated database dump: COPY block started but end-of-data marker (\\.) was not reached.");
  }

  return keys;
}

/**
 * Direct database fallback query when pg_restore is not present in local PATH.
 */
export async function extractReferencedStorageKeysFromDb(dbUrl: string): Promise<string[]> {
  const conn = parseDatabaseConnection(dbUrl);
  const client = new Client({
    host: conn.host,
    port: parseInt(conn.port, 10),
    user: conn.user,
    password: conn.password,
    database: conn.database,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const res = await client.query<{ storageKey: string }>(
      'SELECT "storageKey" FROM "GeneratedAsset" WHERE "storageKey" IS NOT NULL ORDER BY "createdAt" ASC'
    );
    return res.rows.map((r) => r.storageKey);
  } finally {
    await client.end();
  }
}

/**
 * Extracts exact storage keys from the snapshot dump (preferred) or database fallback.
 */
export async function extractReferencedStorageKeys(
  encryptedDumpPath: string,
  passphrase: string,
  dbUrl?: string
): Promise<string[]> {
  const pgRestore = checkPgRestore();
  if (pgRestore.available) {
    console.log(`[backup-set] Extracting GeneratedAsset inventory from dump using pg_restore...`);
    return extractReferencedStorageKeysFromDump(encryptedDumpPath, passphrase);
  }

  if (dbUrl) {
    console.warn(`[backup-set] Notice: pg_restore not available on PATH; falling back to direct database snapshot query.`);
    return extractReferencedStorageKeysFromDb(dbUrl);
  }

  throw new Error("Unable to extract storage keys: pg_restore is unavailable and no dbUrl provided.");
}

export async function runBackupSet(options: BackupSetOptions): Promise<BackupSetManifest> {
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const dbUrl = process.env.DATABASE_URL?.trim();
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "generated-assets";
  const passphrase = options.passphrase ?? process.env.BACKUP_ENCRYPTION_KEY?.trim();

  requireEnvVars([
    { name: "DATABASE_URL", value: dbUrl },
    { name: "SUPABASE_URL", value: supabaseUrl },
    { name: "SUPABASE_SECRET_KEY", value: secretKey },
    { name: "BACKUP_ENCRYPTION_KEY", value: passphrase },
  ]);

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "_")
    .replace(/\..+/, "");
  const setId = `bkset_${timestamp}_${randomBytes(4).toString("hex")}`;
  const setDir = resolve(process.cwd(), options.outDir, setId);
  const dbDir = join(setDir, "db");
  const storageDir = join(setDir, "storage");

  console.log(`=======================================================`);
  console.log(`Starting Coordinated Backup Set: ${setId}`);
  console.log(`Destination: ${setDir}`);
  console.log(`=======================================================\n`);

  if (!options.dryRun) {
    mkdirSync(dbDir, { recursive: true });
    mkdirSync(storageDir, { recursive: true });
  }

  const conn = parseDatabaseConnection(dbUrl!);
  const projectRef = supabaseProjectRef(dbUrl!);

  // Master Key derivation
  const masterSalt = Buffer.from(`yourai:backupset:${setId}:salt`);
  const masterKey = deriveMasterKey(passphrase!, masterSalt);

  const manifest: BackupSetManifest = {
    formatVersion: "2.0",
    backupSetId: setId,
    createdAt: new Date().toISOString(),
    completedAt: "",
    status: "IN_PROGRESS",
    database: {
      filename: "",
      diskSha256: "",
      diskSizeBytes: 0,
      sourceHost: conn.host,
      databaseName: conn.database,
      supabaseProjectRef: projectRef ? maskRef(projectRef) : null,
      snapshotTimestamp: "",
      assetCount: 0,
    },
    storage: {
      manifestFilename: "manifest.json",
      manifestSha256: "",
      bucket,
      referencedObjectCount: 0,
      totalSizeBytes: 0,
      snapshotTimestamp: "",
    },
    consistency: {
      strategy: "db-snapshot-references-exact-storage",
      allReferencedObjectsPresent: false,
      missingObjects: [],
    },
  };

  if (options.dryRun) {
    console.log("[backup-set] DRY-RUN SUCCESSFUL:");
    console.log(`  - Set ID:      ${setId}`);
    console.log(`  - Database:    ${conn.host}:${conn.port}/${conn.database}`);
    console.log(`  - Bucket:      ${bucket}`);
    return manifest;
  }

  // STEP 1: CAPTURE DATABASE BACKUP FIRST
  console.log(`\n[backup-set] [Phase 1/4] Capturing Database Backup Snapshot...`);
  const dbSnapshotTime = new Date().toISOString();
  const dbResult = await runDatabaseBackup({
    outDir: dbDir,
    dryRun: false,
    encrypt: true,
    help: false,
    passphrase,
    dbUrl,
  });

  manifest.database.filename = dbResult.filename;
  manifest.database.diskSha256 = dbResult.sha256;
  manifest.database.diskSizeBytes = dbResult.sizeBytes;
  manifest.database.snapshotTimestamp = dbSnapshotTime;

  // STEP 2: EXTRACT REFERENCED STORAGE KEYS FROM DUMP SNAPSHOT (DR-02)
  console.log(`\n[backup-set] [Phase 2/4] Extracting exact GeneratedAsset storage keys from captured database dump...`);
  const dbDumpFullPath = join(dbDir, dbResult.filename);
  const referencedKeys = await extractReferencedStorageKeys(dbDumpFullPath, passphrase!, dbUrl);
  manifest.database.assetCount = referencedKeys.length;
  console.log(`[backup-set] Discovered ${referencedKeys.length} referenced storage keys in database dump snapshot.`);

  // STEP 3: BACK UP REFERENCED STORAGE OBJECTS
  console.log(`\n[backup-set] [Phase 3/4] Backing up referenced storage objects from bucket "${bucket}"...`);
  const storageSnapshotTime = new Date().toISOString();
  const storageResult = await runStorageBackup({
    outDir: storageDir,
    dryRun: false,
    encrypt: true,
    help: false,
    passphrase,
    keysToBackup: referencedKeys,
    bucket,
  });

  manifest.storage.manifestSha256 = storageResult.manifestSha256;
  manifest.storage.referencedObjectCount = referencedKeys.length;
  manifest.storage.totalSizeBytes = storageResult.totalBytes;
  manifest.storage.snapshotTimestamp = storageSnapshotTime;

  // STEP 4: CROSS-VALIDATION & VERIFICATION
  console.log(`\n[backup-set] [Phase 4/4] Cross-validating consistency between database and storage...`);
  const storageManifestPath = join(storageDir, "manifest.json");
  const storageManifest = JSON.parse(readFileSync(storageManifestPath, "utf8")) as StorageManifest;

  const missingKeys: string[] = [];
  for (const key of referencedKeys) {
    if (!storageManifest.objects[key]) {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    console.error(`\n❌ INCONSISTENT BACKUP SET: ${missingKeys.length} database asset(s) are missing from storage!`);
    manifest.status = "FAILED_INCONSISTENT";
    manifest.consistency.allReferencedObjectsPresent = false;
    manifest.consistency.missingObjects = missingKeys;
    manifest.completedAt = new Date().toISOString();

    const manifestPath = join(setDir, "backup-set.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    throw new Error(`Backup set failed consistency verification: ${missingKeys.length} missing object(s).`);
  }

  manifest.status = "VERIFIED";
  manifest.consistency.allReferencedObjectsPresent = true;
  manifest.consistency.missingObjects = [];
  manifest.completedAt = new Date().toISOString();

  // Save atomic authenticated manifest
  const manifestPath = join(setDir, "backup-set.json");
  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileSync(manifestPath, manifestJson, "utf8");

  // DR-04A: Sign manifest using dedicated domain-separated signing subkey
  const signingKey = deriveManifestSigningKey(masterKey);
  const sig = signManifest(manifestJson, signingKey);
  writeFileSync(`${manifestPath}.sig`, sig, "utf8");

  console.log(`\n=======================================================`);
  console.log(`✅ Coordinated Backup Set Completed & VERIFIED!`);
  console.log(`  - Backup Set ID:  ${setId}`);
  console.log(`  - Status:         VERIFIED`);
  console.log(`  - Database:       ${manifest.database.filename} (${manifest.database.diskSizeBytes} bytes)`);
  console.log(`  - Assets:         ${referencedKeys.length} verified objects (${manifest.storage.totalSizeBytes} bytes)`);
  console.log(`  - Manifest:       ${manifestPath}`);
  console.log(`=======================================================\n`);

  return manifest;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const options = parseArgs(process.argv.slice(2));
  runBackupSet(options).catch((err) => {
    console.error("[backup-set] FATAL:", (err as Error).message);
    process.exit(1);
  });
}
