export type AccountingErrorCode =
  | "INVALID_INPUT"
  | "USER_NOT_FOUND"
  | "INSUFFICIENT_CREDITS"
  | "DAILY_LIMIT_REACHED"
  | "ACTIVE_JOB_EXISTS"
  | "CAPACITY_EXHAUSTED"
  | "IDEMPOTENCY_CONFLICT";

const MESSAGES: Record<AccountingErrorCode, string> = {
  INVALID_INPUT: "The request is invalid.",
  USER_NOT_FOUND: "Account not found.",
  INSUFFICIENT_CREDITS: "You don't have enough credits for this generation.",
  DAILY_LIMIT_REACHED: "You've reached today's image limit. It resets at 00:00 UTC.",
  ACTIVE_JOB_EXISTS: "You already have a generation in progress. Please wait for it to finish.",
  CAPACITY_EXHAUSTED: "Today's generation capacity is used up. It resets at 00:00 UTC.",
  IDEMPOTENCY_CONFLICT: "This request key was already used for a different request.",
};

/**
 * The generation service is not usable (e.g. provider or storage not configured).
 * Raised BEFORE any job is created, so nothing is debited or reserved.
 */
export class GenerationUnavailableError extends Error {
  constructor(message = "Image generation is temporarily unavailable.") {
    super(message);
    this.name = "GenerationUnavailableError";
  }
}

/** Expected, user-facing accounting outcomes. Safe to show `message` to the user. */
export class AccountingError extends Error {
  constructor(
    public readonly code: AccountingErrorCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = "AccountingError";
  }
}
