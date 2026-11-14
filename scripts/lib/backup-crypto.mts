import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  pbkdf2,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Production-Grade Authenticated Encryption Primitives for Pixora Disaster Recovery
 *
 * Wire Format Version 3 (YOURAI_ENC_V3) - Chunk-Framed Authenticated Encryption:
 * +-------------------+-------------+-------------------+-----------------+----------------+-------------------+
 * | Magic (13 bytes)  | Cipher (1B) | Iterations (4B)   | Salt (16 bytes) | Base IV (12B)  | Chunk Size (4B)   |
 * | "YOURAI_ENC_V3"   | 0x01 (GCM)  | Big-Endian uint32 | Master salt     | Nonce base     | e.g. 64 KB        |
 * +-------------------+-------------+-------------------+-----------------+----------------+-------------------+
 * Followed by independently authenticated frames:
 * +-------------------+------------------+-----------------------+-------------------------+-------------------+
 * | Chunk Index (4B)  | Payload Type(1B) | Ciphertext Len (4B)   | Ciphertext (Len bytes)  | GCM Tag (16 bytes)|
 * | uint32BE          | 0x01=mid,0x02=end| uint32BE              | AES-256-GCM encrypted   | Verified BEFORE   |
 * |                   |                  |                       | payload                 | plaintext release |
 * +-------------------+------------------+-----------------------+-------------------------+-------------------+
 *
 * Wire Format Version 2 (YOURAI_ENC_V2):
 * +-------------------+-------------+-------------------+-----------------+----------------+-----------------------+-------------------+
 * | Magic (13 bytes)  | Cipher (1B) | Iterations (4B)   | Salt (16 bytes) | IV (12 bytes)  | Ciphertext (N bytes)  | GCM Tag (16 bytes)|
 * | "YOURAI_ENC_V2"   | 0x01 (GCM)  | Big-Endian uint32 | Master/file salt| AES-GCM nonce  | Encrypted payload     | Authentication tag|
 * +-------------------+-------------+-------------------+-----------------+----------------+-----------------------+-------------------+
 *
 * Backward-Compatible Format Version 1 (YOURAI_ENC_V1):
 * +-------------------+-----------------+----------------+-----------------------+-------------------+
 * | Magic (13 bytes)  | Salt (16 bytes) | IV (12 bytes)  | Ciphertext (N bytes)  | GCM Tag (16 bytes)|
 * | "YOURAI_ENC_V1"   | 16-byte salt    | 12-byte IV     | Encrypted payload     | 100k iter PBKDF2  |
 * +-------------------+-----------------+----------------+-----------------------+-------------------+
 *
 * Cryptographic Architecture:
 *  - Master Key: PBKDF2-HMAC-SHA256 with 600,000 iterations (OWASP standard).
 *  - Sub-keys (per-object/per-archive): HKDF-SHA256 derivation in <1 microsecond.
 *  - AEAD: AES-256-GCM with unique 96-bit nonce per chunk frame derived from Base IV and chunk index.
 *  - Authenticated AAD: Binds magic, salt, iterations, chunk index, and payload type.
 *  - Zero unauthenticated plaintext: Plaintext is released ONLY AFTER chunk GCM tag verification succeeds.
 */

export const MAGIC_V1 = Buffer.from("YOURAI_ENC_V1", "utf8");
export const MAGIC_V2 = Buffer.from("YOURAI_ENC_V2", "utf8");
export const MAGIC_V3 = Buffer.from("YOURAI_ENC_V3", "utf8");
export const MAGIC_LEN = 13; // 13 bytes
export const CIPHER_AES_256_GCM = 0x01;
export const CIPHER_LEN = 1;
export const ITERATIONS_LEN = 4;
export const SALT_LEN = 16;
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const CHUNK_SIZE_LEN = 4;

export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KB
export const PAYLOAD_TYPE_INTERMEDIATE = 0x01;
export const PAYLOAD_TYPE_FINAL = 0x02;

export const HEADER_LEN_V1 = MAGIC_LEN + SALT_LEN + IV_LEN; // 41 bytes
export const HEADER_LEN_V2 = MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN + SALT_LEN + IV_LEN; // 46 bytes
export const HEADER_LEN_V3 = MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN + SALT_LEN + IV_LEN + CHUNK_SIZE_LEN; // 50 bytes

