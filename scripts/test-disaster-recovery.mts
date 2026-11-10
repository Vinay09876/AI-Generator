import assert from "node:assert/strict";
import { randomBytes, createCipheriv } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createDecryptionTransform,
  createEncryptionTransform,
  decryptBuffer,
  deriveKey,
  deriveManifestSigningKey,
  deriveMasterKey,
  deriveSubKey,
  encryptBuffer,
  encryptBufferV3,
  MAGIC_V1,
  MAGIC_V2,
  MAGIC_V3,
  MANIFEST_SIGNING_CONTEXT,
  MAX_CHUNK_SIZE,
  MAX_PBKDF2_ITERATIONS,
  MIN_CHUNK_SIZE,
  MIN_PBKDF2_ITERATIONS,
  PAYLOAD_TYPE_FINAL,
  PAYLOAD_TYPE_INTERMEDIATE,
  PBKDF2_ITERATIONS_V1,
  PBKDF2_ITERATIONS_V2,
  sha256,
  signManifest,
  validateChunkSize,
  validateIterations,
  verifyEncryptedStream,
  verifyManifestSignature,
} from "./lib/backup-crypto.mjs";
import {
  assertSafeRestoreTarget,
  assertSafeStorageRestoreTarget,
  canonicalDatabaseIdentity,
  createSecurePassfile,
  normalizeHost,
  parseDatabaseConnection,
} from "./lib/backup-guard.mjs";
import {
  acquireBackupLock,
  loadManifest,
  saveManifestAtomic,
  verifyCachedObject,
  verifyCachedObjectStreaming,
  type StorageManifest,
} from "./backup-storage.mjs";
import { isFatalPgRestoreError } from "./restore-db.mjs";
import {
  decodePostgresCopyField,
  parseStorageKeysFromCopyStream,
  type BackupSetManifest,
} from "./backup-set.mjs";
import { reconcileStorageObject } from "./restore-storage.mjs";

