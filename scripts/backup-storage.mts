#!/usr/bin/env tsx
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createDecryptionTransform,
  decryptBuffer,
  deriveManifestSigningKey,
  deriveMasterKey,
  deriveSubKey,
  encryptBuffer,
  sha256,
  signManifest,
} from "./lib/backup-crypto.mjs";
import { requireEnvVars } from "./lib/backup-guard.mjs";

/**
 * Pixora — Production-Grade Supabase Storage Disaster Recovery Utility
 *
 * Hardened Features:
 *  - Concurrent process mutex via atomic lockfile (`.backup.lock`).
 *  - Two-tier key hierarchy: PBKDF2 Master Key derived once; fast HKDF per object.
 *  - Atomic downloads: writes to `.enc.tmp`, validates size and header, then atomically renames.
 *  - Incremental verification: validates file size and binary header before skipping cached objects.
 *  - Authenticated manifest: signs `manifest.json` with HMAC-SHA256 (`manifest.json.sig`).
 *  - Deleted object tracking: records live activeKeys snapshot; distinguishes deleted objects.
 *  - Selective backup support: accepts `keysToBackup` list for database snapshot consistency.
 */

export interface StorageManifestEntry {
  storageKey: string;
  size: number;
  sha256: string;
  encryptedFile: string;
  encryptedSize: number;
  isDeleted?: boolean;
  backedUpAt: string;
}

export interface StorageManifest {
  version: 2;
  bucket: string;
  snapshotTimestamp: string;
  encryption: "AES-256-GCM" | "none";
  activeKeys: string[];
  objects: Record<string, StorageManifestEntry>;
}

export interface StorageBackupOptions {
  outDir: string;
  dryRun: boolean;
  encrypt: boolean;
  help: boolean;
  passphrase?: string;
  keysToBackup?: string[];
  bucket?: string;
}

export function parseArgs(args: string[]): StorageBackupOptions {
  const options: StorageBackupOptions = {
    outDir: "backups/storage",
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
    } else if (arg === "--bucket" && i + 1 < args.length) {
      options.bucket = args[++i];
    } else if (arg === "--passphrase" && i + 1 < args.length) {
      options.passphrase = args[++i];
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
Pixora Supabase Storage Disaster Recovery Backup Utility
======================================================

Creates an encrypted, verified incremental backup of the private \`generated-assets\` bucket.

Usage:
  npx tsx scripts/backup-storage.mts [options]

Options:
  --dry-run             Enumerate objects and show incremental plan without downloading.
  --no-encrypt          Disable AES-256-GCM encryption.
  --out <dir>           Output directory (default: "backups/storage").
  --bucket <name>       Target bucket name (defaults to SUPABASE_STORAGE_BUCKET).
  --passphrase <key>    Encryption passphrase (defaults to BACKUP_ENCRYPTION_KEY).
  -h, --help            Show this documentation.
`);
}

/**
 * Acquires a non-blocking process lockfile to prevent concurrent backup runs.
 */
export function acquireBackupLock(lockPath: string): { release: () => void } {
  try {
    const fd = openSync(lockPath, "wx");
    const lockData = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    writeFileSync(fd, lockData, "utf8");
    closeSync(fd);

    return {
      release: () => {
        try {
          if (existsSync(lockPath)) unlinkSync(lockPath);
        } catch {}
      },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Check if process is still active
      try {
        const content = JSON.parse(readFileSync(lockPath, "utf8"));
        if (content.pid) {
          try {
            process.kill(content.pid, 0); // Probes process existence
            throw new Error(
              `CONCURRENT BACKUP BLOCKED: Another backup process (PID ${content.pid}, started ${content.startedAt}) is active.`
            );
          } catch (probeErr: any) {
            if (probeErr.code === "ESRCH") {
              // Stale process, lock can be cleared
              console.warn(`[backup-storage] Clearing stale lockfile from dead PID ${content.pid}`);
              unlinkSync(lockPath);
              return acquireBackupLock(lockPath);
            }
            throw probeErr;
          }
        }
      } catch (readErr: any) {
        if (readErr.message.includes("CONCURRENT BACKUP BLOCKED")) throw readErr;
      }
    }
    throw err;
  }
}