export const PBKDF2_ITERATIONS_V1 = 100_000;
export const PBKDF2_ITERATIONS_V2 = 600_000;
export const MIN_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 5_000_000;

export const MIN_CHUNK_SIZE = 1024; // 1 KB
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB

export const KEY_LEN = 32; // 256 bits
export const MIN_PASSPHRASE_LEN = 16;

export interface WireHeaderInfo {
  version: 1 | 2 | 3;
  headerLength: number;
  cipherId: number;
  iterations: number;
  salt: Buffer;
  iv: Buffer;
  chunkSize?: number;
}

/**
 * Validates PBKDF2 iteration count against explicit safe boundaries (100k to 5M).
 */
export function validateIterations(iterations: number): void {
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < MIN_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error(
      `PBKDF2 iteration count must be an integer between ${MIN_PBKDF2_ITERATIONS} and ${MAX_PBKDF2_ITERATIONS} (received: ${iterations}).`
    );
  }
}

/**
 * Validates chunk size against explicit supported boundaries (1 KB to 16 MB).
 */
export function validateChunkSize(chunkSize: number): void {
  if (
    typeof chunkSize !== "number" ||
    !Number.isInteger(chunkSize) ||
    chunkSize < MIN_CHUNK_SIZE ||
    chunkSize > MAX_CHUNK_SIZE
  ) {
    throw new Error(
      `Chunk size must be an integer between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE} bytes (received: ${chunkSize}).`
    );
  }
}

/**
 * Validates passphrase strength. Commercial SaaS DR requires >= 16 characters.
 */
export function validatePassphrase(passphrase: string): void {
  if (!passphrase || typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(
      `Backup encryption passphrase must be at least ${MIN_PASSPHRASE_LEN} characters for commercial disaster recovery.`
    );
  }
}

/**
 * Derives a 256-bit Master Key from a passphrase using PBKDF2-HMAC-SHA256.
 */
export function deriveMasterKey(
  passphrase: string,
  salt: Buffer,
  iterations: number = PBKDF2_ITERATIONS_V2
): Buffer {
  validatePassphrase(passphrase);
  validateIterations(iterations);
  return pbkdf2Sync(passphrase, salt, iterations, KEY_LEN, "sha256");
}

/**
 * Asynchronously derives a 256-bit Master Key using PBKDF2 without blocking the Node event loop.
 */
