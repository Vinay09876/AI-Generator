import crypto from "node:crypto";
import { WEBHOOK_TIMESTAMP_TOLERANCE_MS } from "../config";
import { extractHeader } from "./verify";

export interface FalJwkKey {
  kty: string;
  crv: string;
  x: string; // base64url encoded 32-byte Ed25519 public key
  kid?: string;
}

export interface VerifyFalWebhookOptions {
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  keys?: FalJwkKey[] | crypto.KeyObject[];
  now?: number;
  toleranceMs?: number;
}

export interface FalWebhookVerificationResult {
  valid: boolean;
  error?: string;
  requestId?: string;
  userId?: string;
  timestamp?: number;
}

// In-memory cache for published Fal.ai JWKS keys
let jwksCache: { keys: FalJwkKey[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (per official Fal docs)

export const FAL_JWKS_URL = "https://rest.fal.ai/.well-known/jwks.json";

// Standard ASN.1 DER SPKI prefix for an Ed25519 public key (RFC 8410)
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Converts a base64url-encoded Ed25519 public key coordinate 'x' from a JWK
 * into a Node.js crypto KeyObject.
 */
export function convertJwkToEd25519KeyObject(jwk: FalJwkKey): crypto.KeyObject {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error(`Unsupported JWK key type: kty=${jwk.kty}, crv=${jwk.crv}`);
  }

  const rawBytes = Buffer.from(jwk.x, "base64url");
  if (rawBytes.length !== 32) {
    throw new Error(`Invalid Ed25519 public key length: expected 32 bytes, got ${rawBytes.length}`);
  }

  const spkiDer = Buffer.concat([ED25519_DER_PREFIX, rawBytes]);
  return crypto.createPublicKey({
    key: spkiDer,
    format: "der",
    type: "spki",
  });
}

/**
 * Generates an Ed25519 keypair and constructs a corresponding Fal-compatible JWK
 * for deterministic offline unit testing.
 */
export function generateFalTestKeypair(): {
  publicKeyJwk: FalJwkKey;
  keyObject: crypto.KeyObject;
  privateKeyObject: crypto.KeyObject;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "jwk" });

  const jwk: FalJwkKey = {
    kty: "OKP",
    crv: "Ed25519",
    x: exported.x as string,
  };

  return {
    publicKeyJwk: jwk,
    keyObject: publicKey,
    privateKeyObject: privateKey,
  };
}

/**
 * Creates an authentic Fal.ai Ed25519 webhook signature for testing.
 */
export function signFalWebhookPayload(params: {
  privateKey: crypto.KeyObject;
  requestId: string;
  userId: string;
  timestampSeconds: number;
  rawBody: string | Buffer;
}): { signatureHex: string; timestampStr: string } {
  const { privateKey, requestId, userId, timestampSeconds, rawBody } = params;

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf-8");
  const bodySha256Hex = crypto.createHash("sha256").update(bodyBuffer).digest("hex");

  const messageStr = `${requestId}\n${userId}\n${timestampSeconds}\n${bodySha256Hex}`;
  const messageBytes = Buffer.from(messageStr, "utf-8");

  const sigBuffer = crypto.sign(null, messageBytes, privateKey);
  return {
    signatureHex: sigBuffer.toString("hex"),
    timestampStr: String(timestampSeconds),
  };
}

/**
 * Verifies an incoming webhook request from Fal.ai according to official specifications:
 *   1. Extracts X-Fal-Webhook-Request-Id, X-Fal-Webhook-User-Id, X-Fal-Webhook-Timestamp, X-Fal-Webhook-Signature.
 *   2. Validates timestamp freshness (within +/- 300 seconds) against replay attacks.
 *   3. Computes hex-encoded SHA-256 hash of the unparsed raw request body.
 *   4. Reconstructs message: `${requestId}\n${userId}\n${timestamp}\n${bodyHash}`.
 *   5. Verifies Ed25519 signature against published Fal.ai public JWKS keys.
 */
