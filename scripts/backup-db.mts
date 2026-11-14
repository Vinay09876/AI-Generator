#!/usr/bin/env tsx
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createEncryptionTransform,
  sha256File,
  verifyEncryptedStream,
} from "./lib/backup-crypto.mjs";
import {
  createSecurePassfile,
  maskRef,
  parseDatabaseConnection,
  supabaseProjectRef,
} from "./lib/backup-guard.mjs";

/**
 * Pixora — Production-Grade PostgreSQL Disaster Recovery Backup Utility
 *
 * Architecture & Security Invariants:
 *  - Uses `pg_dump` with custom archive format (`-Fc`), portable across PostgreSQL versions.
 *  - Pipes stdout directly through AES-256-GCM streaming encryption into disk.
 *  - Plaintext dumps NEVER touch the filesystem when encrypted.
 *  - Credentials passed via secure temporary PGPASSFILE or process environment.
 *  - Output directory (`backups/db/`) is git-ignored and never committed.
 *  - Generates verifiable sidecar metadata including SHA-256 checksums.
 */

export interface DbBackupOptions {
  outDir: string;
  dryRun: boolean;
  encrypt: boolean;
  verifyFile?: string;
  help: boolean;
  passphrase?: string;
  dbUrl?: string;
}

export function parseArgs(args: string[]): DbBackupOptions {
  const options: DbBackupOptions = {
    outDir: "backups/db",
    dryRun: false,
    encrypt: true,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-encrypt") {
      options.encrypt = false;
    } else if (arg === "--out" && i + 1 < args.length) {
      options.outDir = args[++i];
    } else if (arg === "--verify" && i + 1 < args.length) {
      options.verifyFile = args[++i];
    } else if (arg === "--passphrase" && i + 1 < args.length) {
      options.passphrase = args[++i];
    } else if (arg === "--db-url" && i + 1 < args.length) {
      options.dbUrl = args[++i];
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
Pixora PostgreSQL Disaster Recovery Backup Utility
==================================================

Exports a consistent, compressed custom-format (-Fc) dump of PostgreSQL and streams it
directly through AES-256-GCM encryption without leaving unencrypted data on disk.

Usage:
  npx tsx scripts/backup-db.mts [options]

Options:
  --out <dir>           Output directory (default: "backups/db").
  --no-encrypt          Do not encrypt output (plain .dump). Not recommended for production.
  --verify <file>       Verify an existing backup file's integrity and GCM authentication tag.
  --passphrase <key>    Passphrase for encryption (defaults to BACKUP_ENCRYPTION_KEY).
  --db-url <url>        Database URL to backup (defaults to DATABASE_URL).
  --dry-run             Test database connectivity without writing a dump file.
  -h, --help            Show this documentation.
`);
}

export function checkPgDump(): { available: boolean; version?: string } {
  try {
    const res = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      return { available: true, version: res.stdout.trim() };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

export async function verifyBackupFile(filePath: string, passphrase?: string): Promise<boolean> {
  const resolved = resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Backup file not found: ${resolved}`);
  }

  console.log(`[backup-db:verify] Verifying ${basename(resolved)}...`);
  const fileStats = statSync(resolved);
  const fileSha256 = await sha256File(resolved);
  console.log(`[backup-db:verify] SHA-256: ${fileSha256} (${fileStats.size} bytes)`);

  const key = passphrase ?? process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!key) {
    throw new Error("BACKUP_ENCRYPTION_KEY or --passphrase is required to verify encrypted backup.");
  }

  try {
    const stats = await verifyEncryptedStream(createReadStream(resolved), key);
    console.log(
      `[backup-db:verify] ✅ Integrity verified! Valid AES-256-GCM payload (${stats.unencryptedBytes} unencrypted bytes, plain SHA-256: ${stats.sha256}).`
    );
    return true;
  } catch (err) {
    console.error(`[backup-db:verify] ❌ Integrity check FAILED: ${(err as Error).message}`);
    return false;
  }
}