export async function deriveMasterKeyAsync(
  passphrase: string,
  salt: Buffer,
  iterations: number = PBKDF2_ITERATIONS_V2
): Promise<Buffer> {
  validatePassphrase(passphrase);
  validateIterations(iterations);
  return new Promise((resolve, reject) => {
    pbkdf2(passphrase, salt, iterations, KEY_LEN, "sha256", (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Derives a fast sub-key from a Master Key using HKDF-SHA256.
 * Takes < 1 microsecond; used for per-object storage encryption without re-running PBKDF2.
 */
export function deriveSubKey(masterKey: Buffer, contextInfo: string): Buffer {
  if (masterKey.length !== KEY_LEN) {
    throw new Error(`Master key must be exactly ${KEY_LEN} bytes.`);
  }
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.alloc(0), Buffer.from(contextInfo, "utf8"), KEY_LEN)
  );
}

/**
 * Backwards-compatible deriveKey for V1 code/tests.
 */
export function deriveKey(
  passphrase: string,
  salt: Buffer,
  iterations: number = PBKDF2_ITERATIONS_V2
): Buffer {
  if (passphrase.length < 8) {
    throw new Error("Backup encryption passphrase must be at least 8 characters.");
  }
  validateIterations(iterations);
  return pbkdf2Sync(passphrase, salt, iterations, KEY_LEN, "sha256");
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Derives a deterministic unique 12-byte IV for a chunk index from base IV.
 */
export function deriveChunkIV(baseIV: Buffer, chunkIndex: number): Buffer {
  const iv = Buffer.from(baseIV);
  const baseCounter = baseIV.readUInt32BE(8);
  iv.writeUInt32BE((baseCounter + (chunkIndex >>> 0)) >>> 0, 8);
  return iv;
}

/**
 * Constructs Additional Authenticated Data (AAD) for a chunk, binding the archive parameters,
 * chunk size, chunk index, and payload type cryptographically into the AES-GCM tag.
 */
export function buildChunkAAD(
  magic: Buffer,
  salt: Buffer,
  iterations: number,
  chunkSize: number,
  chunkIndex: number,
  payloadType: number
): Buffer {
  const aad = Buffer.alloc(13 + 16 + 4 + 4 + 4 + 1); // 42 bytes
  magic.copy(aad, 0);                 // 0..12 (13B)
  salt.copy(aad, 13);                 // 13..28 (16B)
  aad.writeUInt32BE(iterations, 29);  // 29..32 (4B)
  aad.writeUInt32BE(chunkSize, 33);   // 33..36 (4B)
  aad.writeUInt32BE(chunkIndex, 37);  // 37..40 (4B)
  aad.writeUInt8(payloadType, 41);    // 41 (1B)
  return aad;
}

/**
 * Parses header from buffer, returning metadata for V1, V2, or V3 envelopes.
 */
export function parseWireHeader(headerBytes: Buffer): WireHeaderInfo {
  if (headerBytes.length < HEADER_LEN_V1) {
    throw new Error("Header is too short to be a valid backup file.");
  }

  const magic = headerBytes.subarray(0, MAGIC_LEN);

  if (magic.equals(MAGIC_V3)) {
    if (headerBytes.length < HEADER_LEN_V3) {
      throw new Error("Incomplete V3 header.");
    }
    const cipherId = headerBytes.readUInt8(MAGIC_LEN);
    if (cipherId !== CIPHER_AES_256_GCM) {
      throw new Error(`Unsupported cipher suite ID: 0x${cipherId.toString(16)}`);
    }
    const iterations = headerBytes.readUInt32BE(MAGIC_LEN + CIPHER_LEN);
    if (iterations !== 0) {
      validateIterations(iterations);
    }
    const salt = headerBytes.subarray(
      MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN,
      MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN + SALT_LEN
    );
    const iv = headerBytes.subarray(
      MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN + SALT_LEN,
      MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN + SALT_LEN + IV_LEN
    );
    const chunkSize = headerBytes.readUInt32BE(
      MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN + SALT_LEN + IV_LEN
    );
    validateChunkSize(chunkSize);

    return {
      version: 3,
      headerLength: HEADER_LEN_V3,
      cipherId,
      iterations,
      salt,
      iv,
      chunkSize,
    };
  }

  if (magic.equals(MAGIC_V2)) {
    if (headerBytes.length < HEADER_LEN_V2) {
      throw new Error("Incomplete V2 header.");
    }
    const cipherId = headerBytes.readUInt8(MAGIC_LEN);
    if (cipherId !== CIPHER_AES_256_GCM) {
      throw new Error(`Unsupported cipher suite ID: 0x${cipherId.toString(16)}`);
    }
    const iterations = headerBytes.readUInt32BE(MAGIC_LEN + CIPHER_LEN);
    if (iterations !== 0) {
      validateIterations(iterations);
    }
    const salt = headerBytes.subarray(
      MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN,
      MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN + SALT_LEN
    );
    const iv = headerBytes.subarray(
      MAGIC_LEN + CIPHER_LEN + ITERATIONS_LEN + SALT_LEN,
      HEADER_LEN_V2
    );

    return {
      version: 2,
      headerLength: HEADER_LEN_V2,
      cipherId,
      iterations,
      salt,
      iv,
    };
  }

  if (magic.equals(MAGIC_V1)) {
    const salt = headerBytes.subarray(MAGIC_LEN, MAGIC_LEN + SALT_LEN);
    const iv = headerBytes.subarray(MAGIC_LEN + SALT_LEN, HEADER_LEN_V1);

    return {
      version: 1,
      headerLength: HEADER_LEN_V1,
      cipherId: CIPHER_AES_256_GCM,
      iterations: PBKDF2_ITERATIONS_V1,
      salt,
      iv,
    };
  }

  throw new Error("Invalid backup file: magic header mismatch.");
}

/**
 * Encrypts an in-memory buffer using Version 3 chunk-framed authenticated envelope.
 */
export function encryptBufferV3(
  data: Buffer,
  passphraseOrKey: string | Buffer,
  isPreDerivedKey: boolean = false,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Buffer {
  validateChunkSize(chunkSize);
  const salt = randomBytes(SALT_LEN);
  const baseIV = randomBytes(IV_LEN);

  let key: Buffer;
  let iterations = PBKDF2_ITERATIONS_V2;

  if (isPreDerivedKey) {
    if (!Buffer.isBuffer(passphraseOrKey) || passphraseOrKey.length !== KEY_LEN) {
      throw new Error("Pre-derived key must be a 32-byte Buffer.");
    }
    key = deriveSubKey(passphraseOrKey, "stream:archive");
    iterations = 0;
  } else {
    const passphrase = typeof passphraseOrKey === "string" ? passphraseOrKey : passphraseOrKey.toString("utf8");
    key = deriveKey(passphrase, salt, iterations);
  }

  const iterBuf = Buffer.alloc(4);
  iterBuf.writeUInt32BE(iterations, 0);

  const chunkSizeBuf = Buffer.alloc(4);
  chunkSizeBuf.writeUInt32BE(chunkSize, 0);

  const header = Buffer.concat([
    MAGIC_V3,
    Buffer.from([CIPHER_AES_256_GCM]),
    iterBuf,
    salt,
    baseIV,
    chunkSizeBuf,
  ]);

  const frames: Buffer[] = [header];
  let chunkIndex = 0;
  let offset = 0;

  do {
    const end = Math.min(offset + chunkSize, data.length);
    const slice = data.subarray(offset, end);
    offset = end;
    const isFinal = offset >= data.length;
    const payloadType = isFinal ? PAYLOAD_TYPE_FINAL : PAYLOAD_TYPE_INTERMEDIATE;

    const chunkIV = deriveChunkIV(baseIV, chunkIndex);
    const cipher = createCipheriv("aes-256-gcm", key, chunkIV);
    const aad = buildChunkAAD(MAGIC_V3, salt, iterations, chunkSize, chunkIndex, payloadType);
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(slice), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const frameHeader = Buffer.alloc(9);
    frameHeader.writeUInt32BE(chunkIndex, 0);
    frameHeader.writeUInt8(payloadType, 4);
    frameHeader.writeUInt32BE(ciphertext.length, 5);

    frames.push(Buffer.concat([frameHeader, ciphertext, authTag]));
    chunkIndex++;
  } while (offset < data.length);

  return Buffer.concat(frames);
}

/**
 * Encrypts an in-memory buffer using Version 2 envelope (AES-256-GCM + 600k PBKDF2 or derived subkey).
 */
export function encryptBuffer(
  data: Buffer,
  passphraseOrKey: string | Buffer,
  isPreDerivedKey: boolean = false
): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);

  let key: Buffer;
  let iterations = PBKDF2_ITERATIONS_V2;

  if (isPreDerivedKey) {
    if (!Buffer.isBuffer(passphraseOrKey) || passphraseOrKey.length !== KEY_LEN) {
      throw new Error("Pre-derived key must be a 32-byte Buffer.");
    }
    key = passphraseOrKey;
    iterations = 0; // Indicating pre-derived key
  } else {
    const passphrase = typeof passphraseOrKey === "string" ? passphraseOrKey : passphraseOrKey.toString("utf8");
    key = deriveKey(passphrase, salt, iterations);
  }

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const iterBuf = Buffer.alloc(4);
  iterBuf.writeUInt32BE(iterations, 0);

  return Buffer.concat([
    MAGIC_V2,
    Buffer.from([CIPHER_AES_256_GCM]),
    iterBuf,
    salt,
    iv,
    ciphertext,
    authTag,
  ]);
}

/**
 * Decrypts an in-memory buffer with envelope version autodetection (supports V1, V2, and V3).
 */
export function decryptBuffer(
  encrypted: Buffer,
  passphraseOrKey: string | Buffer,
  isPreDerivedKey: boolean = false
): Buffer {
  if (encrypted.length < HEADER_LEN_V1 + TAG_LEN) {
    throw new Error("Encrypted payload is too small to be a valid backup file.");
  }

  const magic = encrypted.subarray(0, MAGIC_LEN);

  if (magic.equals(MAGIC_V3)) {
    const headerInfo = parseWireHeader(encrypted);
    const chunkSize = headerInfo.chunkSize!;
    let key: Buffer;
    if (isPreDerivedKey) {
      if (!Buffer.isBuffer(passphraseOrKey) || passphraseOrKey.length !== KEY_LEN) {
        throw new Error("Pre-derived master key must be a 32-byte Buffer.");
      }
      key = deriveSubKey(passphraseOrKey, "stream:archive");
    } else {
      const passphrase = typeof passphraseOrKey === "string" ? passphraseOrKey : passphraseOrKey.toString("utf8");
      key = deriveKey(passphrase, headerInfo.salt, headerInfo.iterations);
    }

    const plainChunks: Buffer[] = [];
    let offset = headerInfo.headerLength;
    let expectedIndex = 0;
    let seenFinal = false;

    while (offset < encrypted.length) {
      if (seenFinal) {
        throw new Error(`Extraneous frame encountered after final chunk at index ${expectedIndex}.`);
      }

      if (offset + 9 > encrypted.length) {
        throw new Error("Truncated chunk frame header in V3 archive.");
      }

      const chunkIdx = encrypted.readUInt32BE(offset);
      const payloadType = encrypted.readUInt8(offset + 4);
      const cipherLen = encrypted.readUInt32BE(offset + 5);

      if (payloadType !== PAYLOAD_TYPE_INTERMEDIATE && payloadType !== PAYLOAD_TYPE_FINAL) {
        throw new Error(`Invalid chunk payload type: 0x${payloadType.toString(16)}`);
      }

      if (chunkIdx !== expectedIndex) {
        throw new Error(`Framing error: expected chunk index ${expectedIndex}, got ${chunkIdx}.`);
      }

      if (cipherLen > chunkSize || cipherLen > MAX_CHUNK_SIZE) {
        throw new Error(
          `Oversized frame: frame ${chunkIdx} ciphertext length ${cipherLen} exceeds chunk size limit ${chunkSize}.`
        );
      }

      if (payloadType === PAYLOAD_TYPE_INTERMEDIATE && cipherLen !== chunkSize) {
        throw new Error(
          `Invalid frame length: intermediate frame ${chunkIdx} has length ${cipherLen}, expected exactly ${chunkSize}.`
        );
      }

      const totalFrameLen = 9 + cipherLen + TAG_LEN;
      if (offset + totalFrameLen > encrypted.length) {
        throw new Error("Truncated chunk frame payload or auth tag.");
      }

      const ciphertext = encrypted.subarray(offset + 9, offset + 9 + cipherLen);
      const authTag = encrypted.subarray(offset + 9 + cipherLen, offset + totalFrameLen);
      offset += totalFrameLen;

      const chunkIV = deriveChunkIV(headerInfo.iv, chunkIdx);
      const decipher = createDecipheriv("aes-256-gcm", key, chunkIV);
      const aad = buildChunkAAD(MAGIC_V3, headerInfo.salt, headerInfo.iterations, chunkSize, chunkIdx, payloadType);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);

      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      plainChunks.push(plaintext);
      expectedIndex++;

      if (payloadType === PAYLOAD_TYPE_FINAL) {
        seenFinal = true;
      }
    }

    if (!seenFinal) {
      throw new Error("Truncated archive: final chunk missing.");
    }

    return Buffer.concat(plainChunks);
  }

  const headerInfo = parseWireHeader(encrypted);
  const authTag = encrypted.subarray(encrypted.length - TAG_LEN);
  const ciphertext = encrypted.subarray(headerInfo.headerLength, encrypted.length - TAG_LEN);

  let key: Buffer;
  if (isPreDerivedKey) {
    if (!Buffer.isBuffer(passphraseOrKey) || passphraseOrKey.length !== KEY_LEN) {
      throw new Error("Pre-derived master key must be a 32-byte Buffer.");
    }
    // For buffers encrypted with HKDF, decrypt directly or with context
    key = passphraseOrKey;
  } else {
    const passphrase = typeof passphraseOrKey === "string" ? passphraseOrKey : passphraseOrKey.toString("utf8");
    key = deriveKey(passphrase, headerInfo.salt, headerInfo.iterations);
  }

  const decipher = createDecipheriv("aes-256-gcm", key, headerInfo.iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Streaming encryption transformer: takes unencrypted bytes, calculates SHA-256 on the fly,
 * emits [HEADER_V3] followed by chunk frames [CHUNK_INDEX][PAYLOAD_TYPE][LEN][CIPHERTEXT][AUTH_TAG]
 * directly to the output stream.
 * Each chunk is authenticated independently with unique nonce and AAD. Zero plaintext touches disk.
 */
export function createEncryptionTransform(
  passphraseOrKey: string | Buffer,
  isPreDerivedKey: boolean = false,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): {
  transform: Transform;
  getStats: () => { unencryptedBytes: number; sha256: string };
} {
  validateChunkSize(chunkSize);
  const salt = randomBytes(SALT_LEN);
  const baseIV = randomBytes(IV_LEN);
  let key: Buffer;
  let iterations = PBKDF2_ITERATIONS_V2;

  if (isPreDerivedKey) {
    if (!Buffer.isBuffer(passphraseOrKey) || passphraseOrKey.length !== KEY_LEN) {
      throw new Error("Pre-derived master key must be a 32-byte Buffer.");
    }
    key = deriveSubKey(passphraseOrKey, "stream:archive");
    iterations = 0;
  } else {
    const passphrase = typeof passphraseOrKey === "string" ? passphraseOrKey : passphraseOrKey.toString("utf8");
    key = deriveKey(passphrase, salt, iterations);
  }

  const hasher = createHash("sha256");

  let headerWritten = false;
  let unencryptedBytes = 0;
  let chunkIndex = 0;
  let pendingBuffer = Buffer.alloc(0);

  const iterBuf = Buffer.alloc(4);
  iterBuf.writeUInt32BE(iterations, 0);

  const chunkSizeBuf = Buffer.alloc(4);
  chunkSizeBuf.writeUInt32BE(chunkSize, 0);

  const header = Buffer.concat([
    MAGIC_V3,
    Buffer.from([CIPHER_AES_256_GCM]),
    iterBuf,
    salt,
    baseIV,
    chunkSizeBuf,
  ]);

  function encodeChunk(plaintext: Buffer, payloadType: number): Buffer {
    const chunkIV = deriveChunkIV(baseIV, chunkIndex);
    const cipher = createCipheriv("aes-256-gcm", key, chunkIV);
    const aad = buildChunkAAD(MAGIC_V3, salt, iterations, chunkSize, chunkIndex, payloadType);
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const frameHeader = Buffer.alloc(9);
    frameHeader.writeUInt32BE(chunkIndex, 0);
    frameHeader.writeUInt8(payloadType, 4);
    frameHeader.writeUInt32BE(ciphertext.length, 5);

    chunkIndex++;
    return Buffer.concat([frameHeader, ciphertext, authTag]);
  }

  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      unencryptedBytes += chunk.length;
      hasher.update(chunk);

      if (!headerWritten) {
        headerWritten = true;
        this.push(header);
      }

      pendingBuffer = Buffer.concat([pendingBuffer, chunk]);

      while (pendingBuffer.length >= chunkSize) {
        const slice = pendingBuffer.subarray(0, chunkSize);
        pendingBuffer = pendingBuffer.subarray(chunkSize);
        const frame = encodeChunk(slice, PAYLOAD_TYPE_INTERMEDIATE);
        this.push(frame);
      }

      callback();
    },
    flush(callback) {
      if (!headerWritten) {
        headerWritten = true;
        this.push(header);
      }

      // Always emit final frame with PAYLOAD_TYPE_FINAL
      const finalFrame = encodeChunk(pendingBuffer, PAYLOAD_TYPE_FINAL);
      this.push(finalFrame);
      pendingBuffer = Buffer.alloc(0);
      callback();
    },
  });

  let cachedDigest: string | null = null;

  return {
    transform,
    getStats: () => {
      if (!cachedDigest) {
        cachedDigest = hasher.digest("hex");
      }
      return {
        unencryptedBytes,
        sha256: cachedDigest,
      };
    },
  };
}

/**
 * Streaming Decryption Transform:
 * For V3 archives: Parses chunk frames and authenticates each chunk's AES-256-GCM auth tag
 * BEFORE releasing its plaintext to the downstream consumer (e.g. pg_restore).
 * For V1/V2 archives: Backwards-compatible sliding-tag decryption.
 * Throws immediately on corruption, missing/reordered chunks, or truncation.
 */
export function createDecryptionTransform(
  passphraseOrKey: string | Buffer,
  isPreDerivedKey: boolean = false
): Transform {
  let headerParsed = false;
  let headerBuf = Buffer.alloc(0);
  let version: 1 | 2 | 3 = 3;
  let key: Buffer | null = null;
  let salt: Buffer | null = null;
  let baseIV: Buffer | null = null;
  let iterations = 0;
  let chunkSize = DEFAULT_CHUNK_SIZE;

  // V1/V2 state
  let legacyDecipher: import("node:crypto").DecipherGCM | null = null;
  let legacyTail = Buffer.alloc(0);

  // V3 state
  let v3FrameBuf = Buffer.alloc(0);
  let expectedChunkIndex = 0;
  let seenFinalChunk = false;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!headerParsed) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        if (headerBuf.length < MAGIC_LEN) {
          return callback(); // Need at least magic length
        }

        const magic = headerBuf.subarray(0, MAGIC_LEN);
        const isV3 = magic.equals(MAGIC_V3);
        const isV2 = magic.equals(MAGIC_V2);
        const requiredHeaderLen = isV3 ? HEADER_LEN_V3 : isV2 ? HEADER_LEN_V2 : HEADER_LEN_V1;

        if (headerBuf.length < requiredHeaderLen) {
          return callback();
        }

        try {
          const headerInfo = parseWireHeader(headerBuf.subarray(0, requiredHeaderLen));
          version = headerInfo.version;
          salt = headerInfo.salt;
          baseIV = headerInfo.iv;
          iterations = headerInfo.iterations;
          if (version === 3) {
            chunkSize = headerInfo.chunkSize!;
          }

          if (isPreDerivedKey) {
            key = version === 3 ? deriveSubKey(passphraseOrKey as Buffer, "stream:archive") : (passphraseOrKey as Buffer);
          } else {
            const passphrase =
              typeof passphraseOrKey === "string" ? passphraseOrKey : passphraseOrKey.toString("utf8");
            key = deriveKey(passphrase, salt, iterations);
          }

          if (version < 3) {
            legacyDecipher = createDecipheriv("aes-256-gcm", key, baseIV);
          }

          const remainder = headerBuf.subarray(requiredHeaderLen);
          headerParsed = true;
          chunk = remainder;
        } catch (err) {
          return callback(err as Error);
        }
      }

      if (chunk.length === 0) return callback();

      if (version === 3) {
        v3FrameBuf = Buffer.concat([v3FrameBuf, chunk]);

        // Process all complete V3 frames
        while (v3FrameBuf.length >= 9) {
          const chunkIdx = v3FrameBuf.readUInt32BE(0);
          const payloadType = v3FrameBuf.readUInt8(4);
          const cipherLen = v3FrameBuf.readUInt32BE(5);

          if (seenFinalChunk) {
            return callback(
              new Error(`Extraneous frame encountered after final chunk at index ${chunkIdx}.`)
            );
          }

          if (payloadType !== PAYLOAD_TYPE_INTERMEDIATE && payloadType !== PAYLOAD_TYPE_FINAL) {
            return callback(new Error(`Invalid chunk payload type: 0x${payloadType.toString(16)}`));
          }

          if (chunkIdx !== expectedChunkIndex) {
            return callback(
              new Error(
                `Framing error: expected chunk index ${expectedChunkIndex}, got ${chunkIdx} (reordered or missing chunk).`
              )
            );
          }

          if (cipherLen > chunkSize || cipherLen > MAX_CHUNK_SIZE) {
            return callback(
              new Error(
                `Oversized frame: frame ${chunkIdx} ciphertext length ${cipherLen} exceeds chunk size limit ${chunkSize}.`
              )
            );
          }

          if (payloadType === PAYLOAD_TYPE_INTERMEDIATE && cipherLen !== chunkSize) {
            return callback(
              new Error(
                `Invalid frame length: intermediate frame ${chunkIdx} has length ${cipherLen}, expected exactly ${chunkSize}.`
              )
            );
          }

          const totalFrameLen = 9 + cipherLen + TAG_LEN;
          if (v3FrameBuf.length < totalFrameLen) {
            // Wait for more data to complete this frame
            break;
          }

          const ciphertext = v3FrameBuf.subarray(9, 9 + cipherLen);
          const authTag = v3FrameBuf.subarray(9 + cipherLen, totalFrameLen);
          v3FrameBuf = v3FrameBuf.subarray(totalFrameLen);

          try {
            const chunkIV = deriveChunkIV(baseIV!, chunkIdx);
            const decipher = createDecipheriv("aes-256-gcm", key!, chunkIV);
            const aad = buildChunkAAD(MAGIC_V3, salt!, iterations, chunkSize, chunkIdx, payloadType);
            decipher.setAAD(aad);
            decipher.setAuthTag(authTag);

            // Authentication verification must succeed before releasing any plaintext!
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

            if (plaintext.length > 0) {
              this.push(plaintext);
            }

            expectedChunkIndex++;
            if (payloadType === PAYLOAD_TYPE_FINAL) {
              seenFinalChunk = true;
            }
          } catch (err) {
            return callback(
              new Error(`Cryptographic authentication failed on chunk ${chunkIdx}: ${(err as Error).message}`)
            );
          }
        }

        callback();
      } else {
        // Legacy V1 / V2 sliding 16-byte tail buffer logic
        const combined = Buffer.concat([legacyTail, chunk]);
        if (combined.length > TAG_LEN) {
          const toDecrypt = combined.subarray(0, combined.length - TAG_LEN);
          legacyTail = combined.subarray(combined.length - TAG_LEN);
          try {
            const out = legacyDecipher!.update(toDecrypt);
            if (out.length > 0) {
              this.push(out);
            }
            callback();
          } catch (err) {
            callback(err as Error);
          }
        } else {
          legacyTail = combined;
          callback();
        }
      }
    },
    flush(callback) {
      if (!headerParsed) {
        return callback(new Error("Truncated archive: file ends before header was parsed."));
      }

      if (version === 3) {
        if (!seenFinalChunk) {
          return callback(new Error("Truncated archive: stream ended before final chunk was received."));
        }
        if (v3FrameBuf.length > 0) {
          return callback(
            new Error(`Extraneous unauthenticated bytes (${v3FrameBuf.length} bytes) at end of archive.`)
          );
        }
        callback();
      } else {
        if (legacyTail.length !== TAG_LEN) {
          return callback(
            new Error(`Truncated archive: expected ${TAG_LEN}-byte GCM auth tag, found ${legacyTail.length} bytes.`)
          );
        }

        try {
          legacyDecipher!.setAuthTag(legacyTail);
          const finalChunk = legacyDecipher!.final();
          if (finalChunk.length > 0) {
            this.push(finalChunk);
          }
          callback();
        } catch (err) {
          callback(new Error(`Cryptographic authentication failed: ${(err as Error).message}`));
        }
      }
    },
  });
}

