import crypto from "node:crypto";

/**
 * Retrieves the server-side secret used to sign and verify webhook correlation tokens.
 * Precedence:
 *   1. WEBHOOK_CORRELATION_SECRET
 *   2. AUTH_SECRET (guaranteed min 16 characters in production)
 *   3. In non-production only, a secure fallback for offline tests.
 */
export function getWebhookCorrelationSecret(): string {
  const secret = process.env.WEBHOOK_CORRELATION_SECRET || process.env.AUTH_SECRET;
  if (!secret || secret.trim() === "") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[video-correlation] WEBHOOK_CORRELATION_SECRET or AUTH_SECRET is required in production.",
      );
    }
    return "dev-video-webhook-correlation-secret-key-32-chars-long";
  }
  return secret.trim();
}

export interface GenerateCorrelationTokenParams {
  jobId: string;
  provider: string;
  submissionAttempt: string;
  secret?: string;
}

export interface VerifyCorrelationTokenParams {
  token: string;
  jobId: string;
  provider: string;
  submissionAttempt?: string;
  secret?: string;
}

/**
 * Generates a cryptographically unpredictable, tamper-proof correlation token
 * bound to a specific GenerationJob ID, provider identity, and unique submission attempt.
 *
 * Token format: `${base64url(submissionAttempt)}.${hex(nonce16)}.${hex(hmacSha256)}`
 *
 * Security Properties:
 *   - 128-bit (16-byte) cryptographically secure random nonce prevents guessing.
 *   - HMAC-SHA256 bound to `${jobId}:${provider}:${submissionAttempt}:${nonce}`.
 *   - URL-safe encoding suitable for query parameters.
 *   - Prevents token substitution between jobs, across providers, or across submission attempts.
 */
export function generateWebhookCorrelationToken(
  params: {
    jobId: string;
    provider: string;
    submissionAttempt: string;
    secret?: string;
  },
): string {
  const { jobId, provider, submissionAttempt } = params;
  if (!jobId || !provider || !submissionAttempt) {
    throw new Error(
      "[video-correlation] jobId, provider, and submissionAttempt are mandatory for token generation.",
    );
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const encodedAttempt = Buffer.from(submissionAttempt, "utf-8").toString("base64url");
  const secret = params.secret ?? getWebhookCorrelationSecret();

  const data = `${jobId}:${provider}:${submissionAttempt}:${nonce}`;
  const hmac = crypto.createHmac("sha256", secret).update(data).digest("hex");

  return `${encodedAttempt}.${nonce}.${hmac}`;
}

/**
 * Extracts the embedded submission attempt identifier from a correlation token.
 * Returns null if the token format is invalid.
 */
export function extractSubmissionAttemptFromCorrelationToken(
  token: string,
): string | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const attempt = Buffer.from(parts[0], "base64url").toString("utf-8");
    return attempt.length > 0 ? attempt : null;
  } catch {
    return null;
  }
}

/**
 * Validates a correlation token against the given GenerationJob ID, provider,
 * and optional submission attempt.
 *
 * Returns true ONLY if:
 *   1. Token format is valid: 3 parts (attempt, 32-char hex nonce, 64-char hex HMAC).
 *   2. Extracted submission attempt matches params.submissionAttempt (if specified).
 *   3. HMAC matches the computed signature over `${jobId}:${provider}:${attempt}:${nonce}`
 *      using constant-time comparison (crypto.timingSafeEqual).
 */
export function verifyWebhookCorrelationToken(
  params: {
    token: string;
    jobId: string;
    provider: string;
    submissionAttempt?: string;
    secret?: string;
  },
): boolean {
  const { token, jobId, provider, submissionAttempt } = params;
  if (!token || typeof token !== "string") return false;
  if (!jobId || typeof jobId !== "string") return false;
  if (!provider || typeof provider !== "string") return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [encodedAttempt, nonce, providedHmac] = parts;
  if (!encodedAttempt || !nonce || !providedHmac) return false;
  if (nonce.length !== 32 || providedHmac.length !== 64) return false;

  let extractedAttempt: string;
  try {
    extractedAttempt = Buffer.from(encodedAttempt, "base64url").toString("utf-8");
    if (!extractedAttempt) return false;
  } catch {
    return false;
  }

  // If caller specified an expected submissionAttempt, enforce exact match
  if (submissionAttempt && extractedAttempt !== submissionAttempt) {
    return false;
  }

  const secret = params.secret ?? getWebhookCorrelationSecret();
  const data = `${jobId}:${provider}:${extractedAttempt}:${nonce}`;
  const expectedHmac = crypto.createHmac("sha256", secret).update(data).digest("hex");

  try {
    const expectedBuf = Buffer.from(expectedHmac, "hex");
    const providedBuf = Buffer.from(providedHmac, "hex");
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

