import {
  IMAGE_QUALITIES,
  MAX_PROVIDER_IMAGE_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES,
  PROMPT_MAX_LENGTH,
  PROMPT_MIN_LENGTH,
  PROVIDER_TIMEOUT_MS,
} from "../config";
import {
  ProviderError,
  type ImageGenerationRequest,
  type ImageProvider,
  type ProviderErrorCode,
  type ProviderOutcome,
  type ProviderResult,
  type ProviderUsage,
} from "./types";

/**
 * Cloudflare Workers AI adapter for FLUX.1 Schnell. All Cloudflare-specific details
 * (endpoint, auth, response envelope, error codes, usage header) stay in this file.
 *
 * Credentials are passed in by the server-only factory (providers/index.ts); this module
 * never reads environment variables and never logs secrets, prompts or image data.
 */

export const CLOUDFLARE_PROVIDER_ID = "cloudflare-workers-ai";

const ALLOWED_STEPS: ReadonlySet<number> = new Set(Object.values(IMAGE_QUALITIES).map((q) => q.steps));
const USAGE_HEADER = "cf-ai-neurons";
const REQUEST_ID_HEADER = "cf-ai-req-id";
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const NEURONS_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Cloudflare error codes that establish the request was rejected before inference. */
const CF_QUOTA_EXHAUSTED = 3036; // daily free allocation used up
const CF_INPUT_VALIDATION = 5006; // schema validation ("Bad input")

/** Network error codes that prove the request was never sent. Anything else is ambiguous. */
const NOT_SENT_NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_INVALID_ARG"]);

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type CloudflareProviderOptions = {
  accountId: string;
  apiToken: string;
  model: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
};

/** Parse "172.80" → 17280 centi-neurons. Missing/invalid/zero → null (charge the reservation). */
export function parseNeuronsHeader(value: string | null): ProviderUsage {
  if (value === null || value.trim() === "") return { centiNeurons: null, source: "missing" };
  const v = value.trim();
  if (!NEURONS_PATTERN.test(v)) return { centiNeurons: null, source: "invalid" };
  const [whole, frac = ""] = v.split(".");
  const centi = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  // A successful generation always costs something; zero or absurd values are not trusted.
  if (!Number.isSafeInteger(centi) || centi <= 0 || centi > 100_000_000) return { centiNeurons: null, source: "invalid" };
  return { centiNeurons: centi, source: "header" };
}

/** Strict base64 → bytes. Rejects whitespace, URL-safe alphabet, bad padding and empty input. */
export function decodeStrictBase64(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  if (!BASE64_PATTERN.test(value)) return null;
  if ((value.length / 4) * 3 > maxBytes + 2) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.length <= maxBytes ? bytes : null;
}

function networkErrorCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let e: unknown = error;
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** Map a non-2xx response. not_run only where non-execution is established. */
function classifyHttpError(status: number, providerCode: number | null): { code: ProviderErrorCode; outcome: ProviderOutcome } {
  if (status === 429) return { code: providerCode === CF_QUOTA_EXHAUSTED ? "QUOTA_EXHAUSTED" : "RATE_LIMITED", outcome: "not_run" };
  if (status === 401 || status === 403) return { code: "AUTH", outcome: "not_run" };
  // 404 ("Invalid model ID", code 3042): Cloudflare does not document whether it is billed
  // or rejected before inference, so it is treated as ambiguous.
  if (status === 404) return { code: "MODEL_NOT_FOUND", outcome: "unknown" };
  if (status === 400 && providerCode === CF_INPUT_VALIDATION) return { code: "INVALID_REQUEST", outcome: "not_run" };
  // Any other 4xx (including 400 without a recognised validation code) and all 5xx: ambiguous.
  return { code: "UPSTREAM", outcome: "unknown" };
}

function readEnvelopeError(text: string): { providerCode: number | null; message: string | null } {
  try {
    const json = JSON.parse(text) as { errors?: { code?: unknown; message?: unknown }[] };
    const first = Array.isArray(json.errors) ? json.errors[0] : undefined;
    const providerCode = typeof first?.code === "number" ? first.code : null;
    // Provider messages describe schema problems; keep them short and never include request data.
    const message = typeof first?.message === "string" ? first.message.slice(0, 160) : null;
    return { providerCode, message };
  } catch {
    return { providerCode: null, message: null };
  }
}