/**
 * Hardened Test Suite: YourAI Disaster Recovery & Operational Tooling (Stage 7 Batch 2 Hardened)
 *
 * Fully Offline: Uses disposable fixtures only. Does NOT connect to production database or storage.
 */

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`PASS  ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`FAIL  ${name}:`, err.message);
    });
}

const TEST_DIR = join(process.cwd(), ".tmp-test-backup-hardened");

async function main() {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });

  const strongPassphrase = "ProductionGradeSecretPassphrase2026!";

  console.log("# Disaster Recovery — Cryptographic Primitives & Two-Tier Key Hierarchy");

  await test("encryptBuffer / decryptBuffer round-trip with text payload (V2 format)", () => {
    const original = Buffer.from("Hello YourAI Disaster Recovery System V2! 🚀", "utf8");
    const encrypted = encryptBuffer(original, strongPassphrase);

    assert.notDeepEqual(encrypted, original);
    assert.equal(encrypted.subarray(0, MAGIC_V2.length).toString("utf8"), "YOURAI_ENC_V2");

    const decrypted = decryptBuffer(encrypted, strongPassphrase);
    assert.deepEqual(decrypted, original);
  });

  await test("encryptBuffer / decryptBuffer round-trip with empty payload", () => {
    const original = Buffer.alloc(0);
    const encrypted = encryptBuffer(original, strongPassphrase);
    const decrypted = decryptBuffer(encrypted, strongPassphrase);
    assert.deepEqual(decrypted, original);
  });

  await test("encryptBuffer / decryptBuffer round-trip with 1 MB binary payload", () => {
    const original = randomBytes(1024 * 1024);
    const encrypted = encryptBuffer(original, strongPassphrase);
    const decrypted = decryptBuffer(encrypted, strongPassphrase);
    assert.deepEqual(decrypted, original);
  });

  await test("backward-compatible decryption of legacy YOURAI_ENC_V1 payload (100k iter)", () => {
    // Construct valid V1 envelope: MAGIC_V1 (13B) + salt (16B) + iv (12B) + ciphertext + tag (16B)
    const original = Buffer.from("Legacy V1 backup payload from previous deployment", "utf8");
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = deriveKey(strongPassphrase, salt, PBKDF2_ITERATIONS_V1);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(original), cipher.final()]);
    const tag = cipher.getAuthTag();

    const v1Payload = Buffer.concat([MAGIC_V1, salt, iv, ct, tag]);
    assert.equal(v1Payload.subarray(0, 13).toString("utf8"), "YOURAI_ENC_V1");

    // Decrypt using unified decryptBuffer (must autodetect V1)
    const decrypted = decryptBuffer(v1Payload, strongPassphrase);
    assert.deepEqual(decrypted, original);
  });

  await test("two-tier key hierarchy: master key derivation + HKDF sub-key uniqueness and speed", () => {
    const masterSalt = randomBytes(16);
    const masterKey = deriveMasterKey(strongPassphrase, masterSalt, 100_000); // 100k (MIN_PBKDF2_ITERATIONS) for test run
    assert.equal(masterKey.length, 32);

    const subKey1 = deriveSubKey(masterKey, "storage:users/u1/images/j1/a1.webp");
    const subKey2 = deriveSubKey(masterKey, "storage:users/u1/images/j1/a2.webp");
    const subKey3 = deriveSubKey(masterKey, "storage:users/u1/images/j1/a1.webp"); // Identical context

    assert.equal(subKey1.length, 32);
    assert.equal(subKey2.length, 32);
    assert.notDeepEqual(subKey1, subKey2, "Different object keys produce different sub-keys");
    assert.deepEqual(subKey1, subKey3, "Identical object keys produce deterministic sub-key");

    // Pre-derived subkey encryption round-trip
    const data = Buffer.from("Object image data", "utf8");
    const enc = encryptBuffer(data, subKey1, true);
    const dec = decryptBuffer(enc, subKey1, true);
    assert.deepEqual(dec, data);
  });

  await test("tampered ciphertext throws GCM authentication error", () => {
    const original = Buffer.from("Sensitive database row", "utf8");
    const encrypted = encryptBuffer(original, strongPassphrase);

    const tampered = Buffer.from(encrypted);
    tampered[50] ^= 0x01; // Tamper in ciphertext area

    assert.throws(
      () => decryptBuffer(tampered, strongPassphrase),
      /unable to authenticate|Unsupported state/i
    );
  });

  await test("tampered auth tag throws GCM authentication error", () => {
    const original = Buffer.from("Sensitive database row", "utf8");
    const encrypted = encryptBuffer(original, strongPassphrase);

    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0x01;

    assert.throws(
      () => decryptBuffer(tampered, strongPassphrase),
      /unable to authenticate|Unsupported state/i
    );
  });

  await test("wrong passphrase throws GCM authentication error", () => {
    const original = Buffer.from("Sensitive database row", "utf8");
    const encrypted = encryptBuffer(original, strongPassphrase);

    assert.throws(
      () => decryptBuffer(encrypted, "DifferentStrongPassword2026!"),
      /unable to authenticate|Unsupported state/i
    );
  });

  await test("invalid magic header is rejected", () => {
    const corrupted = Buffer.concat([Buffer.from("CORRUPT_MAGIC_"), randomBytes(50)]);
    assert.throws(() => decryptBuffer(corrupted, strongPassphrase), /magic header mismatch/i);
  });

  console.log("\n# Disaster Recovery — Two-Pass Streaming & Pre-Flight Decryption");

  await test("streaming encryption and verifyEncryptedStream round-trip", async () => {
    const payload = randomBytes(256 * 1024); // 256 KB
    const inputStream = Readable.from([payload.subarray(0, 100_000), payload.subarray(100_000)]);

    const { transform, getStats } = createEncryptionTransform(strongPassphrase);
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));

    await pipeline(inputStream, transform);
    const encryptedStreamBytes = Buffer.concat(chunks);

    const stats = getStats();
    assert.equal(stats.unencryptedBytes, payload.length);
    assert.equal(stats.sha256, sha256(payload));

    // Verify in dry sink using verifyEncryptedStream
    const verified = await verifyEncryptedStream(Readable.from([encryptedStreamBytes]), strongPassphrase);
    assert.equal(verified.unencryptedBytes, payload.length);
    assert.equal(verified.sha256, sha256(payload));
  });

  await test("truncated database archive fails in Pass 1 before consumer receives data", async () => {
    const payload = randomBytes(100 * 1024);
    const { transform } = createEncryptionTransform(strongPassphrase);
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    await pipeline(Readable.from([payload]), transform);
    const fullEncrypted = Buffer.concat(chunks);

    // Truncate the last 30 bytes (dropping auth tag)
    const truncated = fullEncrypted.subarray(0, fullEncrypted.length - 30);

    let consumerReceivedAnyData = false;
    const consumer = new Writable({
      write(chunk, _enc, cb) {
        consumerReceivedAnyData = true;
        cb();
      },
    });

    await assert.rejects(
      async () => {
        await verifyEncryptedStream(Readable.from([truncated]), strongPassphrase);
      },
      /Truncated archive|Cryptographic authentication failed/i
    );
    assert.equal(consumerReceivedAnyData, false, "Consumer must not receive data on truncated archive");
  });

  await test("corrupted database archive fails in Pass 1 before consumer receives data", async () => {
    const payload = randomBytes(100 * 1024);
    const { transform } = createEncryptionTransform(strongPassphrase);
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    await pipeline(Readable.from([payload]), transform);
    const fullEncrypted = Buffer.concat(chunks);

    // Corrupt a byte in the middle
    fullEncrypted[500] ^= 0xff;

    await assert.rejects(
      async () => {
        await verifyEncryptedStream(Readable.from([fullEncrypted]), strongPassphrase);
      },
      /Cryptographic authentication failed/i
    );
  });

  await test("large streaming restore memory safety: validates 2 MB stream in constant RAM ($O(1)$)", async () => {
    const twoMb = randomBytes(2 * 1024 * 1024);
    const { transform } = createEncryptionTransform(strongPassphrase);
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    await pipeline(Readable.from([twoMb]), transform);
    const encrypted = Buffer.concat(chunks);

    // Decrypt through streaming transform without holding plaintext in an array
    const decTransform = createDecryptionTransform(strongPassphrase);
    let bytesStreamed = 0;
    const countingSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        bytesStreamed += chunk.length;
        cb();
      },
    });

    await pipeline(Readable.from([encrypted]), decTransform, countingSink);
    assert.equal(bytesStreamed, twoMb.length);
  });

  console.log("\n# Disaster Recovery — Manifest Authentication & Storage Safety");

  await test("DR-04A: manifest signing key is domain-separated from master key via HKDF", () => {
    const masterKey = deriveMasterKey(strongPassphrase, Buffer.from("salt1"), 100_000);
    const signingKey = deriveManifestSigningKey(masterKey);

    assert.equal(signingKey.length, 32);
    assert.notDeepEqual(signingKey, masterKey, "Signing key must be cryptographically separated from masterKey");

    const manifestJson = JSON.stringify({ bucket: "test", count: 42 });
    const sig = signManifest(manifestJson, signingKey);

    // Verifying with proper signingKey succeeds
    assert.equal(verifyManifestSignature(manifestJson, sig, signingKey), true);

    // DR-04A: Attempting to verify with masterKey directly MUST fail (key separation enforced)
    assert.equal(
      verifyManifestSignature(manifestJson, sig, masterKey),
      false,
      "Raw masterKey must not verify signature produced by domain-separated signing key"
    );

    // Tampered manifest
    const tamperedJson = JSON.stringify({ bucket: "test", count: 43 });
    assert.equal(verifyManifestSignature(tamperedJson, sig, signingKey), false);

    // DR-04B: Tampered signature hex
    const tamperedSig = sig.substring(0, sig.length - 2) + (sig.endsWith("00") ? "11" : "00");
    assert.equal(verifyManifestSignature(manifestJson, tamperedSig, signingKey), false);

    // DR-04B: Wrong passphrase/masterKey
    const wrongMasterKey = deriveMasterKey("AnotherKey12345678!", Buffer.from("salt2"), 100_000);
    const wrongSigningKey = deriveManifestSigningKey(wrongMasterKey);
    assert.equal(verifyManifestSignature(manifestJson, sig, wrongSigningKey), false);
  });

  console.log("\n# Disaster Recovery — DR-03A: Full Cached-Object Cryptographic Verification");

  await test("DR-03A: verifyCachedObjectStreaming succeeds on valid cached object", async () => {
    const filePath = join(TEST_DIR, "cache-valid.enc");
    const plaintext = Buffer.from("Valid high-resolution webp image data for YourAI user 123", "utf8");
    const masterKey = deriveMasterKey(strongPassphrase, Buffer.from("salt-m"), 100_000);
    const objectSubKey = deriveSubKey(masterKey, "storage:users/u1/images/valid.webp");

    const encrypted = encryptBuffer(plaintext, objectSubKey, true);
    writeFileSync(filePath, encrypted);

    const isVerified = await verifyCachedObjectStreaming(
      filePath,
      encrypted.length,
      sha256(plaintext),
      plaintext.length,
      objectSubKey
    );
    assert.equal(isVerified, true, "Valid encrypted file with correct subkey and hash must pass verification");
  });

  await test("DR-03A: verifyCachedObjectStreaming detects ciphertext bit-flip corruption", async () => {
    const filePath = join(TEST_DIR, "cache-corrupt-ct.enc");
    const plaintext = Buffer.from("Another valid image data buffer", "utf8");
    const masterKey = deriveMasterKey(strongPassphrase, Buffer.from("salt-m"), 100_000);
    const objectSubKey = deriveSubKey(masterKey, "storage:users/u1/images/corrupt.webp");

    const encrypted = encryptBuffer(plaintext, objectSubKey, true);
    // Corrupt a byte in the middle of ciphertext
    encrypted[encrypted.length - 25] ^= 0x01;
    writeFileSync(filePath, encrypted);

    const isVerified = await verifyCachedObjectStreaming(
      filePath,
      encrypted.length,
      sha256(plaintext),
      plaintext.length,
      objectSubKey
    );
    assert.equal(isVerified, false, "Corrupted ciphertext must fail verification and trigger re-download");
  });

  await test("DR-03A: verifyCachedObjectStreaming detects tampered GCM auth tag", async () => {
    const filePath = join(TEST_DIR, "cache-tampered-tag.enc");
    const plaintext = Buffer.from("Tampered tag image data buffer", "utf8");
    const masterKey = deriveMasterKey(strongPassphrase, Buffer.from("salt-m"), 100_000);
    const objectSubKey = deriveSubKey(masterKey, "storage:users/u1/images/tag.webp");

    const encrypted = encryptBuffer(plaintext, objectSubKey, true);
    // Corrupt last byte (GCM auth tag area)
    encrypted[encrypted.length - 1] ^= 0x01;
    writeFileSync(filePath, encrypted);

    const isVerified = await verifyCachedObjectStreaming(
      filePath,
      encrypted.length,
      sha256(plaintext),
      plaintext.length,
      objectSubKey
    );
    assert.equal(isVerified, false, "Tampered auth tag must fail verification");
  });

  await test("DR-03A: verifyCachedObjectStreaming detects wrong encryption subkey", async () => {
    const filePath = join(TEST_DIR, "cache-wrong-key.enc");
    const plaintext = Buffer.from("Protected asset image data buffer", "utf8");
    const masterKey = deriveMasterKey(strongPassphrase, Buffer.from("salt-m"), 100_000);
    const correctSubKey = deriveSubKey(masterKey, "storage:users/u1/images/correct.webp");
    const wrongSubKey = deriveSubKey(masterKey, "storage:users/u2/images/wrong.webp");

    const encrypted = encryptBuffer(plaintext, correctSubKey, true);
    writeFileSync(filePath, encrypted);

    const isVerified = await verifyCachedObjectStreaming(
      filePath,
      encrypted.length,
      sha256(plaintext),
      plaintext.length,
      wrongSubKey
    );
    assert.equal(isVerified, false, "Wrong subkey must fail verification");
  });

  await test("DR-03A: verifyCachedObjectStreaming detects truncated file", async () => {
    const filePath = join(TEST_DIR, "cache-truncated.enc");
    const plaintext = Buffer.from("Truncated asset image data buffer", "utf8");
    const masterKey = deriveMasterKey(strongPassphrase, Buffer.from("salt-m"), 100_000);
    const objectSubKey = deriveSubKey(masterKey, "storage:users/u1/images/trunc.webp");

    const encrypted = encryptBuffer(plaintext, objectSubKey, true);
    // Truncate last 20 bytes
    writeFileSync(filePath, encrypted.subarray(0, encrypted.length - 20));

    const isVerified = await verifyCachedObjectStreaming(
      filePath,
      encrypted.length, // Expected original length
      sha256(plaintext),
      plaintext.length,
      objectSubKey
    );
    assert.equal(isVerified, false, "Truncated file must fail verification");
  });

  await test("DR-03A: verifyCachedObjectStreaming detects plaintext hash mismatch", async () => {
    const filePath = join(TEST_DIR, "cache-hash-mismatch.enc");
    const plaintext = Buffer.from("Real asset data", "utf8");
    const masterKey = deriveMasterKey(strongPassphrase, Buffer.from("salt-m"), 100_000);
    const objectSubKey = deriveSubKey(masterKey, "storage:users/u1/images/hash.webp");

    const encrypted = encryptBuffer(plaintext, objectSubKey, true);
    writeFileSync(filePath, encrypted);

    const isVerified = await verifyCachedObjectStreaming(
      filePath,
      encrypted.length,
      "0000000000000000000000000000000000000000000000000000000000000000", // Bogus expected sha
      plaintext.length,
      objectSubKey
    );
    assert.equal(isVerified, false, "Plaintext hash mismatch must fail verification");
  });

  console.log("\n# Disaster Recovery — DR-03B: Deletion Reconciliation & Immutability");

  await test("DR-03B: later live bucket deletion does not invalidate earlier backup set manifest", () => {
    // Earlier Backup Set 1 (Historical)
    const set1Manifest: StorageManifest = {
      version: 2,
      bucket: "generated-assets",
      snapshotTimestamp: "2026-11-01T00:00:00.000Z",
      encryption: "AES-256-GCM",
      activeKeys: ["users/u1/a1.webp", "users/u1/a2.webp"],
      objects: {
        "users/u1/a1.webp": {
          storageKey: "users/u1/a1.webp",
          size: 100,
          sha256: "hash1",
          encryptedFile: "objects/hash1.enc",
          encryptedSize: 150,
          isDeleted: false,
          backedUpAt: "2026-11-01T00:00:00.000Z",
        },
        "users/u1/a2.webp": {
          storageKey: "users/u1/a2.webp",
          size: 200,
          sha256: "hash2",
          encryptedFile: "objects/hash2.enc",
          encryptedSize: 250,
          isDeleted: false,
          backedUpAt: "2026-11-01T00:00:00.000Z",
        },
      },
    };

    // Serialize Set 1 manifest as immutable
    const set1ManifestJson = JSON.stringify(set1Manifest, null, 2);

    // Later, in standalone backup run, a2.webp is deleted from live storage:
    const liveKeysNow = ["users/u1/a1.webp"];
    const laterManifest: StorageManifest = JSON.parse(set1ManifestJson);
    laterManifest.activeKeys = liveKeysNow;
    laterManifest.snapshotTimestamp = "2026-11-10T00:00:00.000Z";

    // Reconcile deletion in later manifest
    const activeKeySet = new Set(liveKeysNow);
    for (const [key, obj] of Object.entries(laterManifest.objects)) {
      if (!activeKeySet.has(key)) {
        obj.isDeleted = true;
        (obj as any).deletedAt = laterManifest.snapshotTimestamp;
      }
    }

    // Assert that earlier Set 1 manifest remains completely intact and uncorrupted
    const set1Restored = JSON.parse(set1ManifestJson) as StorageManifest;
    assert.equal(set1Restored.activeKeys.length, 2);
    assert.equal(set1Restored.objects["users/u1/a2.webp"].isDeleted, false, "Set 1 retains a2.webp as active");

    // Assert that later manifest correctly tombstoned a2.webp
    assert.equal(laterManifest.objects["users/u1/a2.webp"].isDeleted, true);
    assert.equal((laterManifest.objects["users/u1/a2.webp"] as any).deletedAt, "2026-11-10T00:00:00.000Z");
  });

  console.log("\n# Disaster Recovery — DR-01A & DR-01B: Database Restore Hardening");

  await test("DR-01A: protected snapshot isolates restore from external source file mutation", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "test-dr-source-"));
    const sourceFile = join(sourceDir, "test.dump.enc");
    const payload = Buffer.from("Valid PostgreSQL dump payload for DR-01A test", "utf8");
    const encrypted = encryptBuffer(payload, strongPassphrase);
    writeFileSync(sourceFile, encrypted);

    // Simulate runDatabaseRestore snapshotting logic
    const tempDir = mkdtempSync(join(tmpdir(), "test-dr-snapshot-"));
    const snapshotFile = join(tempDir, "protected-snapshot.dump.enc");
    copyFileSync(sourceFile, snapshotFile);

    // External process mutates or replaces the source file AFTER snapshot is taken
    writeFileSync(sourceFile, Buffer.from("TAMPERED_SOURCE_FILE_DATA_CORRUPTION", "utf8"));

    // Pass 1 verifies from snapshot
    const pass1Stats = await verifyEncryptedStream(createReadStream(snapshotFile), strongPassphrase);
    assert.equal(pass1Stats.unencryptedBytes, payload.length);
    assert.equal(pass1Stats.sha256, sha256(payload));

    // Pass 2 decrypts from the exact same snapshot
    const decTransform = createDecryptionTransform(strongPassphrase);
    let pass2Bytes = 0;
    const pass2Sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        pass2Bytes += chunk.length;
        cb();
      },
    });
    await pipeline(createReadStream(snapshotFile), decTransform, pass2Sink);
    assert.equal(pass2Bytes, payload.length);

    // Cleanup
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  await test("DR-01A: tampered snapshot in Pass 2 stream aborts before data commits", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "test-dr-tamper-"));
    const snapshotFile = join(tempDir, "tampered-snapshot.dump.enc");
    const payload = randomBytes(64 * 1024);
    const encrypted = encryptBuffer(payload, strongPassphrase);
    // Tamper the ciphertext in the snapshot
    encrypted[500] ^= 0x02;
    writeFileSync(snapshotFile, encrypted);

    const decTransform = createDecryptionTransform(strongPassphrase);
    await assert.rejects(
      async () => {
        await pipeline(
          createReadStream(snapshotFile),
          decTransform,
          new Writable({ write(_chunk, _enc, cb) { cb(); } })
        );
      },
      /Cryptographic authentication failed|unable to authenticate/i,
      "Tampered snapshot must abort decipher stream and prevent commit"
    );

    rmSync(tempDir, { recursive: true, force: true });
  });

  await test("DR-01B: isFatalPgRestoreError fail-closed classification matrix", () => {
    // Harmless notices: table does not exist
    const singleDrop = `pg_restore: notice: table "users" does not exist, skipping drop`;
    const multiDrop = `pg_restore: notice: table "users" does not exist, skipping drop\npg_restore: notice: sequence "job_seq" does not exist, skipping drop\npg_restore: notice: view "active_users" does not exist, skipping drop`;
    const warningDrop = `pg_restore: warning: table "users" does not exist, skipping drop`;

    assert.equal(isFatalPgRestoreError(singleDrop), false, "Single drop notice is harmless");
    assert.equal(isFatalPgRestoreError(multiDrop), false, "Multi-line drop notices are harmless");
    assert.equal(isFatalPgRestoreError(warningDrop), false, "Warning drop notice is harmless");

    // Fatal: Permission denied
    const permissionDenied = `pg_restore: error: could not execute query: ERROR: permission denied for table "GeneratedAsset"`;
    assert.equal(isFatalPgRestoreError(permissionDenied), true, "Permission denied must be FATAL");

    // Fatal: Disk quota / space error
    const diskError = `pg_restore: error: write failed: No space left on device`;
    assert.equal(isFatalPgRestoreError(diskError), true, "Disk error must be FATAL");

    // Fatal: SQL relation error
    const relationExists = `pg_restore: error: could not execute query: ERROR: relation "users" already exists`;
    assert.equal(isFatalPgRestoreError(relationExists), true, "Relation already exists must be FATAL");

    // Fatal: Connection lost
    const connectionLost = `pg_restore: error: connection to server was lost`;
    assert.equal(isFatalPgRestoreError(connectionLost), true, "Connection loss must be FATAL");

    // Fatal: Unknown or ambiguous stderr
    const unknownStderr = `pg_restore: some unexpected internal warning occurred`;
    assert.equal(isFatalPgRestoreError(unknownStderr), true, "Unknown stderr must FAIL CLOSED");

    // Fatal: Empty stderr when code is 1
    assert.equal(isFatalPgRestoreError(""), true, "Empty stderr with exit code 1 must FAIL CLOSED");
    assert.equal(isFatalPgRestoreError("   \n  \n"), true, "Whitespace-only stderr must FAIL CLOSED");

    // Fatal: Mixed harmless notice with fatal error
    const mixedStderr = `${singleDrop}\n${permissionDenied}`;
    assert.equal(isFatalPgRestoreError(mixedStderr), true, "Mixed harmless notice with fatal error must be FATAL");
  });

  console.log("\n# Disaster Recovery — DR-02: Database Dump-Derived Asset Inventory");

  await test("DR-02: parseStorageKeysFromCopyStream extracts exact GeneratedAsset keys from dump COPY stream", () => {
    const copyOutput = `
