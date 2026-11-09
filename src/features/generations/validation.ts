import { PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH, isImageQuality } from "./config";
import { AccountingError } from "./errors";

/**
 * Pure request validation (no database access), shared by the job lifecycle and the HTTP
 * layer. Validation happens before any transaction, so invalid input never debits or reserves.
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export const isValidIdempotencyKey = (value: unknown): value is string =>
  typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);

export function validateImageRequest(input: { prompt: unknown; quality: unknown; idempotencyKey: unknown }) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length < PROMPT_MIN_LENGTH || prompt.length > PROMPT_MAX_LENGTH) {
    throw new AccountingError("INVALID_INPUT", `Prompt must be ${PROMPT_MIN_LENGTH}-${PROMPT_MAX_LENGTH} characters.`);
  }
  if (!isImageQuality(input.quality)) throw new AccountingError("INVALID_INPUT", "Unknown quality option.");
  if (!isValidIdempotencyKey(input.idempotencyKey)) {
    throw new AccountingError("INVALID_INPUT", "Invalid request key.");
  }
  return { prompt, quality: input.quality, idempotencyKey: input.idempotencyKey };
}