/**
 * Safely lists all files under a prefix recursively with pagination.
 */
export async function listBucketRecursive(
  client: SupabaseClient,
  bucket: string,
  prefix: string = ""
): Promise<string[]> {
  const filePaths: string[] = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit,
      offset,
      sortBy: { column: "name", order: "asc" },
    });

    if (error) {
      throw new Error(`Failed to list bucket objects at "${prefix}": ${error.message}`);
    }

    if (!data || data.length === 0) break;

    for (const item of data) {
      const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
      const isFolder = item.id === null || !item.metadata;

      if (isFolder) {
        const subFiles = await listBucketRecursive(client, bucket, itemPath);
        filePaths.push(...subFiles);
      } else {
        filePaths.push(itemPath);
      }
    }

    if (data.length < limit) break;
    offset += limit;
  }

  return filePaths;
}

export function loadManifest(manifestPath: string, bucket: string): StorageManifest {
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as any;
      if (parsed.objects) {
        return {
          version: 2,
          bucket: parsed.bucket || bucket,
          snapshotTimestamp: parsed.snapshotTimestamp || parsed.lastBackupAt || new Date().toISOString(),
          encryption: parsed.encryption || "AES-256-GCM",
          activeKeys: parsed.activeKeys || Object.keys(parsed.objects),
          objects: parsed.objects,
        };
      }
    } catch {
      console.warn("[backup-storage] Warning: existing manifest was unreadable. Starting fresh.");
    }
  }

  return {
    version: 2,
    bucket,
    snapshotTimestamp: new Date().toISOString(),
    encryption: "AES-256-GCM",
    activeKeys: [],
    objects: {},
  };
}

export function saveManifestAtomic(
  manifestPath: string,
  manifest: StorageManifest,
  masterKey?: Buffer
): void {
  const tmpPath = `${manifestPath}.tmp`;
  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileSync(tmpPath, manifestJson, "utf8");

  try {
    renameSync(tmpPath, manifestPath);
  } catch {
    writeFileSync(manifestPath, manifestJson, "utf8");
  }

  // DR-04A: Sign manifest using dedicated domain-separated HMAC signing key
  if (masterKey) {
    const signingKey = deriveManifestSigningKey(masterKey);
    const sig = signManifest(manifestJson, signingKey);
    const sigPath = `${manifestPath}.sig`;
    writeFileSync(sigPath, sig, "utf8");
  }
}

/**
 * Cryptographically validates an existing cached file on disk before skipping download (DR-03A).
 * Streams through decipher to verify the 16-byte AES-GCM authentication tag, plaintext byte size,
 * and plaintext SHA-256 in constant $O(1)$ RAM without loading large objects into memory.
 */
export async function verifyCachedObjectStreaming(
  filePath: string,
  expectedEncryptedSize: number,
  expectedPlaintextSha256: string,
  expectedPlaintextSize: number,
  objectSubKey?: Buffer
): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    const stats = statSync(filePath);
    if (stats.size !== expectedEncryptedSize) return false;

    const hasher = createHash("sha256");
    let unencryptedBytes = 0;

    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        unencryptedBytes += chunk.length;
        hasher.update(chunk);
        cb();
      },
    });

    if (objectSubKey) {
      const decTransform = createDecryptionTransform(objectSubKey, true);
      await pipeline(createReadStream(filePath), decTransform, sink);
    } else {
      await pipeline(createReadStream(filePath), sink);
    }

    if (unencryptedBytes !== expectedPlaintextSize) return false;
    if (hasher.digest("hex") !== expectedPlaintextSha256) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous cached object validator (supports backwards compatibility).
 */