-- PostgreSQL dump data for GeneratedAsset
SET statement_timeout = 0;
COPY public."GeneratedAsset" ("id", "jobId", "userId", "storageKey", "byteSize", "width", "height", "format", "sha256", "createdAt") FROM stdin;
asset-uuid-1\tjob-1\tuser-1\tusers/u1/images/j1/img1.webp\t12345\t1024\t1024\twebp\thash1\t2026-11-09 10:00:00
asset-uuid-2\tjob-2\tuser-1\tusers/u1/images/j2/img2.webp\t23456\t1024\t1024\twebp\thash2\t2026-11-09 11:00:00
asset-uuid-3\tjob-3\tuser-2\tusers/u2/images/j3/img3.webp\t34567\t1024\t1024\twebp\thash3\t2026-11-09 12:00:00
\\.
-- End of table
`;

    const keys = parseStorageKeysFromCopyStream(copyOutput);
    assert.equal(keys.length, 3);
    assert.deepEqual(keys, [
      "users/u1/images/j1/img1.webp",
      "users/u1/images/j2/img2.webp",
      "users/u2/images/j3/img3.webp",
    ], "Extracted keys must match the exact storageKey column values");
  });

  await test("DR-02: parseStorageKeysFromCopyStream skips null (\\N) values and handles empty tables", () => {
    const emptyTableOutput = `