export async function runDatabaseBackup(options: DbBackupOptions): Promise<{
  filename: string;
  filePath: string;
  sha256: string;
  sizeBytes: number;
  plainSha256?: string;
  plainBytes?: number;
}> {
  if (options.help) {
    printHelp();
    return { filename: "", filePath: "", sha256: "", sizeBytes: 0 };
  }

  if (options.verifyFile) {
    const ok = await verifyBackupFile(options.verifyFile, options.passphrase);
    if (!ok) process.exit(1);
    return { filename: basename(options.verifyFile), filePath: options.verifyFile, sha256: "", sizeBytes: 0 };
  }

  const dbUrl = options.dbUrl?.trim() || process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    console.error("ERROR: DATABASE_URL is not configured.");
    process.exit(1);
  }

  const passphrase = options.passphrase ?? process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (options.encrypt && !passphrase) {
    console.error("ERROR: BACKUP_ENCRYPTION_KEY is required for encrypted backups. Set it or use --no-encrypt.");
    process.exit(1);
  }

  const projectRef = supabaseProjectRef(dbUrl);
  const targetLabel = projectRef ? `Supabase project (${maskRef(projectRef)})` : "PostgreSQL database";
  console.log(`[backup-db] Target: ${targetLabel}`);

  const pgDumpCheck = checkPgDump();
  if (!pgDumpCheck.available) {
    console.error(`
ERROR: "pg_dump" is not available on your system PATH.
Please install the PostgreSQL client tools to perform database backups.
`);
    process.exit(1);
  }
  console.log(`[backup-db] Engine: ${pgDumpCheck.version}`);

  const conn = parseDatabaseConnection(dbUrl);

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "_")
    .replace(/\..+/, "");
  const ext = options.encrypt ? "dump.enc" : "dump";
  const filename = `yourai_db_${timestamp}.${ext}`;
  const resolvedOutDir = resolve(process.cwd(), options.outDir);
  const destPath = join(resolvedOutDir, filename);

  if (options.dryRun) {
    console.log("[backup-db] DRY-RUN SUCCESSFUL:");
    console.log(`  - Target:       ${targetLabel}`);
    console.log(`  - Host:         ${conn.host}:${conn.port}`);
    console.log(`  - User:         ${conn.user}`);
    console.log(`  - Database:     ${conn.database}`);
    console.log(`  - Destination:  ${destPath}`);
    console.log(`  - Encryption:   ${options.encrypt ? "AES-256-GCM" : "None"}`);
    console.log("No data was exported (dry run).");
    return { filename, filePath: destPath, sha256: "", sizeBytes: 0 };
  }

  if (!existsSync(resolvedOutDir)) {
    mkdirSync(resolvedOutDir, { recursive: true });
  }

  console.log(`[backup-db] Starting streaming export to ${filename}...`);

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

  const dumpArgs = [
    "--format=c",
    "--no-owner",
    "--no-privileges",
    "--clean",
    "--if-exists",
  ];

  try {
    const child = spawn("pg_dump", dumpArgs, { env, stdio: ["ignore", "pipe", "pipe"] });

    let stderrOutput = "";
    child.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });

    const destFileStream = createWriteStream(destPath);
    let plainStats: { unencryptedBytes: number; sha256: string } | undefined;

    if (options.encrypt) {
      const { transform, getStats } = createEncryptionTransform(passphrase!);
      await pipeline(child.stdout, transform, destFileStream);
      plainStats = getStats();
    } else {
      await pipeline(child.stdout, destFileStream);
    }

    const code = await new Promise<number>((res) => child.on("close", res));
    if (code !== 0) {
      throw new Error(`pg_dump exited with code ${code}: ${stderrOutput}`);
    }

    const diskChecksum = await sha256File(destPath);
    const diskSizeBytes = statSync(destPath).size;

    // Write sidecar metadata
    const metaPath = destPath.replace(/\.dump\.enc$/, ".meta.json");
    writeFileSync(
      metaPath,
      JSON.stringify(
        {
          filename,
          timestamp: new Date().toISOString(),
          source: {
            host: conn.host,
            database: conn.database,
            supabaseProjectRef: projectRef ? maskRef(projectRef) : null,
          },
          format: "pg_dump_custom_v1",
          encryption: options.encrypt ? "AES-256-GCM" : "none",
          diskSha256: diskChecksum,
          diskSizeBytes,
          plainSha256: plainStats?.sha256 ?? null,
          plainSizeBytes: plainStats?.unencryptedBytes ?? null,
        },
        null,
        2
      ),
      "utf8"
    );

    console.log(`[backup-db] ✅ Backup complete!`);
    console.log(`  - File:        ${destPath}`);
    console.log(`  - Size:        ${diskSizeBytes} bytes`);
    console.log(`  - SHA-256:     ${diskChecksum}`);
    console.log(`  - Metadata:    ${metaPath}`);

    return {
      filename,
      filePath: destPath,
      sha256: diskChecksum,
      sizeBytes: diskSizeBytes,
      plainSha256: plainStats?.sha256,
      plainBytes: plainStats?.unencryptedBytes,
    };
  } finally {
    if (passfile) {
      passfile.cleanup();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const options = parseArgs(process.argv.slice(2));
  runDatabaseBackup(options).catch((err) => {
    console.error("[backup-db] FAILED:", (err as Error).message);
    process.exit(1);
  });
}
