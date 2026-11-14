#!/usr/bin/env tsx
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createDecryptionTransform,
  sha256File,
  verifyEncryptedStream,
} from "./lib/backup-crypto.mjs";
import {
  assertSafeRestoreTarget,
  createSecurePassfile,
  maskRef,
  parseDatabaseConnection,
} from "./lib/backup-guard.mjs";

/**
 * Pixora — PostgreSQL Disaster Recovery Restore Utility (Hardened Two-Pass Streaming)
 *
 * Safety & Security Invariants:
 *  1. Two-Pass Streaming Decryption:
 *     - Pass 1: Cryptographic pre-flight authentication (decrypts into a discard sink).
 *       Validates 100% of the archive and GCM auth tag in constant RAM ($O(1)$) BEFORE starting pg_restore.
 *     - Pass 2: Authenticated streaming directly into pg_restore stdin.
 *     - Never writes plaintext to disk.
 *  2. Refuses to restore to production DATABASE_URL unless --confirm-production-overwrite is provided.
 *  3. Executes inside a single transaction (--single-transaction) for atomic rollback on errors.
 *  4. Stderr analysis on exit code 1 to catch silent table restoration errors.
 *  5. Secure temporary PGPASSFILE credential transport with automatic shredding and cleanup.
 */

export interface RestoreOptions {
  file?: string;
  targetUrl?: string;
  confirmProductionOverwrite: boolean;
  verifyOnly: boolean;
  dryRun: boolean;
  help: boolean;
  passphrase?: string;
}