export function createCloudflareImageProvider(options: CloudflareProviderOptions): ImageProvider {
  const { accountId, apiToken, model } = options;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;

  return {
    id: CLOUDFLARE_PROVIDER_ID,
    model,

    async generate({ prompt, steps, signal }: ImageGenerationRequest): Promise<ProviderResult> {
      // Input checks before anything is sent: a rejection here is definitely not_run.
      if (typeof prompt !== "string" || prompt.length < PROMPT_MIN_LENGTH || prompt.length > PROMPT_MAX_LENGTH) {
        throw new ProviderError({ code: "INVALID_REQUEST", outcome: "not_run", message: "Prompt length is out of range." });
      }
      if (!ALLOWED_STEPS.has(steps)) {
        throw new ProviderError({ code: "INVALID_REQUEST", outcome: "not_run", message: "Unsupported step count." });
      }
      if (signal?.aborted) {
        throw new ProviderError({ code: "CANCELLED", outcome: "not_run", message: "Request was cancelled before sending." });
      }

      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const started = performance.now();

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
          // Only the parameters the model accepts. Never seed/width/height.
          body: JSON.stringify({ prompt, steps }),
          signal: combined,
        });
      } catch (error) {
        if (timeout.aborted) {
          throw new ProviderError({ code: "TIMEOUT", outcome: "unknown", message: `Provider did not respond within ${timeoutMs} ms.` });
        }
        if (signal?.aborted) {
          // Cancelled mid-flight: the request may already have reached the provider.
          throw new ProviderError({ code: "CANCELLED", outcome: "unknown", message: "Request was cancelled in flight." });
        }
        const netCode = networkErrorCode(error);
        const notSent = netCode !== null && NOT_SENT_NETWORK_CODES.has(netCode);
        throw new ProviderError({
          code: "NETWORK",
          outcome: notSent ? "not_run" : "unknown",
          message: `Network error${netCode ? ` (${netCode})` : ""}.`,
        });
      }

      const latencyMs = Math.round(performance.now() - started);
      const providerRequestId = response.headers.get(REQUEST_ID_HEADER);
      const usage = parseNeuronsHeader(response.headers.get(USAGE_HEADER));
      const declaredLength = Number(response.headers.get("content-length"));

      let text: string;
      try {
        if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("too large");
        text = await response.text();
        if (text.length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("too large");
      } catch (error) {
        if (!response.ok) {
          throw new ProviderError({ code: "UPSTREAM", outcome: "unknown", message: `HTTP ${response.status}; unreadable body.`, httpStatus: response.status, providerRequestId, usage });
        }
        const timedOut = timeout.aborted;
        throw new ProviderError({
          code: timedOut ? "TIMEOUT" : "MALFORMED_RESPONSE",
          outcome: "ran",
          message: timedOut ? "Timed out reading provider response." : `Unreadable provider response (${(error as Error).message}).`,
          httpStatus: response.status,
          providerRequestId,
          usage,
        });
      }

      if (!response.ok) {
        const { providerCode, message } = readEnvelopeError(text);
        const cls = classifyHttpError(response.status, providerCode);
        // If the provider reported usage, it executed, whatever the status says.
        const outcome: ProviderOutcome = usage.centiNeurons !== null ? "ran" : cls.outcome;
        throw new ProviderError({
          code: cls.code,
          outcome,
          message: `Provider returned HTTP ${response.status}${message ? `: ${message}` : ""}.`,
          httpStatus: response.status,
          providerCode,
          providerRequestId,
          usage: usage.centiNeurons !== null ? usage : null,
        });
      }

      // HTTP 200: inference ran. Any problem from here on is outcome "ran".
      let body: { success?: unknown; result?: { image?: unknown } } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (!body || typeof body !== "object") {
        throw new ProviderError({ code: "MALFORMED_RESPONSE", outcome: "ran", message: "Provider returned invalid JSON.", httpStatus: 200, providerRequestId, usage });
      }
      if (body.success !== true) {
        const { providerCode, message } = readEnvelopeError(text);
        throw new ProviderError({
          code: "UPSTREAM",
          outcome: usage.centiNeurons !== null ? "ran" : "unknown",
          message: `Provider reported failure${message ? `: ${message}` : ""}.`,
          httpStatus: 200,
          providerCode,
          providerRequestId,
          usage,
        });
      }
      const bytes = decodeStrictBase64(body.result?.image, MAX_PROVIDER_IMAGE_BYTES);
      if (!bytes) {
        throw new ProviderError({ code: "MALFORMED_RESPONSE", outcome: "ran", message: "Provider image is missing or not valid base64.", httpStatus: 200, providerRequestId, usage });
      }

      return { bytes, usage, provider: CLOUDFLARE_PROVIDER_ID, model, providerRequestId, latencyMs };
    },
  };
}
