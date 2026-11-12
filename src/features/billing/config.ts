/**
 * Commercial Billing Domain Configuration (Stage 10 Batch 1).
 *
 * NOTE ON PROVISIONAL STATUS:
 * All statutory tax rates (18% GST), SAC codes (998314), place of supply rules,
 * wholesale provider costs, and invoice numbering formats are unverified working
 * assumptions pending formal review by a qualified Indian Chartered Accountant (CA)
 * or tax legal counsel. No statutory compliance claims are made.
 */

export const SUPPORTED_CURRENCIES = ["INR", "USD"] as const;
export type PaymentCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const MINOR_UNITS_PER_CURRENCY: Record<PaymentCurrency, number> = {
  INR: 100, // 1 INR = 100 paise
  USD: 100, // 1 USD = 100 cents
};

/**
 * Provisional statutory tax assumptions.
 * Subject to qualified CA / tax legal counsel review.
 */
export const PROVISIONAL_TAX_ASSUMPTIONS = {
  defaultTaxRatePercent: 18,
  provisionalSacCode: "998314", // Information Technology / Cloud-hosted Digital Services
  gstInvoiceEnabled: false, // GST tax invoices disabled pending CA review & GSTIN registration
  disclaimer:
    "Provisional purchase receipt for development and test billing. Official statutory GST tax invoice issuance is currently disabled pending formal legal entity registration, supplier GSTIN provisioning, and place-of-supply verification by a qualified Chartered Accountant.",
} as const;

/**
 * Provisional wholesale provider costs and operational parameters.
 * Subject to verification with live production invoices.
 */
export const PROVISIONAL_WHOLESALE_COSTS = {
  /** Cloudflare FLUX.1 Schnell image generation estimate (USD per image) */
  imageFluxSchnellUsd: 0.004,
  /** Fal.ai Wan 2.1 720p 5-second video generation estimate ($0.10/sec * 5s = $0.50) */
  videoWan21Per5sUsd: 0.50,
  /** Local worker / containerized FFmpeg & Whisper clipping compute estimate (USD) */
  clipperLocalPerRenderUsd: 0.015,
  /** Supabase storage private bucket egress estimate per GB (USD) */
  storageEgressPerGbUsd: 0.09,
  /** Working USD to INR exchange rate assumption */
  usdToInrRate: 85.0,
  /** Standard domestic payment gateway MDR (e.g. UPI/cards: 2.0%) */
  domesticGatewayMdrPercent: 2.0,
  /** GST on gateway MDR fees (18% on MDR) */
  gatewayFeeGstPercent: 18.0,
  /** Standard international gateway MDR (e.g. 3.0%) */
  internationalGatewayMdrPercent: 3.0,
  /** Average generated video asset size in MB for egress calculation */
  defaultVideoAssetSizeMb: 20.0,
  /** Allowance reserve percentage for failed/incomplete job refunds (configurable working assumption) */
  defaultRefundReservePercent: 3.0,
  /** Operational and compute capacity safety buffer percentage (configurable working assumption) */
  defaultSafetyBufferPercent: 5.0,
} as const;

/**
 * Configurable invoice generation defaults.
 * Configurable via environment variables or runtime configuration.
 */
export const INVOICE_CONFIG_DEFAULTS = {
  supplierLegalName: process.env.INVOICE_SUPPLIER_NAME ?? "YourAI (Trading Platform)",
  supplierAddress: process.env.INVOICE_SUPPLIER_ADDRESS ?? "Operations & Cloud Infrastructure",
  /**
   * Verified supplier GSTIN. Null until statutory registration.
   * Fabricated or placeholder GSTINs are strictly prohibited.
   */
  supplierGstin: process.env.INVOICE_SUPPLIER_GSTIN ?? null,
  supplierStateCode: process.env.INVOICE_SUPPLIER_STATE_CODE ?? null,
  receiptPrefix: process.env.INVOICE_PREFIX ?? "RCPT",
} as const;

/**
 * Currency validation and formatting helpers.
 */
export function isValidCurrency(code: unknown): code is PaymentCurrency {
  return typeof code === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

export function toMinorUnits(amountMajor: number, currency: PaymentCurrency): number {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) {
    throw new Error(`Amount must be a non-negative finite number: ${amountMajor}`);
  }
  const multiplier = MINOR_UNITS_PER_CURRENCY[currency];

  if (amountMajor > Number.MAX_SAFE_INTEGER / multiplier) {
    throw new Error(
      `Amount ${amountMajor} exceeds safe integer limit when converted to ${currency} minor units`,
    );
  }

  // Exact half-up rounding (round half away from zero) using split-integer BigInt arithmetic
  // to avoid binary floating-point representation anomalies (e.g. 1.005 * 100 = 100.49999999999999)
  // and preserve exact precision up to Number.MAX_SAFE_INTEGER without intermediate float overflow.
  const whole = Math.floor(amountMajor);
  const frac = amountMajor - whole;
  const scaledFrac = BigInt(Math.round(frac * 1_000_000));
  const scaled = BigInt(whole) * BigInt(1_000_000) + scaledFrac;
  const multBig = BigInt(multiplier);
  const n = scaled * multBig;
  const d = BigInt(1_000_000);
  const q = n / d;
  const r = n % d;
  const res = r * BigInt(2) >= d ? q + BigInt(1) : q;

  if (res > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Amount exceeds safe integer range: ${amountMajor}`);
  }

  return Number(res);
}

export function fromMinorUnits(amountMinor: number, currency: PaymentCurrency): number {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`Amount in minor units must be a non-negative integer: ${amountMinor}`);
  }
  if (amountMinor > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Amount in minor units exceeds safe integer range: ${amountMinor}`);
  }
  const multiplier = MINOR_UNITS_PER_CURRENCY[currency];
  return amountMinor / multiplier;
}

export function formatCurrency(amountMinor: number, currency: PaymentCurrency): string {
  const major = fromMinorUnits(amountMinor, currency);
  if (currency === "INR") {
    return `₹${major.toFixed(2)}`;
  }
  if (currency === "USD") {
    return `$${major.toFixed(2)}`;
  }
  return `${major.toFixed(2)} ${currency}`;
}