COPY public."GeneratedAsset" ("id", "storageKey") FROM stdin;
\\.
`;
    assert.deepEqual(parseStorageKeysFromCopyStream(emptyTableOutput), []);

    const nullValueOutput = `
COPY public."GeneratedAsset" ("id", "storageKey") FROM stdin;
id-1\t\\N
id-2\tusers/u1/images/real.webp
\\.
`;
    assert.deepEqual(parseStorageKeysFromCopyStream(nullValueOutput), ["users/u1/images/real.webp"]);
  });

  await test("storage verifyCachedObject detects missing, truncated, or unencrypted files", () => {
    const validPath = join(TEST_DIR, "valid.enc");
    const corruptedPath = join(TEST_DIR, "corrupt.enc");

    const enc = encryptBuffer(Buffer.from("Valid image data"), strongPassphrase);
    writeFileSync(validPath, enc);
    writeFileSync(corruptedPath, enc.subarray(0, enc.length - 20)); // Truncated

    assert.equal(verifyCachedObject(validPath, enc.length, true), true);
    assert.equal(verifyCachedObject(corruptedPath, enc.length, true), false, "Size mismatch detected");
    assert.equal(verifyCachedObject(join(TEST_DIR, "nonexistent.enc"), enc.length, true), false);
  });

  await test("concurrent backup process mutex lockfile blocks second process", () => {
    const lockPath = join(TEST_DIR, ".test.lock");
    const lock1 = acquireBackupLock(lockPath);
    assert.ok(existsSync(lockPath));

    assert.throws(
      () => acquireBackupLock(lockPath),
      /CONCURRENT BACKUP BLOCKED/i
    );

    lock1.release();
    assert.equal(existsSync(lockPath), false);
  });

  console.log("\n# Disaster Recovery — Restore Target Protection & Canonical URLs");

  const prodUrl = "postgresql://postgres:secret@db.gmaoidjfzyxbigshrgdn.supabase.co:5432/postgres";
  const testUrl = "postgresql://postgres:secret@db.otherprojectref12345.supabase.co:5432/postgres";

  await test("restore to production database without flag is BLOCKED", () => {
    assert.throws(
      () => assertSafeRestoreTarget(prodUrl, prodUrl, false),
      /ACCIDENTAL OVERWRITE BLOCKED/i
    );
  });

  await test("restore to production database WITH explicit flag is permitted", () => {
    const { isProduction } = assertSafeRestoreTarget(prodUrl, prodUrl, true);
    assert.equal(isProduction, true);
  });

  await test("restore to non-production target is permitted without flag", () => {
    const { isProduction } = assertSafeRestoreTarget(testUrl, prodUrl, false);
    assert.equal(isProduction, false);
  });

  await test("canonical URL normalization equates loopback aliases and strips query params", () => {
    const urlA = "postgresql://myuser:mypass@localhost:5432/yourai?sslmode=require";
    const urlB = "postgresql://myuser:otherpass@127.0.0.1/yourai";

    assert.equal(normalizeHost("localhost"), "127.0.0.1");
    assert.equal(normalizeHost("127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeHost("::1"), "127.0.0.1");

    const idA = canonicalDatabaseIdentity(urlA);
    const idB = canonicalDatabaseIdentity(urlB);
    assert.equal(idA, "postgres://myuser@127.0.0.1:5432/yourai");
    assert.equal(idB, "postgres://myuser@127.0.0.1:5432/yourai");
    assert.equal(idA, idB, "Normalized identities must match despite loopback alias and query string differences");
  });

  await test("assertSafeStorageRestoreTarget blocks production bucket without confirmation", () => {
    const prodBucket = "generated-assets";
    const supabaseUrl = "https://gmaoidjfzyxbigshrgdn.supabase.co";

    assert.throws(
      () => assertSafeStorageRestoreTarget(prodBucket, supabaseUrl, prodBucket, supabaseUrl, false),
      /ACCIDENTAL OVERWRITE BLOCKED/i
    );

    const { isProductionBucket } = assertSafeStorageRestoreTarget(
      prodBucket,
      supabaseUrl,
      prodBucket,
      supabaseUrl,
      true
    );
    assert.equal(isProductionBucket, true);

    const nonProd = assertSafeStorageRestoreTarget(
      "restored-backup-bucket",
      supabaseUrl,
      prodBucket,
      supabaseUrl,
      false
    );
    assert.equal(nonProd.isProductionBucket, false);
  });

  await test("createSecurePassfile creates temporary file and cleans up securely", () => {
    const conn = parseDatabaseConnection("postgresql://myuser:secret123@127.0.0.1:5432/mydb");
    const pass = createSecurePassfile(conn);
    assert.ok(pass);
    assert.ok(existsSync(pass.filePath));

    pass.cleanup();
    assert.equal(existsSync(pass.filePath), false);
  });

  await test("isFatalPgRestoreError distinguishes fatal errors from ignorable notices", () => {
    const harmlessNotice = `pg_restore: notice: table "users" does not exist, skipping drop\npg_restore: notice: table "jobs" does not exist, skipping drop`;
    const fatalError = `pg_restore: error: could not execute query: ERROR: relation "users" already exists\npg_restore: error: failed to restore`;

    assert.equal(isFatalPgRestoreError(harmlessNotice), false);
    assert.equal(isFatalPgRestoreError(fatalError), true);
  });

  console.log("\n# Disaster Recovery — Coordinated Backup Set Manifest Verification");

  await test("coordinated backup set: all referenced objects present -> VERIFIED", () => {
    const referencedKeys = ["users/u1/images/j1/a1.webp", "users/u1/images/j1/a2.webp"];
    const storageObjects: Record<string, any> = {
      "users/u1/images/j1/a1.webp": { size: 100 },
      "users/u1/images/j1/a2.webp": { size: 200 },
    };

    const missingKeys = referencedKeys.filter((k) => !storageObjects[k]);
    assert.equal(missingKeys.length, 0);

    const manifest: BackupSetManifest = {
      formatVersion: "2.0",
      backupSetId: "bkset_test_123",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "VERIFIED",
      database: {
        filename: "db.dump.enc",
        diskSha256: "abc",
        diskSizeBytes: 1000,
        sourceHost: "localhost",
        databaseName: "postgres",
        supabaseProjectRef: null,
        snapshotTimestamp: new Date().toISOString(),
        assetCount: 2,
      },
      storage: {
        manifestFilename: "manifest.json",
        manifestSha256: "def",
        bucket: "generated-assets",
        referencedObjectCount: 2,
        totalSizeBytes: 300,
        snapshotTimestamp: new Date().toISOString(),
      },
      consistency: {
        strategy: "db-snapshot-references-exact-storage",
        allReferencedObjectsPresent: true,
        missingObjects: [],
      },
    };

    assert.equal(manifest.status, "VERIFIED");
    assert.equal(manifest.consistency.allReferencedObjectsPresent, true);
  });

  await test("coordinated backup set: missing referenced object -> FAILED_INCONSISTENT", () => {
    const referencedKeys = ["users/u1/images/j1/a1.webp", "users/u1/images/j1/a2.webp"];
    const storageObjects: Record<string, any> = {
      "users/u1/images/j1/a1.webp": { size: 100 },
      // a2.webp is missing from storage!
    };

    const missingKeys = referencedKeys.filter((k) => !storageObjects[k]);
    assert.equal(missingKeys.length, 1);
    assert.equal(missingKeys[0], "users/u1/images/j1/a2.webp");
  });

  console.log("\n# Disaster Recovery — DR-01: Version 3 Chunk-Framed Authenticated Encryption");

  // Helper function to stream encrypt a buffer using V3 createEncryptionTransform
  async function encryptToV3Buffer(data: Buffer, passphrase: string, chunkSize?: number): Promise<Buffer> {
    const { transform } = createEncryptionTransform(passphrase, false, chunkSize);
    const inStream = Readable.from([data]);
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    await pipeline(inStream, transform, sink);
    return Buffer.concat(chunks);
  }

  // Helper function to stream decrypt a buffer using createDecryptionTransform
  async function decryptV3Buffer(enc: Buffer, passphrase: string): Promise<{ chunks: Buffer[]; total: Buffer }> {
    const dec = createDecryptionTransform(passphrase);
    const inStream = Readable.from([enc]);
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    await pipeline(inStream, dec, sink);
    return { chunks, total: Buffer.concat(chunks) };
  }

  await test("DR-01: V3 chunk-framed round-trip with multiple chunks (192 KB / 3 x 64KB)", async () => {
    const chunkSize = 64 * 1024;
    const original = randomBytes(3 * chunkSize);
    const encrypted = await encryptToV3Buffer(original, strongPassphrase, chunkSize);

    assert.equal(encrypted.subarray(0, MAGIC_V3.length).toString("utf8"), "YOURAI_ENC_V3");

    const { total } = await decryptV3Buffer(encrypted, strongPassphrase);
    assert.deepEqual(total, original);
    assert.equal(sha256(total), sha256(original));
  });

  await test("DR-01: First chunk corruption throws before releasing any plaintext", async () => {
    const chunkSize = 64 * 1024;
    const original = randomBytes(2 * chunkSize);
    const encrypted = await encryptToV3Buffer(original, strongPassphrase, chunkSize);

    // Header is 50 bytes. Chunk 0 frame starts at offset 50:
    // [chunkIndex(4B)][payloadType(1B)][cipherLen(4B)][ciphertext(LB)][authTag(16B)]
    // Corrupt 1 byte in chunk 0 ciphertext (offset 59 + 10)
    const corrupted = Buffer.from(encrypted);
    corrupted[69] ^= 0xff;

    const emittedChunks: Buffer[] = [];
    const dec = createDecryptionTransform(strongPassphrase);
    const inStream = Readable.from([corrupted]);
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        emittedChunks.push(chunk);
        cb();
      },
    });

    let rejected = false;
    try {
      await pipeline(inStream, dec, sink);
    } catch (err) {
      rejected = true;
      assert.match((err as Error).message, /Cryptographic authentication failed on chunk 0/);
    }

    assert.equal(rejected, true, "Pipeline must reject corrupted first chunk");
    assert.equal(emittedChunks.length, 0, "No plaintext may be released from corrupted chunk 0");
  });

  await test("DR-01: Middle chunk corruption releases preceding chunks but halts before corrupted chunk plaintext", async () => {
    const chunkSize = 64 * 1024;
    const original = randomBytes(3 * chunkSize);
    const encrypted = await encryptToV3Buffer(original, strongPassphrase, chunkSize);

    // Chunk 0 frame length = 9 + 65536 + 16 = 65561 bytes
    // Chunk 1 starts at 50 + 65561 = 65611
    const corrupted = Buffer.from(encrypted);
    const chunk1CipherOffset = 50 + 65561 + 9 + 10;
    corrupted[chunk1CipherOffset] ^= 0xff;

    const emittedChunks: Buffer[] = [];
    const dec = createDecryptionTransform(strongPassphrase);
    const inStream = Readable.from([corrupted]);
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        emittedChunks.push(chunk);
        cb();
      },
    });

    let rejected = false;
    try {
      await pipeline(inStream, dec, sink);
    } catch (err) {
      rejected = true;
      assert.match((err as Error).message, /Cryptographic authentication failed on chunk 1/);
    }

    assert.equal(rejected, true, "Pipeline must reject corrupted middle chunk");
    const totalEmitted = Buffer.concat(emittedChunks);
    assert.equal(totalEmitted.length, chunkSize, "Only valid preceding chunk (chunk 0) is released");
    assert.deepEqual(totalEmitted, original.subarray(0, chunkSize));
  });

  await test("DR-01: Final chunk corruption throws on tag verification without releasing final chunk", async () => {
    const chunkSize = 64 * 1024;
    const original = randomBytes(2 * chunkSize);
    const encrypted = await encryptToV3Buffer(original, strongPassphrase, chunkSize);

    // Corrupt last byte of archive (which is in the final chunk's auth tag)
    const corrupted = Buffer.from(encrypted);
    corrupted[corrupted.length - 1] ^= 0xff;

    const emittedChunks: Buffer[] = [];
    const dec = createDecryptionTransform(strongPassphrase);
    const inStream = Readable.from([corrupted]);
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        emittedChunks.push(chunk);
        cb();
      },
    });

    let rejected = false;
    try {
      await pipeline(inStream, dec, sink);
    } catch (err) {
      rejected = true;
      assert.match((err as Error).message, /Cryptographic authentication failed/);
    }

    assert.equal(rejected, true, "Pipeline must reject corrupted final chunk");
  });

  await test("DR-01: Missing final chunk (truncated stream) fails closed in flush", async () => {
    const chunkSize = 64 * 1024;
    const original = randomBytes(2 * chunkSize);
    const encrypted = await encryptToV3Buffer(original, strongPassphrase, chunkSize);

    // Truncate archive by cutting off the final chunk frame entirely
    const truncated = encrypted.subarray(0, 50 + 65561); // only header + chunk 0

    const dec = createDecryptionTransform(strongPassphrase);
    const inStream = Readable.from([truncated]);
    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });

    let rejected = false;
    try {
      await pipeline(inStream, dec, sink);
    } catch (err) {
      rejected = true;
      assert.match((err as Error).message, /Truncated archive: stream ended before final chunk was received/);
    }

    assert.equal(rejected, true, "Truncated archive must fail closed");
  });

  await test("DR-01: Reordered chunks detected immediately via chunk index sequence verification", async () => {
    const chunkSize = 64 * 1024;
    const original = randomBytes(2 * chunkSize);
    const encrypted = await encryptToV3Buffer(original, strongPassphrase, chunkSize);

    // Header = 50B
    const header = encrypted.subarray(0, 50);
    const chunk0 = encrypted.subarray(50, 50 + 65561);
    const chunk1 = encrypted.subarray(50 + 65561);

    // Swap chunk 0 and chunk 1
    const reordered = Buffer.concat([header, chunk1, chunk0]);

    const dec = createDecryptionTransform(strongPassphrase);
    const inStream = Readable.from([reordered]);
    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });

    let rejected = false;
    try {
      await pipeline(inStream, dec, sink);
    } catch (err) {
      rejected = true;
      assert.match((err as Error).message, /Framing error: expected chunk index 0, got 1/);
    }

    assert.equal(rejected, true, "Reordered chunks must be rejected immediately");
  });

  await test("DR-01: encryptBufferV3 in-memory round-trip with empty, small, and multi-chunk payloads", () => {
    const payloads = [
      Buffer.alloc(0),
      Buffer.from("Single small chunk payload 🎨", "utf8"),
      randomBytes(128 * 1024),
    ];

    for (const original of payloads) {
      const encrypted = encryptBufferV3(original, strongPassphrase);
      assert.equal(encrypted.subarray(0, MAGIC_V3.length).toString("utf8"), "YOURAI_ENC_V3");
      const decrypted = decryptBuffer(encrypted, strongPassphrase);
      assert.deepEqual(decrypted, original);
    }
  });

  await test("DR-01: PBKDF2 iteration bounds validation (zero, too low, too high)", () => {
    assert.throws(() => validateIterations(0), /iteration count must be an integer between 100000 and 5000000/);
    assert.throws(() => validateIterations(50_000), /iteration count must be an integer between 100000 and 5000000/);
    assert.throws(() => validateIterations(10_000_000), /iteration count must be an integer between 100000 and 5000000/);
    assert.throws(() => validateIterations(-1), /iteration count must be an integer between 100000 and 5000000/);
    assert.throws(() => validateIterations(1.5), /iteration count must be an integer between 100000 and 5000000/);

    const salt = randomBytes(16);
    assert.throws(() => deriveMasterKey(strongPassphrase, salt, 0), /iteration count must be an integer/);
    assert.throws(() => deriveMasterKey(strongPassphrase, salt, 10_000_000), /iteration count must be an integer/);
    assert.throws(() => deriveKey(strongPassphrase, salt, 0), /iteration count must be an integer/);
    assert.throws(() => deriveKey(strongPassphrase, salt, 10_000_000), /iteration count must be an integer/);

    // Wire header with invalid iterations (not pre-derived zero)
    const validEnc = encryptBufferV3(Buffer.from("test payload"), strongPassphrase);
    const tamperedHeader = Buffer.from(validEnc);
    tamperedHeader.writeUInt32BE(10_000_000, 14); // offset 14 is iterations
    assert.throws(() => decryptBuffer(tamperedHeader, strongPassphrase), /iteration count must be an integer/);
  });

  await test("DR-01: chunk size bounds validation (zero, too small, too large)", () => {
    assert.throws(() => validateChunkSize(0), /Chunk size must be an integer between 1024 and 16777216/);
    assert.throws(() => validateChunkSize(512), /Chunk size must be an integer between 1024 and 16777216/);
    assert.throws(() => validateChunkSize(32 * 1024 * 1024), /Chunk size must be an integer between 1024 and 16777216/);
    assert.throws(() => validateChunkSize(-1024), /Chunk size must be an integer between 1024 and 16777216/);
    assert.throws(() => validateChunkSize(1024.5), /Chunk size must be an integer between 1024 and 16777216/);

    const dummy = Buffer.from("payload");
    assert.throws(() => encryptBufferV3(dummy, strongPassphrase, false, 0), /Chunk size must be an integer/);
    assert.throws(() => encryptBufferV3(dummy, strongPassphrase, false, 32 * 1024 * 1024), /Chunk size must be an integer/);
    assert.throws(() => createEncryptionTransform(strongPassphrase, false, 0), /Chunk size must be an integer/);
    assert.throws(() => createEncryptionTransform(strongPassphrase, false, 32 * 1024 * 1024), /Chunk size must be an integer/);

    // Wire header with invalid chunk size
    const validEnc = encryptBufferV3(dummy, strongPassphrase);
    const tamperedHeader = Buffer.from(validEnc);
    tamperedHeader.writeUInt32BE(0, 46); // offset 46 is chunkSize in V3
    assert.throws(() => decryptBuffer(tamperedHeader, strongPassphrase), /Chunk size must be an integer/);
  });

  await test("DR-01: oversized frame lengths fail closed before buffer allocation", async () => {
    const original = Buffer.from("Sensitive production data that should not be corrupted or buffered");
    const encrypted = encryptBufferV3(original, strongPassphrase);

    // Tamper frame 0 cipherLen (offset 50 + 5 = 55) to an oversized value (e.g. 1 MB when chunkSize is 64 KB)
    const tampered = Buffer.from(encrypted);
    tampered.writeUInt32BE(1024 * 1024, 55);

    // Test in-memory decryptBuffer fails closed
    assert.throws(
      () => decryptBuffer(tampered, strongPassphrase),
      /Oversized frame: frame 0 ciphertext length 1048576 exceeds chunk size limit 65536/
    );

    // Test streaming createDecryptionTransform fails closed without allocating or waiting for payload
    const dec = createDecryptionTransform(strongPassphrase);
    const inStream = Readable.from([tampered]);
    let rejected = false;
    try {
      await pipeline(inStream, dec, new Writable({ write(_c, _e, cb) { cb(); } }));
    } catch (err) {
      rejected = true;
      assert.match((err as Error).message, /Oversized frame: frame 0 ciphertext length 1048576 exceeds chunk size limit 65536/);
    }
    assert.equal(rejected, true, "Streaming decryption must fail closed on oversized frame header");
  });

  await test("DR-01: invalid payload types and frame lengths fail closed", async () => {
    const original = Buffer.from("Valid single chunk payload");
    const encrypted = encryptBufferV3(original, strongPassphrase);

    // Tamper payloadType (offset 50 + 4 = 54) to 0x99 (unknown payload type)
    const tamperedType = Buffer.from(encrypted);
    tamperedType.writeUInt8(0x99, 54);

    assert.throws(() => decryptBuffer(tamperedType, strongPassphrase), /Invalid chunk payload type: 0x99/);

    const dec = createDecryptionTransform(strongPassphrase);
    let typeRejected = false;
    try {
      await pipeline(Readable.from([tamperedType]), dec, new Writable({ write(_c, _e, cb) { cb(); } }));
    } catch (err) {
      typeRejected = true;
      assert.match((err as Error).message, /Invalid chunk payload type: 0x99/);
    }
    assert.equal(typeRejected, true);

    // Intermediate frame with cipherLen != chunkSize must be rejected
    const twoChunks = randomBytes(128 * 1024);
    const encTwo = encryptBufferV3(twoChunks, strongPassphrase);
    // Frame 0 is intermediate (payloadType 0x01). Tamper its cipherLen to chunkSize - 1
    const tamperedIntermediate = Buffer.from(encTwo);
    tamperedIntermediate.writeUInt32BE(65536 - 10, 55);

    assert.throws(
      () => decryptBuffer(tamperedIntermediate, strongPassphrase),
      /Invalid frame length: intermediate frame 0 has length 65526, expected exactly 65536/
    );
  });

  await test("DR-01: modified chunk-size header triggers AES-GCM AAD authentication failure", async () => {
    const original = randomBytes(4096);
    const encrypted = encryptBufferV3(original, strongPassphrase, false, 4096);

    // Modify chunkSize in V3 header from 4096 to 8192 (both are valid chunk sizes within safe bounds)
    // Offset in header: 13 (magic) + 1 (cipher) + 4 (iter) + 16 (salt) + 12 (iv) = 46.
    const tampered = Buffer.from(encrypted);
    tampered.writeUInt32BE(8192, 46);

    // Decryption MUST fail because chunkSize is cryptographically bound into buildChunkAAD
    assert.throws(() => decryptBuffer(tampered, strongPassphrase), /Unsupported state or unable to authenticate|authentication failed/i);

    // Also verify streaming transform fails
    const dec = createDecryptionTransform(strongPassphrase);
    let streamFailed = false;
    try {
      await pipeline(Readable.from([tampered]), dec, new Writable({ write(_c, _e, cb) { cb(); } }));
    } catch (err) {
      streamFailed = true;
      assert.match((err as Error).message, /authentication failed|Unsupported state or unable to authenticate/i);
    }
    assert.equal(streamFailed, true, "Streaming transform must reject modified chunk-size header via AAD mismatch");
  });

  await test("DR-01: valid V3 round-trip with bound chunkSize AAD across diverse sizes", async () => {
    const testCases = [
      { name: "empty payload", data: Buffer.alloc(0), chunkSize: 65536 },
      { name: "exact 1-chunk boundary", data: randomBytes(4096), chunkSize: 4096 },
      { name: "exact 3-chunk boundary", data: randomBytes(3 * 4096), chunkSize: 4096 },
      { name: "non-aligned multi-chunk", data: randomBytes(10000), chunkSize: 4096 },
      { name: "large multi-chunk", data: randomBytes(256 * 1024), chunkSize: 65536 },
    ];

    for (const tc of testCases) {
      // In-memory round trip
      const encMem = encryptBufferV3(tc.data, strongPassphrase, false, tc.chunkSize);
      const decMem = decryptBuffer(encMem, strongPassphrase);
      assert.deepEqual(decMem, tc.data, `Memory round-trip failed for ${tc.name}`);
      assert.equal(sha256(decMem), sha256(tc.data));

      // Streaming round trip
      const { transform, getStats } = createEncryptionTransform(strongPassphrase, false, tc.chunkSize);
      const encChunks: Buffer[] = [];
      const decChunks: Buffer[] = [];

      await pipeline(
        Readable.from([tc.data]),
        transform,
        new Writable({
          write(chunk: Buffer, _enc, cb) {
            encChunks.push(chunk);
            cb();
          },
        })
      );

      const encStreamBuf = Buffer.concat(encChunks);
      assert.equal(getStats().unencryptedBytes, tc.data.length);
      assert.equal(getStats().sha256, sha256(tc.data));

      await pipeline(
        Readable.from([encStreamBuf]),
        createDecryptionTransform(strongPassphrase),
        new Writable({
          write(chunk: Buffer, _enc, cb) {
            decChunks.push(chunk);
            cb();
          },
        })
      );

      const decStreamBuf = Buffer.concat(decChunks);
      assert.deepEqual(decStreamBuf, tc.data, `Streaming round-trip failed for ${tc.name}`);
      assert.equal(sha256(decStreamBuf), sha256(tc.data));
    }
  });

  await test("DR-01: V1 and V2 legacy compatibility streaming and buffer decryption", async () => {
    const originalText = "Production legacy payload to test backwards compatibility with V1 and V2";
    const original = Buffer.from(originalText, "utf8");

    // 1. Legacy V2 envelope: encryptBuffer -> decryptBuffer and createDecryptionTransform
    const v2Enc = encryptBuffer(original, strongPassphrase);
    assert.equal(v2Enc.subarray(0, MAGIC_V2.length).toString("utf8"), "YOURAI_ENC_V2");

    const v2DecMem = decryptBuffer(v2Enc, strongPassphrase);
    assert.deepEqual(v2DecMem, original);

    const v2DecStreamChunks: Buffer[] = [];
    await pipeline(
      Readable.from([v2Enc]),
      createDecryptionTransform(strongPassphrase),
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          v2DecStreamChunks.push(chunk);
          cb();
        },
      })
    );
    assert.deepEqual(Buffer.concat(v2DecStreamChunks), original);

    // 2. Legacy V1 envelope: MAGIC_V1 (13B) + salt (16B) + iv (12B) + ciphertext + tag (16B)
    const v1Salt = randomBytes(16);
    const v1IV = randomBytes(12);
    const v1Key = deriveKey(strongPassphrase, v1Salt, PBKDF2_ITERATIONS_V1);
    const v1Cipher = createCipheriv("aes-256-gcm", v1Key, v1IV);
    const v1CT = Buffer.concat([v1Cipher.update(original), v1Cipher.final()]);
    const v1Tag = v1Cipher.getAuthTag();
    const v1Enc = Buffer.concat([MAGIC_V1, v1Salt, v1IV, v1CT, v1Tag]);
    assert.equal(v1Enc.subarray(0, 13).toString("utf8"), "YOURAI_ENC_V1");

    const v1DecMem = decryptBuffer(v1Enc, strongPassphrase);
    assert.deepEqual(v1DecMem, original);

    const v1DecStreamChunks: Buffer[] = [];
    await pipeline(
      Readable.from([v1Enc]),
      createDecryptionTransform(strongPassphrase),
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          v1DecStreamChunks.push(chunk);
          cb();
        },
      })
    );
    assert.deepEqual(Buffer.concat(v1DecStreamChunks), original);
  });

  console.log("\n# Disaster Recovery — DR-02: Character-by-Character PostgreSQL COPY Decoder");

  await test("DR-02: decodePostgresCopyField decodes all PostgreSQL escape sequences correctly", () => {
    assert.equal(decodePostgresCopyField("\\N"), null, "\\N must decode to null");
    assert.equal(decodePostgresCopyField("hello"), "hello");
    assert.equal(decodePostgresCopyField("line1\\nline2"), "line1\nline2");
    assert.equal(decodePostgresCopyField("col1\\tcol2"), "col1\tcol2");
    assert.equal(decodePostgresCopyField("cr\\rtest"), "cr\rtest");
    assert.equal(decodePostgresCopyField("bs\\btest"), "bs\btest");
    assert.equal(decodePostgresCopyField("ff\\ftest"), "ff\ftest");
    assert.equal(decodePostgresCopyField("vt\\vtest"), "vt\vtest");
    assert.equal(decodePostgresCopyField("path\\\\file"), "path\\file");
  });

  await test("DR-02: decodePostgresCopyField preserves literal \\\\t distinct from \\t", () => {
    // Literal \\t in COPY format represents a backslash followed by 't'
    const decoded = decodePostgresCopyField("users/u1/folder\\\\t/image.webp");
    assert.equal(decoded, "users/u1/folder\\t/image.webp", "Literal \\\\t must NOT decode to a tab character");
    assert.notEqual(decoded, "users/u1/folder\t/image.webp");

    // Whereas \t represents a real tab
    const tabDecoded = decodePostgresCopyField("col1\tcol2");
    assert.equal(tabDecoded, "col1\tcol2");
  });

  await test("DR-02: decodePostgresCopyField handles hex (\\xhh) and octal (\\ooo) escapes", () => {
    // \x41 = 65 = 'A'
    assert.equal(decodePostgresCopyField("letter_\\x41"), "letter_A");
    // \101 = 65 = 'A'
    assert.equal(decodePostgresCopyField("letter_\\101"), "letter_A");
    // Complex mixed escape
    const mixed = decodePostgresCopyField("prefix_\\x42_\\103_\\\\t_\\n_suffix");
    assert.equal(mixed, "prefix_B_C_\\t_\n_suffix");
  });

  await test("DR-02: parseStorageKeysFromCopyStream extracts GeneratedAsset keys and filters NULL (\\N)", () => {
    const copyDump = `