export function verifyCachedObject(
  filePath: string,
  expectedSize: number,
  encrypted: boolean,
  expectedPlaintextSha256?: string,
  expectedPlaintextSize?: number,
  objectSubKey?: Buffer
): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const stats = statSync(filePath);
    if (stats.size !== expectedSize) return false;

    if (encrypted) {
      if (objectSubKey && expectedPlaintextSha256 !== undefined && expectedPlaintextSize !== undefined) {
        const bytes = readFileSync(filePath);
        const decrypted = decryptBuffer(bytes, objectSubKey, true);
        if (decrypted.length !== expectedPlaintextSize) return false;
        if (sha256(decrypted) !== expectedPlaintextSha256) return false;
        return true;
      }

      // Check magic header
      const fd = openSync(filePath, "r");
      const buf = Buffer.alloc(13);
      readSync(fd, buf, 0, 13, 0);
      closeSync(fd);
      const magicStr = buf.toString("utf8");
      if (magicStr !== "YOURAI_ENC_V2" && magicStr !== "YOURAI_ENC_V1") {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function runStorageBackup(options: StorageBackupOptions): Promise<{
  manifestPath: string;
  totalBackedUp: number;
  totalSkipped: number;
  totalBytes: number;
  manifestSha256: string;
}> {
  if (options.help) {
    printHelp();
    return { manifestPath: "", totalBackedUp: 0, totalSkipped: 0, totalBytes: 0, manifestSha256: "" };
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const bucket = options.bucket || process.env.SUPABASE_STORAGE_BUCKET?.trim() || "generated-assets";

  requireEnvVars([
    { name: "SUPABASE_URL", value: supabaseUrl },
    { name: "SUPABASE_SECRET_KEY", value: secretKey },
  ]);

  const passphrase = options.passphrase ?? process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (options.encrypt && !passphrase) {
    console.error("ERROR: BACKUP_ENCRYPTION_KEY is required for encrypted backups. Set it or use --no-encrypt.");
    process.exit(1);
  }

  const resolvedOutDir = resolve(process.cwd(), options.outDir);
  const objectsDir = join(resolvedOutDir, "objects");
  const manifestPath = join(resolvedOutDir, "manifest.json");
  const lockPath = join(resolvedOutDir, ".backup.lock");

  if (!existsSync(objectsDir) && !options.dryRun) {
    mkdirSync(objectsDir, { recursive: true });
  }

  // Acquire process mutex
  let lock: { release: () => void } | null = null;
  if (!options.dryRun) {
    lock = acquireBackupLock(lockPath);
  }

  try {
    const client = createClient(supabaseUrl!, secretKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    console.log(`[backup-storage] Connecting to bucket: "${bucket}"...`);

    // Determine target keys: either explicit list (from database snapshot) or recursive enumeration
    let targetKeys: string[];
    if (options.keysToBackup && options.keysToBackup.length > 0) {
      targetKeys = options.keysToBackup;
      console.log(`[backup-storage] Using snapshot-referenced key list: ${targetKeys.length} object(s).`);
    } else {
      console.log(`[backup-storage] Enumerating objects from bucket...`);
      targetKeys = await listBucketRecursive(client, bucket, "");
      console.log(`[backup-storage] Discovered ${targetKeys.length} object(s) in bucket.`);
    }

    // Two-Tier Key Derivation: Derive Master Key ONCE
    let masterKey: Buffer | undefined;
    if (options.encrypt && passphrase) {
      console.log(`[backup-storage] Deriving Master Key (PBKDF2-HMAC-SHA256, 600,000 iterations)...`);
      const masterSalt = Buffer.from(`yourai:storage:${bucket}:salt`);
      masterKey = deriveMasterKey(passphrase, masterSalt);
    }

    const manifest = loadManifest(manifestPath, bucket);
    manifest.encryption = options.encrypt ? "AES-256-GCM" : "none";
    manifest.activeKeys = targetKeys;
    manifest.snapshotTimestamp = new Date().toISOString();

    let downloadedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let totalBytes = 0;

    for (let i = 0; i < targetKeys.length; i++) {
      const key = targetKeys[i];
      const existing = manifest.objects[key];

      // DR-03A: Cryptographically verify cached object on disk before skipping download
      if (existing) {
        const existingDiskPath = join(resolvedOutDir, existing.encryptedFile);
        const objectSubKey = options.encrypt && masterKey
          ? deriveSubKey(masterKey, `storage:${key}`)
          : undefined;

        const isVerified = await verifyCachedObjectStreaming(
          existingDiskPath,
          existing.encryptedSize,
          existing.sha256,
          existing.size,
          objectSubKey
        );

        if (isVerified) {
          skippedCount++;
          totalBytes += existing.size;
          continue;
        } else {
          console.warn(`  [cache-invalid] File for "${key}" missing, tampered, or corrupted on disk. Re-downloading...`);
        }
      }

      if (options.dryRun) {
        console.log(`  [dry-run] Would download and encrypt: ${key}`);
        downloadedCount++;
        continue;
      }

      console.log(`  [${i + 1}/${targetKeys.length}] Downloading: ${key}...`);
      try {
        const { data, error } = await client.storage.from(bucket).download(key);
        if (error || !data) {
          throw new Error(error?.message || "Empty response from storage");
        }

        const buffer = Buffer.from(await data.arrayBuffer());
        const rawSha256 = sha256(buffer);

        let diskBuffer: Buffer;
        let relativePath: string;

        if (options.encrypt && masterKey) {
          // Fast HKDF derivation per object (<1 microsecond)
          const objectSubKey = deriveSubKey(masterKey, `storage:${key}`);
          diskBuffer = encryptBuffer(buffer, objectSubKey, true);
          relativePath = join("objects", `${rawSha256}.enc`);
        } else {
          diskBuffer = buffer;
          relativePath = join("objects", `${rawSha256}.bin`);
        }

        // Atomic write: write to .tmp then verified rename
        const diskFullPath = join(resolvedOutDir, relativePath);
        const diskTmpPath = `${diskFullPath}.tmp`;
        writeFileSync(diskTmpPath, diskBuffer);

        // Verify write integrity before rename
        if (statSync(diskTmpPath).size !== diskBuffer.length) {
          throw new Error("Temporary file size mismatch after write.");
        }
        renameSync(diskTmpPath, diskFullPath);

        manifest.objects[key] = {
          storageKey: key,
          size: buffer.length,
          sha256: rawSha256,
          encryptedFile: relativePath.replace(/\\/g, "/"),
          encryptedSize: diskBuffer.length,
          isDeleted: false,
          backedUpAt: new Date().toISOString(),
        };

        totalBytes += buffer.length;
        downloadedCount++;

        // Save atomic manifest on every 10 objects or on completion
        if (downloadedCount % 10 === 0 || i === targetKeys.length - 1) {
          saveManifestAtomic(manifestPath, manifest, masterKey);
        }
      } catch (err) {
        console.error(`  ❌ Failed to backup "${key}": ${(err as Error).message}`);
        failedCount++;
      }
    }

    // DR-03B: DELETION RECONCILIATION
    // Scopes tombstoning strictly to the current snapshot inventory: objects not present in targetKeys
    // are flagged as isDeleted = true with a deletedAt timestamp, without modifying older backup sets.
    const activeKeySet = new Set(targetKeys);
    for (const [key, obj] of Object.entries(manifest.objects)) {
      if (!activeKeySet.has(key)) {
        obj.isDeleted = true;
        (obj as any).deletedAt = manifest.snapshotTimestamp;
      } else {
        obj.isDeleted = false;
        delete (obj as any).deletedAt;
      }
    }

    if (!options.dryRun) {
      saveManifestAtomic(manifestPath, manifest, masterKey);
    }

    const manifestSha = existsSync(manifestPath)
      ? sha256(readFileSync(manifestPath))
      : "";

    console.log(`\n[backup-storage] Summary:`);
    console.log(`  - New objects backed up: ${downloadedCount}`);
    console.log(`  - Cached (verified):     ${skippedCount}`);
    console.log(`  - Failures:              ${failedCount}`);
    console.log(`  - Total in manifest:     ${Object.keys(manifest.objects).length}`);
    console.log(`  - Total raw size:        ${totalBytes} bytes`);
    console.log(`  - Manifest path:         ${manifestPath}`);

    if (failedCount > 0) {
      throw new Error(`Storage backup completed with ${failedCount} failure(s).`);
    }

    return {
      manifestPath,
      totalBackedUp: downloadedCount,
      totalSkipped: skippedCount,
      totalBytes,
      manifestSha256: manifestSha,
    };
  } finally {
    if (lock) {
      lock.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const options = parseArgs(process.argv.slice(2));
  runStorageBackup(options).catch((err) => {
    console.error("[backup-storage] Fatal error:", (err as Error).message);
    process.exit(1);
  });
}
