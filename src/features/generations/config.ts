/**
 * Approved image-generation pricing and quotas.
 *
 * User credits and provider Neurons are separate ledgers:
 *  - credits are what the user pays (CreditWallet / CreditTransaction)
 *  - Neurons are provider capacity (ProviderDailyBudget / ProviderBudgetReservation)
 *
 * Neurons are stored as integer centi-neurons (1/100 Neuron) because Cloudflare
 * reports usage with two decimals ("172.80").
 */

export const IMAGE_PROVIDER = "cloudflare-workers-ai";
export const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export const IMAGE_QUALITIES = {
  fast: { label: "Fast", steps: 4, credits: 1, reservedCentiNeurons: 17_280 }, // 172.80 Neurons
  detailed: { label: "Detailed", steps: 8, credits: 2, reservedCentiNeurons: 32_640 }, // 326.40 Neurons
} as const;

export type ImageQuality = keyof typeof IMAGE_QUALITIES;

export const isImageQuality = (value: unknown): value is ImageQuality =>
  typeof value === "string" && Object.hasOwn(IMAGE_QUALITIES, value);

/** Max image generations per user per UTC day. Counts every job whose provider may have run
 * or did run (even if later refunded); only jobs whose reservation was RELEASED are excluded. */
export const DAILY_USER_IMAGE_LIMIT = 10;

/** App-wide provider budget per UTC day: 9,500 Neurons (leaves 500 of the free 10,000 as margin). */
export const DAILY_NEURON_LIMIT_CENTI = 950_000;

export const PROMPT_MIN_LENGTH = 1;
/** FLUX.1 Schnell's documented prompt maximum. */
export const PROMPT_MAX_LENGTH = 2048;

/** A PENDING job older than this never reached the provider and is safe to release + refund. */
export const PENDING_STALE_MS = 2 * 60_000;
/**
 * A PROCESSING job older than this cannot still have a provider request in flight
 * (provider calls take seconds and are aborted at 60s), so reconciliation may settle it.
 */
export const PROCESSING_STALE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Provider + storage limits (Stage 4)
// ---------------------------------------------------------------------------

/** Abort our wait for the provider after this long. Must stay well below PROCESSING_STALE_MS. */
export const PROVIDER_TIMEOUT_MS = 60_000;
/** Largest provider response body we will read (base64 image + JSON). ~819 KB JPEG ≈ 1.1 MB base64. */
export const MAX_PROVIDER_RESPONSE_BYTES = 15 * 1024 * 1024;
/** Largest decoded provider image we will process. */
export const MAX_PROVIDER_IMAGE_BYTES = 10 * 1024 * 1024;
/** Largest image dimension accepted from the provider (FLUX.1 Schnell returns 1024×1024). */
export const MAX_IMAGE_DIMENSION = 2048;
/** Smallest plausible dimension; anything smaller is treated as invalid output. */
export const MIN_IMAGE_DIMENSION = 64;

/** Stored format. JPEG originals are never stored. */
export const STORED_IMAGE_MIME = "image/webp";
export const WEBP_QUALITY = 85;
/** Matches the bucket's file-size limit; enforced in application code too. */
export const MAX_STORED_IMAGE_BYTES = 5 * 1024 * 1024;
/** Lifetime of signed asset URLs (seconds). */
export const SIGNED_URL_TTL_SECONDS = 600;