export function parseArgs(args: string[]): RestoreOptions {
  const options: RestoreOptions = {
    confirmProductionOverwrite: false,
    verifyOnly: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--file" && i + 1 < args.length) {
      options.file = args[++i];
    } else if (arg === "--target-url" && i + 1 < args.length) {
      options.targetUrl = args[++i];
    } else if (arg === "--passphrase" && i + 1 < args.length) {
      options.passphrase = args[++i];
    } else if (arg === "--confirm-production-overwrite") {
      options.confirmProductionOverwrite = true;
    } else if (arg === "--verify-only") {
      options.verifyOnly = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
Pixora PostgreSQL Disaster Recovery Restore Utility
===================================================

Restores an encrypted or unencrypted PostgreSQL custom-format backup using two-pass streaming.

Usage:
  npx tsx scripts/restore-db.mts --file <backup_file> [options]

Options:
  --file <path>                  Path to .dump.enc or .dump file (required).
  --target-url <url>             Destination database URL (defaults to TEST_DATABASE_URL).
  --confirm-production-overwrite Explicit safety flag required if target URL is the production database.
  --verify-only                  Verify GCM decryption and integrity without restoring to a database.
  --dry-run                      Validate target and backup file without executing pg_restore.
  --passphrase <key>             Decryption passphrase (defaults to BACKUP_ENCRYPTION_KEY).
  -h, --help                     Show this documentation.

Safety Note:
  Restoring to the production database will drop and recreate tables.
  The tool strictly refuses to restore to production unless --confirm-production-overwrite is provided.
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
 * Distinguishes strictly harmless DROP IF EXISTS notices from fatal errors when pg_restore exits with code 1.
 * Fails closed: treats any nonzero exit code as fatal unless stderr consists exclusively of harmless drop notices.
 */
export function isFatalPgRestoreError(stderr: string): boolean {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // If pg_restore exited with code 1 but gave empty stderr, fail closed (unclassified failure)
  if (lines.length === 0) {
    return true;
  }

  // Strictly harmless drop notices: e.g. pg_restore: notice: table "..." does not exist, skipping drop
  const harmlessDropRegex =
    /^pg_restore:\s*(?:notice|warning):\s*(?:table|sequence|view|index|type|function|collation|schema|foreign table|materialized view)\s*".*"\s*does not exist, skipping drop/i;

  for (const line of lines) {
    if (!harmlessDropRegex.test(line)) {
      // Any SQL error, permission denied, disk quota, connection loss, or unknown message is fatal
      return true;
    }
  }

  // All lines were exclusively harmless drop notices
  return false;
}

export async function runDatabaseRestore(options: RestoreOptions): Promise<void> {
  if (options.help || !options.file) {
    printHelp();
    return;
  }

  const filePath = resolve(process.cwd(), options.file);
  if (!existsSync(filePath)) {
    console.error(`ERROR: Backup file not found: ${filePath}`);
    process.exit(1);
  }

  const fileStats = statSync(filePath);
  console.log(`[restore-db] Reading backup file: ${basename(filePath)} (${fileStats.size} bytes)...`);

  const fileChecksum = await sha256File(filePath);
  console.log(`[restore-db] Disk SHA-256: ${fileChecksum}`);

  const passphrase = options.passphrase ?? process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!passphrase) {
    console.error("ERROR: BACKUP_ENCRYPTION_KEY is required to restore encrypted backups.");
    process.exit(1);
  }

  // DR-01A: CREATE PROTECTED INPUT SNAPSHOT
  // Create an exclusively owned, private temporary snapshot directory to prevent both path
  // replacement and in-place file mutation between Pass 1 (verification) and Pass 2 (restore).
  const tempDir = mkdtempSync(resolve(tmpdir(), "yourai-restore-db-"));
  const snapshotPath = resolve(tempDir, "protected-snapshot.dump.enc");

  let activeChild: import("node:child_process").ChildProcess | null = null;
  let snapshotFd: number | null = null;

  const performCleanup = (exitSignalCode?: number) => {
    if (activeChild && !activeChild.killed) {
      try {
        activeChild.kill("SIGTERM");
      } catch {}
    }
    if (snapshotFd !== null) {
      try {
        closeSync(snapshotFd);
      } catch {}
      snapshotFd = null;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    if (exitSignalCode !== undefined) {
      process.exit(exitSignalCode);
    }
  };

  const sigintHandler = () => performCleanup(130);
  const sigtermHandler = () => performCleanup(143);

  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  try {
    // Atomically copy file into isolated private directory
    copyFileSync(filePath, snapshotPath, constants.COPYFILE_EXCL);

    // Verify snapshot stability and integrity
    const snapshotStats = statSync(snapshotPath);
    if (snapshotStats.size !== fileStats.size) {
      throw new Error(`Protected snapshot size mismatch: expected ${fileStats.size}, got ${snapshotStats.size}`);
    }

    const snapshotChecksum = await sha256File(snapshotPath);
    if (snapshotChecksum !== fileChecksum) {
      throw new Error(`Protected snapshot checksum mismatch: expected ${fileChecksum}, got ${snapshotChecksum}`);
    }

    // Open file descriptor once for the pinned protected snapshot
    snapshotFd = openSync(snapshotPath, "r");

    // PASS 1: PRE-FLIGHT CRYPTOGRAPHIC VERIFICATION (DRY SINK)
    // Constant-memory streaming verification: validates 100% of the archive and GCM auth tag
    // BEFORE any database connection or pg_restore process is initiated.
    console.log("[restore-db] [Pass 1/2] Pre-flight verification: validating AES-256-GCM authentication tag...");
    let verifiedStats: { unencryptedBytes: number; sha256: string };
    try {
      verifiedStats = await verifyEncryptedStream(
        createReadStream("", { fd: snapshotFd, autoClose: false, start: 0 }),
        passphrase
      );
      console.log(
        `[restore-db] ✅ Pass 1 Verified! Authenticated ${verifiedStats.unencryptedBytes} unencrypted bytes (Plaintext SHA-256: ${verifiedStats.sha256}).`
      );
    } catch (err) {
      console.error(
        `[restore-db] ❌ Pass 1 Verification failed: ${(err as Error).message}. Target database was untouched.`
      );
      process.exit(1);
    }

    if (options.verifyOnly) {
      console.log("[restore-db] ✅ Backup integrity is 100% valid. (Verify-only mode, no database restore performed).");
      return;
    }

    // Determine target database: default to TEST_DATABASE_URL for safety if not specified
    const targetUrl =
      options.targetUrl?.trim() || process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
    if (!targetUrl) {
      console.error("ERROR: No target database URL available. Provide --target-url or set TEST_DATABASE_URL / DATABASE_URL.");
      process.exit(1);
    }

    // ACCIDENTAL OVERWRITE SAFETY GUARD
    const prodUrl = process.env.DATABASE_URL?.trim();
    const { targetRef, isProduction } = assertSafeRestoreTarget(
      targetUrl,
      prodUrl,
      options.confirmProductionOverwrite
    );

    const targetLabel = targetRef ? `Supabase project (${maskRef(targetRef)})` : "PostgreSQL database";
    console.log(`[restore-db] Destination: ${targetLabel} ${isProduction ? "[PRODUCTION]" : "[NON-PRODUCTION]"}`);

    const conn = parseDatabaseConnection(targetUrl);

    if (options.dryRun) {
      console.log("[restore-db] DRY-RUN SUCCESSFUL:");
      console.log(`  - Target:       ${targetLabel}`);
      console.log(`  - Host:         ${conn.host}:${conn.port}`);
      console.log(`  - Database:     ${conn.database}`);
      console.log(`  - Backup File:  ${filePath}`);
      console.log(`  - Dump Size:    ${verifiedStats.unencryptedBytes} unencrypted bytes`);
      console.log("No database writes performed (dry run).");
      return;
    }

    const pgRestoreCheck = checkPgRestore();
    if (!pgRestoreCheck.available) {
      console.error(`
ERROR: "pg_restore" is not available on your system PATH.
Please install the PostgreSQL client tools to perform database restores.
`);
      process.exit(1);
    }

    // PASS 2: AUTHENTICATED STREAMING RESTORE
    console.log(`[restore-db] [Pass 2/2] Streaming verified dump to pg_restore against ${targetLabel}...`);

    const passfile = createSecurePassfile(conn);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGHOST: conn.host,
      PGPORT: conn.port,
      PGUSER: conn.user,
      PGDATABASE: conn.database,
      PGSSLMODE: "require",
    };

    if (passfile) {
      env.PGPASSFILE = passfile.filePath;
    } else if (conn.password) {
      env.PGPASSWORD = conn.password;
    }

    // Transactional restore: clean existing objects, run inside a single transaction for atomic rollback
    const restoreArgs = [
      "--single-transaction",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ];

    try {
      const child = spawn("pg_restore", restoreArgs, { env, stdio: ["pipe", "inherit", "pipe"] });
      activeChild = child;

      let stderrOutput = "";
      child.stderr.on("data", (chunk) => {
        stderrOutput += chunk.toString();
      });

      const decTransform = createDecryptionTransform(passphrase);

      // Stream directly from the exact same protected snapshot descriptor through decipher into pg_restore stdin
      try {
        await pipeline(
          createReadStream("", { fd: snapshotFd, autoClose: false, start: 0 }),
          decTransform,
          child.stdin
        );
      } catch (pipelineErr) {
        // If stream decipher fails or pipe closes unexpectedly, terminate child immediately
        child.kill("SIGTERM");
        throw pipelineErr;
      }

      const code = await new Promise<number>((res) => child.on("close", res));
      activeChild = null;

      if (code === 0) {
        console.log(`[restore-db] ✅ Restore completed cleanly (exit code 0)!`);
      } else if (code === 1) {
        if (isFatalPgRestoreError(stderrOutput)) {
          console.error(`[restore-db] ❌ pg_restore failed with errors (exit code 1):\n${stderrOutput}`);
          process.exit(1);
        } else {
          console.log(`[restore-db] ✅ Restore completed with non-fatal drop notices (exit code 1).`);
        }
      } else {
        console.error(`[restore-db] ❌ pg_restore failed with exit code ${code}:\n${stderrOutput}`);
        process.exit(1);
      }
    } finally {
      activeChild = null;
      if (passfile) {
        passfile.cleanup();
      }
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
    performCleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const options = parseArgs(process.argv.slice(2));
  runDatabaseRestore(options).catch((err) => {
    console.error("[restore-db] FAILED:", (err as Error).message);
    process.exit(1);
  });
}
