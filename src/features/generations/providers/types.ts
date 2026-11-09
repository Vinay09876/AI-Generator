/**
 * Provider-independent image generation contract. Provider-specific response shapes
 * never leave the adapter; the rest of the app only sees these types.
 */

export type ImageGenerationRequest = {
  prompt: string;
  steps: number;
  /** Optional caller cancellation (e.g. request aborted). The adapter adds its own timeout. */
  signal?: AbortSignal;
};

/**
 * Actual provider usage. `centiNeurons` is null when the provider did not report a usable
 * value; callers MUST then charge the reserved amount (conservative), never zero.
 */
export type ProviderUsage = {
  centiNeurons: number | null;
  source: "header" | "missing" | "invalid";
};

export type ProviderResult = {
  /** Raw image bytes as returned by the provider (not yet validated as an image). */
  bytes: Buffer;
  usage: ProviderUsage;
  provider: string;
  model: string;
  providerRequestId: string | null;
  latencyMs: number;
};

/**
 * Whether the provider may have executed (and consumed capacity):
 *  - not_run: non-execution is established (request rejected before inference, or never sent)
 *  - ran:     the provider executed (HTTP 200, or usage was reported) but the result is unusable
 *  - unknown: cannot tell (timeouts, resets, 5xx, unexpected statuses) — settle conservatively later
 */
export type ProviderOutcome = "not_run" | "ran" | "unknown";

export type ProviderErrorCode =
  | "INVALID_REQUEST"
  | "AUTH"
  | "MODEL_NOT_FOUND"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "TIMEOUT"
  | "CANCELLED"
  | "NETWORK"
  | "UPSTREAM"
  | "MALFORMED_RESPONSE"
  | "CONFIG";

/**
 * Safe-to-log provider failure. Never contains credentials, prompts or image data.
 * `usage` is set when the provider reported usage even though the call failed.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly outcome: ProviderOutcome;
  readonly httpStatus: number | null;
  readonly providerCode: number | null;
  readonly providerRequestId: string | null;
  readonly usage: ProviderUsage | null;

  constructor(params: {
    code: ProviderErrorCode;
    outcome: ProviderOutcome;
    message: string;
    httpStatus?: number | null;
    providerCode?: number | null;
    providerRequestId?: string | null;
    usage?: ProviderUsage | null;
  }) {
    super(params.message);
    this.name = "ProviderError";
    this.code = params.code;
    this.outcome = params.outcome;
    this.httpStatus = params.httpStatus ?? null;
    this.providerCode = params.providerCode ?? null;
    this.providerRequestId = params.providerRequestId ?? null;
    this.usage = params.usage ?? null;
  }

  /** Structured, secret-free representation for logs. */
  toLog() {
    return {
      code: this.code,
      outcome: this.outcome,
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      providerRequestId: this.providerRequestId,
      message: this.message,
    };
  }
}

export interface ImageProvider {
  readonly id: string;
  readonly model: string;
  generate(request: ImageGenerationRequest): Promise<ProviderResult>;
}