/**
 * Pre-Flight Cryptographic Verification (Dry Sink):
 * Pipes the encrypted stream through createDecryptionTransform into a null sink.
 * Validates 100% of the archive and GCM auth tag in constant RAM without writing plaintext.
 */
export async function verifyEncryptedStream(
  inputStream: NodeJS.ReadableStream,
  passphraseOrKey: string | Buffer,
  isPreDerivedKey: boolean = false
): Promise<{ unencryptedBytes: number; sha256: string }> {
  const decTransform = createDecryptionTransform(passphraseOrKey, isPreDerivedKey);
  const hasher = createHash("sha256");
  let unencryptedBytes = 0;

  const discardSink = new Writable({
    write(chunk: Buffer, _enc, callback) {
      unencryptedBytes += chunk.length;
      hasher.update(chunk);
      callback();
    },
  });

  await pipeline(inputStream, decTransform, discardSink);

  return {
    unencryptedBytes,
    sha256: hasher.digest("hex"),
  };
}

export const MANIFEST_SIGNING_CONTEXT = "yourai:manifest:signature:v1";

/**
 * Derives a dedicated, domain-separated 256-bit HMAC signing sub-key from a Master Key.
 * Prevents key-reuse across symmetric AES-GCM encryption and HMAC-SHA256 signatures (RFC 5869 / NIST SP 800-108).
 */
export function deriveManifestSigningKey(masterKey: Buffer): Buffer {
  return deriveSubKey(masterKey, MANIFEST_SIGNING_CONTEXT);
}

/**
 * Manifest Integrity Authentication:
 * Signs manifest JSON string using HMAC-SHA256 with a dedicated signing key.
 */
export function signManifest(manifestContent: string, signingKey: Buffer): string {
  if (!Buffer.isBuffer(signingKey) || signingKey.length !== KEY_LEN) {
    throw new Error(`Manifest signing key must be a ${KEY_LEN}-byte Buffer.`);
  }
  return createHmac("sha256", signingKey).update(manifestContent).digest("hex");
}

/**
 * Verifies manifest signature with constant-time equality check.
 */
export function verifyManifestSignature(
  manifestContent: string,
  signatureHex: string,
  signingKey: Buffer
): boolean {
  if (!signatureHex || typeof signatureHex !== "string" || signatureHex.length !== 64) {
    return false;
  }
  if (!Buffer.isBuffer(signingKey) || signingKey.length !== KEY_LEN) {
    return false;
  }
  const expected = signManifest(manifestContent, signingKey);
  const sigBuf = Buffer.from(signatureHex, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}