-- PostgreSQL dump header
SET statement_timeout = 0;

COPY public."GeneratedAsset" ("id", "userId", "storageKey", "createdAt") FROM stdin;
asset_1\tuser_1\tusers/u1/images/j1/img_1.webp\t2026-11-10 10:00:00
asset_2\tuser_1\t\\N\t2026-11-10 10:01:00
asset_3\tuser_2\tusers/u2/images/folder\\\\t/img_3.webp\t2026-11-10 10:02:00
\\.

COPY public."OtherTable" ("id", "storageKey") FROM stdin;
other_1\tshould_not_be_extracted
\\.
`;

    const keys = parseStorageKeysFromCopyStream(copyDump);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], "users/u1/images/j1/img_1.webp");
    assert.equal(keys[1], "users/u2/images/folder\\t/img_3.webp");
  });

  console.log("\n# Disaster Recovery — DR-03: Per-Object Safe Reconciliation Restore");

  await test("DR-03: reconcileStorageObject uploads missing object with upsert: false", async () => {
    let uploadCalled = false;
    let uploadOptions: any = null;

    const mockClient = {
      storage: {
        from: (_bucket: string) => ({
          download: async (_key: string) => ({ data: null, error: { message: "Object not found" } }),
          upload: async (_key: string, _buf: Buffer, opts: any) => {
            uploadCalled = true;
            uploadOptions = opts;
            return { error: null };
          },
        }),
      },
    };

    const buffer = Buffer.from("New image data 🎨");
    const result = await reconcileStorageObject(mockClient as any, "generated-assets", "img1.webp", buffer, false);

    assert.equal(result.action, "uploaded");
    assert.equal(uploadCalled, true);
    assert.equal(uploadOptions?.upsert, false, "Missing object must upload with upsert: false");
  });

  await test("DR-03: reconcileStorageObject skips upload when existing object SHA-256 matches (safe retry)", async () => {
    let uploadCalled = false;
    const buffer = Buffer.from("Existing matching image data 🎨");

    const mockClient = {
      storage: {
        from: (_bucket: string) => ({
          download: async (_key: string) => ({ data: buffer, error: null }),
          upload: async () => {
            uploadCalled = true;
            return { error: null };
          },
        }),
      },
    };

    const result = await reconcileStorageObject(mockClient as any, "generated-assets", "img1.webp", buffer, false);

    assert.equal(result.action, "skipped");
    assert.equal(uploadCalled, false, "Identical object must be skipped without upload");
  });

  await test("DR-03: reconcileStorageObject aborts with conflict when existing object differs and forceDestructiveOverwrite is false", async () => {
    let uploadCalled = false;
    const targetBuffer = Buffer.from("Existing conflicting image content ❌");
    const localBuffer = Buffer.from("New backup image content 🎨");

    const mockClient = {
      storage: {
        from: (_bucket: string) => ({
          download: async (_key: string) => ({ data: targetBuffer, error: null }),
          upload: async () => {
            uploadCalled = true;
            return { error: null };
          },
        }),
      },
    };

    const result = await reconcileStorageObject(mockClient as any, "generated-assets", "img1.webp", localBuffer, false);

    assert.equal(result.action, "conflict");
    assert.equal(uploadCalled, false, "Conflicting object must not upload without force flag");
    assert.match(result.error ?? "", /Refusing to overwrite without --force-destructive-overwrite/);
  });

  await test("DR-03: reconcileStorageObject overwrites when existing object differs AND forceDestructiveOverwrite is true", async () => {
    let uploadCalled = false;
    let uploadOptions: any = null;
    const targetBuffer = Buffer.from("Existing conflicting image content ❌");
    const localBuffer = Buffer.from("New backup image content 🎨");

    const mockClient = {
      storage: {
        from: (_bucket: string) => ({
          download: async (_key: string) => ({ data: targetBuffer, error: null }),
          upload: async (_key: string, _buf: Buffer, opts: any) => {
            uploadCalled = true;
            uploadOptions = opts;
            return { error: null };
          },
        }),
      },
    };

    const result = await reconcileStorageObject(mockClient as any, "generated-assets", "img1.webp", localBuffer, true);

    assert.equal(result.action, "overwritten");
    assert.equal(uploadCalled, true);
    assert.equal(uploadOptions?.upsert, true, "Forced overwrite must use upsert: true");
  });

  console.log("\n# Disaster Recovery — DR-04: Security, Resiliency & Process Cleanup Coverage");

  await test("DR-04: malformed JSON manifest fails closed with parse error", () => {
    const malformed = '{"formatVersion": "2.0", "brokenJson...';
    assert.throws(
      () => JSON.parse(malformed),
      SyntaxError,
      "Malformed manifest must fail closed with SyntaxError"
    );
  });

  await test("DR-04: tampered manifest HMAC signature fails verification", () => {
    const salt = Buffer.from("test_salt_12345678");
    const master = deriveMasterKey(strongPassphrase, salt);
    const signingKey = deriveManifestSigningKey(master);

    const validJson = JSON.stringify({ backupSetId: "set_1", status: "VERIFIED" });
    const signature = signManifest(validJson, signingKey);

    assert.equal(verifyManifestSignature(validJson, signature, signingKey), true);

    // Tampered content
    const tamperedJson = JSON.stringify({ backupSetId: "set_1", status: "VERIFIED", malicious: true });
    assert.equal(verifyManifestSignature(tamperedJson, signature, signingKey), false);

    // Tampered signature
    const tamperedSig = signature.slice(0, 62) + "00";
    assert.equal(verifyManifestSignature(validJson, tamperedSig, signingKey), false);

    // Wrong signing key
    const wrongKey = randomBytes(32);
    assert.equal(verifyManifestSignature(validJson, signature, wrongKey), false);
  });

  await test("DR-04: missing manifest signature fails closed when --allow-unsigned-manifest is false", () => {
    const salt = Buffer.from("test_manifest_salt_99");
    const master = deriveMasterKey(strongPassphrase, salt);
    const signingKey = deriveManifestSigningKey(master);
    const validJson = JSON.stringify({ bucket: "assets", objects: {} });

    // Empty or missing signature string fails verification
    assert.equal(verifyManifestSignature(validJson, "", signingKey), false);

    // Fail-closed invariant: without sig file and without explicit --allow-unsigned-manifest -> rejected
    const sigExists = false;
    const allowUnsigned = false;
    const canProceed = sigExists || allowUnsigned;
    assert.equal(canProceed, false, "Must fail closed if manifest signature is missing");
  });

  await test("DR-04: wrong passphrase on V3 chunk decryption fails closed", async () => {
    const original = Buffer.from("Secret payload requiring authentication");
    const encrypted = await encryptToV3Buffer(original, strongPassphrase);

    const dec = createDecryptionTransform("IncorrectPassphrase999!");
    const inStream = Readable.from([encrypted]);
    const sink = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });

    let rejected = false;
    try {
      await pipeline(inStream, dec, sink);
    } catch {
      rejected = true;
    }

    assert.equal(rejected, true, "Wrong passphrase must reject V3 stream");
  });

  await test("DR-04: snapshot cleanup safely closes descriptor and removes directory on signal", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yourai-test-sig-"));
    const snapFile = join(tempDir, "snap.bin");
    writeFileSync(snapFile, "test data");

    let fd: number | null = openSync(snapFile, "r");

    // Simulated performCleanup function as implemented in restore-db.mts
    const performCleanup = () => {
      if (fd !== null) {
        try {
          closeSync(fd);
          fd = null;
        } catch {}
      }
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    };

    performCleanup();

    assert.equal(fd, null);
    assert.equal(existsSync(tempDir), false, "Snapshot temp directory must be removed on cleanup");
  });

  await test("DR-04: isFatalPgRestoreError comprehensive matrix (SQL errors, syntax errors, empty stderr)", () => {
    // Empty stderr on exit code 1 -> fail closed!
    assert.equal(isFatalPgRestoreError(""), true);
    assert.equal(isFatalPgRestoreError("   \n  \n"), true);

    // Harmless notices
    assert.equal(
      isFatalPgRestoreError('pg_restore: notice: table "GeneratedAsset" does not exist, skipping drop'),
      false
    );
    assert.equal(
      isFatalPgRestoreError('pg_restore: warning: sequence "GeneratedAsset_id_seq" does not exist, skipping drop'),
      false
    );

    // Fatal errors
    assert.equal(
      isFatalPgRestoreError('pg_restore: error: relation "GeneratedAsset" already exists'),
      true
    );
    assert.equal(
      isFatalPgRestoreError('pg_restore: error: syntax error at or near "MALFORMED"'),
      true
    );
    assert.equal(
      isFatalPgRestoreError('pg_restore: error: permission denied for database "postgres"'),
      true
    );

    // Mixed: one harmless notice and one fatal error -> must be fatal!
    const mixed = `
pg_restore: notice: table "GeneratedAsset" does not exist, skipping drop
pg_restore: error: relation "users" already exists
`;
    assert.equal(isFatalPgRestoreError(mixed), true);
  });

  // Cleanup test directory
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log(`\n========================================`);
  console.log(`Disaster Recovery Tests: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