export async function verifyFalWebhookSignature(
  options: VerifyFalWebhookOptions,
): Promise<FalWebhookVerificationResult> {
  const {
    rawBody,
    headers,
    now = Date.now(),
    toleranceMs = WEBHOOK_TIMESTAMP_TOLERANCE_MS,
  } = options;

  // 1. Extract required headers
  const requestId = extractHeader(headers, [
    "x-fal-webhook-request-id",
    "x-fal-request-id",
  ]);
  const userId = extractHeader(headers, [
    "x-fal-webhook-user-id",
    "x-fal-user-id",
  ]);
  const timestampHeader = extractHeader(headers, [
    "x-fal-webhook-timestamp",
    "x-fal-timestamp",
  ]);
  const signatureHex = extractHeader(headers, [
    "x-fal-webhook-signature",
    "x-fal-signature",
  ]);

  if (!requestId) {
    return { valid: false, error: "Missing required X-Fal-Webhook-Request-Id header." };
  }
  if (!userId) {
    return { valid: false, error: "Missing required X-Fal-Webhook-User-Id header." };
  }
  if (!timestampHeader) {
    return { valid: false, error: "Missing required X-Fal-Webhook-Timestamp header." };
  }
  if (!signatureHex) {
    return { valid: false, error: "Missing required X-Fal-Webhook-Signature header." };
  }

  // 2. Validate timestamp freshness & replay window
  const timestampNum = Number(timestampHeader);
  if (!Number.isFinite(timestampNum) || timestampNum <= 0) {
    return { valid: false, error: "Invalid timestamp header format." };
  }

  // Fal.ai sends Unix epoch in seconds
  const timestampMs = timestampNum < 1e11 ? timestampNum * 1000 : timestampNum;

  if (now - timestampMs > toleranceMs) {
    return {
      valid: false,
      error: `Webhook timestamp expired. Request is older than ${toleranceMs / 1000}s.`,
      timestamp: timestampMs,
    };
  }

  if (timestampMs - now > 60_000) {
    return {
      valid: false,
      error: "Webhook timestamp is in the future beyond allowable clock skew.",
      timestamp: timestampMs,
    };
  }

  // 3. Compute SHA-256 of raw unparsed request body
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf-8");
  const bodyHashHex = crypto.createHash("sha256").update(bodyBuffer).digest("hex");

  // 4. Reconstruct signed message
  const timestampNormalizedStr = String(Math.floor(timestampMs / 1000));
  const messageStr = `${requestId}\n${userId}\n${timestampNormalizedStr}\n${bodyHashHex}`;
  const messageBytes = Buffer.from(messageStr, "utf-8");

  // 5. Decode signature from hex
  let signatureBuffer: Buffer;
  try {
    const cleanHex = signatureHex.replace(/^v\d+=/, "").trim();
    signatureBuffer = Buffer.from(cleanHex, "hex");
    if (signatureBuffer.length !== 64) {
      return {
        valid: false,
        error: `Invalid Ed25519 signature length: expected 64 bytes, got ${signatureBuffer.length}`,
      };
    }
  } catch {
    return { valid: false, error: "Malformed signature format: expected hex encoding." };
  }

  // 6. Resolve public verification keys
  let publicKeys: crypto.KeyObject[] = [];

  if (options.keys && options.keys.length > 0) {
    for (const k of options.keys) {
      if (k instanceof crypto.KeyObject) {
        publicKeys.push(k);
      } else {
        try {
          publicKeys.push(convertJwkToEd25519KeyObject(k));
        } catch (e) {
          // ignore malformed test key
        }
      }
    }
  } else {
    // Check in-memory cache
    if (jwksCache && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
      publicKeys = jwksCache.keys.map(convertJwkToEd25519KeyObject);
    } else {
      // In production, fetch published JWKS with caching
      try {
        const res = await fetch(FAL_JWKS_URL, { headers: { Accept: "application/json" } });
        if (!res.ok) {
          return { valid: false, error: `Failed to fetch Fal.ai JWKS: HTTP ${res.status}` };
        }
        const data = (await res.json()) as { keys?: FalJwkKey[] };
        if (Array.isArray(data.keys)) {
          jwksCache = { keys: data.keys, fetchedAt: now };
          publicKeys = data.keys.map(convertJwkToEd25519KeyObject);
        }
      } catch (err) {
        return { valid: false, error: `Failed to retrieve Fal.ai JWKS: ${(err as Error).message}` };
      }
    }
  }

  if (publicKeys.length === 0) {
    return { valid: false, error: "No public verification keys available." };
  }

  // 7. Verify signature against available keys
  for (const key of publicKeys) {
    try {
      const isValid = crypto.verify(null, messageBytes, key, signatureBuffer);
      if (isValid) {
        return {
          valid: true,
          requestId,
          userId,
          timestamp: timestampMs,
        };
      }
    } catch {
      // continue to next key
    }
  }

  return {
    valid: false,
    error: "Cryptographic signature verification failed.",
    requestId,
    userId,
    timestamp: timestampMs,
  };
}

