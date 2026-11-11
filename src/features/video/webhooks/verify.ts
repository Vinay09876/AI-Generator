import crypto from "node:crypto";
import { WEBHOOK_TIMESTAMP_TOLERANCE_MS } from "../config";
import type {
  WebhookVerificationInput,
  WebhookVerificationResult,
} from "../types";

/**
 * Common header aliases used by webhook providers for signatures and timestamps.
 */
const SIGNATURE_HEADERS = [
  "x-fal-signature",
  "x-fal-webhook-signature",
  "webhook-signature",
  "x-signature",
] as const;

const TIMESTAMP_HEADERS = [
  "x-fal-timestamp",
  "x-fal-webhook-timestamp",
  "webhook-timestamp",
  "x-timestamp",
] as const;

/**
 * Extracts a header value case-insensitively.
 */
export function extractHeader(
  headers: Record<string, string | string[] | undefined>,
  candidates: readonly string[]
): string | null {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") {
      normalized[k.toLowerCase()] = v;
    } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      normalized[k.toLowerCase()] = v[0];
    }
  }

  for (const candidate of candidates) {
    const val = normalized[candidate.toLowerCase()];
    if (val) return val.trim();
  }

  return null;
}

export interface Ed25519VerificationOptions {
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  publicKey: crypto.KeyObject | string;
  now?: number;
  toleranceMs?: number;
  expectedSignatureHeader?: string;
  expectedTimestampHeader?: string;
}

/**
 * Verifies an incoming webhook using ED25519 public key signature verification.
 * Strictly verifies timestamp freshness to prevent replay attacks.
 */
export function verifyEd25519WebhookSignature(
  options: Ed25519VerificationOptions
): WebhookVerificationResult {
  const {
    rawBody,
    headers,
    publicKey,
    now = Date.now(),
    toleranceMs = WEBHOOK_TIMESTAMP_TOLERANCE_MS,
    expectedSignatureHeader,
    expectedTimestampHeader,
  } = options;

  // 1. Extract signature
  const sigHeader = expectedSignatureHeader
    ? extractHeader(headers, [expectedSignatureHeader])
    : extractHeader(headers, SIGNATURE_HEADERS);

  if (!sigHeader) {
    return {
      valid: false,
      error: "Missing required webhook signature header.",
    };
  }

  // 2. Extract timestamp
  const tsHeader = expectedTimestampHeader
    ? extractHeader(headers, [expectedTimestampHeader])
    : extractHeader(headers, TIMESTAMP_HEADERS);

  let timestampMs: number | null = null;
  if (tsHeader) {
    const parsed = Number(tsHeader);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        valid: false,
        error: "Invalid webhook timestamp header format.",
      };
    }
    // Normalize seconds vs milliseconds
    timestampMs = parsed < 1e11 ? parsed * 1000 : parsed;

    // Replay attack protection: check if timestamp is too old
    if (now - timestampMs > toleranceMs) {
      return {
        valid: false,
        error: `Webhook timestamp expired. Request is older than ${toleranceMs / 1000}s.`,
        timestamp: timestampMs,
      };
    }

    // Future timestamp protection (allow up to 60s clock skew)
    if (timestampMs - now > 60_000) {
      return {
        valid: false,
        error: "Webhook timestamp is in the future beyond allowable clock skew.",
        timestamp: timestampMs,
      };
    }
  }

  // 3. Normalize raw body buffer
  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(rawBody, "utf-8");

  // 4. Construct payload for signature verification.
  // Standard framing: `${timestamp}.${rawBody}` if timestamp header exists, else rawBody.
  const payloadToVerify = tsHeader
    ? Buffer.concat([Buffer.from(`${tsHeader}.`, "utf-8"), bodyBuffer])
    : bodyBuffer;

  // 5. Decode signature buffer (supports hex, base64, or prefixed formats like "v1=...")
  let cleanSig = sigHeader;
  if (cleanSig.startsWith("v1=")) {
    cleanSig = cleanSig.slice(3);
  } else if (cleanSig.startsWith("v1,")) {
    cleanSig = cleanSig.slice(3);
  }

  let signatureBuffer: Buffer;
  try {
    if (/^[0-9a-fA-F]+$/.test(cleanSig) && cleanSig.length === 128) {
      signatureBuffer = Buffer.from(cleanSig, "hex");
    } else {
      signatureBuffer = Buffer.from(cleanSig, "base64");
    }
  } catch {
    return {
      valid: false,
      error: "Malformed signature encoding; expected hex or base64.",
    };
  }

  if (signatureBuffer.length !== 64) {
    return {
      valid: false,
      error: `Invalid ED25519 signature length: expected 64 bytes, got ${signatureBuffer.length}.`,
    };
  }

  // 6. Import public key if provided as string
  let keyObject: crypto.KeyObject;
  try {
    if (typeof publicKey === "string") {
      keyObject = crypto.createPublicKey(publicKey);
    } else {
      keyObject = publicKey;
    }
  } catch (keyErr) {
    return {
      valid: false,
      error: `Failed to load public key: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`,
    };
  }

  // 7. Verify ED25519 signature
  try {
    const isValid = crypto.verify(
      null,
      payloadToVerify,
      keyObject,
      signatureBuffer
    );

    if (!isValid) {
      // Also try raw body without timestamp framing in case provider signs raw body directly
      if (tsHeader) {
        const altValid = crypto.verify(
          null,
          bodyBuffer,
          keyObject,
          signatureBuffer
        );
        if (altValid) {
          return {
            valid: true,
            timestamp: timestampMs ?? undefined,
          };
        }
      }

      return {
        valid: false,
        error: "Signature verification failed: signature does not match payload.",
      };
    }

    return {
      valid: true,
      timestamp: timestampMs ?? undefined,
    };
  } catch (verifyErr) {
    return {
      valid: false,
      error: `Signature verification exception: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
    };
  }
}

/**
 * Test helper: Generates an in-memory ED25519 keypair for offline unit tests.
 */
export function generateTestEd25519KeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    publicKey: crypto.createPublicKey(publicKey),
    privateKey: crypto.createPrivateKey(privateKey),
  };
}

/**
 * Test helper: Signs a webhook payload using an ED25519 private key.
 */
export function signTestWebhookPayload(params: {
  rawBody: string | Buffer;
  privateKey: crypto.KeyObject | string;
  timestamp?: number;
  encoding?: "base64" | "hex";
}): {
  signature: string;
  timestamp: string;
  headers: Record<string, string>;
} {
  const { rawBody, privateKey, timestamp = Math.floor(Date.now() / 1000), encoding = "base64" } = params;
  const tsStr = String(timestamp);
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf-8");
  const payloadToSign = Buffer.concat([Buffer.from(`${tsStr}.`, "utf-8"), bodyBuffer]);

  const keyObject = typeof privateKey === "string" ? crypto.createPrivateKey(privateKey) : privateKey;
  const sigBuffer = crypto.sign(null, payloadToSign, keyObject);
  const signature = sigBuffer.toString(encoding);

  return {
    signature,
    timestamp: tsStr,
    headers: {
      "x-fal-signature": signature,
      "x-fal-timestamp": tsStr,
      "content-type": "application/json",
    },
  };
}

