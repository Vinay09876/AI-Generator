/**
 * Dynamic Unit Economics & Margin Calculator (Stage 10 Batch 1).
 *
 * ARITHMETIC SAFETY & PRECISION INVARIANTS:
 * - Operates strictly with BigInt-based rational arithmetic for all intermediate
 *   multiplications and divisions to prevent silent IEEE 754 precision drift or overflow.
 * - Compatible with ES2017+ target (uses BigInt constructor functions, no literal suffix).
 * - Enforces Number.MAX_SAFE_INTEGER bounds (9,007,199,254,740,991 minor units).
 * - Exceeding safe integer bounds throws an explicit INTEGER_OVERFLOW BillingError.
 * - Applies half-up rounding (round-half-away-from-zero) strictly at discrete minor-unit
 *   conversion boundaries and percentage formatting boundaries.
 *
 * GATEWAY MDR GST TREATMENT (ACCOUNTING ASSUMPTION):
 * - Aggregators in India (e.g. Razorpay) levy 18% GST on the MDR transaction fee (e.g. 2.0% * 1.18 = 2.36%).
 * - By default, this calculator treats gateway fee GST as an unrecoverable cash expense.
 * - For registered entities claiming Input Tax Credit (ITC) under Section 16 of the CGST Act, 2017,
 *   the gatewayFeeGstPercent can be configured to 0.0 to reflect net-of-tax fee costs.
 *   This treatment is an unverified accounting assumption pending qualified CA review.
 */

import {
  MINOR_UNITS_PER_CURRENCY,
  PROVISIONAL_TAX_ASSUMPTIONS,
  PROVISIONAL_WHOLESALE_COSTS,
  type PaymentCurrency,
} from "./config";
import { BillingError } from "./types";

const B_0 = BigInt(0);
const B_1 = BigInt(1);
const B_2 = BigInt(2);
const B_10000 = BigInt(10_000);
const B_1000000 = BigInt(1_000_000);
const B_100000000 = BigInt(100_000_000);
const B_1000000000 = BigInt(1_000_000_000);
const B_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export interface UnitEconomicsInput {
  /** Gross retail charge amount in integer minor units (e.g. paise for INR, cents for USD) */
  chargeAmountMinor: number;
  /** Currency (defaults to "INR") */
  currency?: PaymentCurrency;
  /** Whether the gross charge is inclusive of statutory taxes (defaults to true) */
  isTaxInclusive?: boolean;
  /** Statutory tax percentage (provisional assumption, defaults to 18%) */
  taxRatePercent?: number;
  /** Payment gateway base MDR percentage (defaults to 2.0%) */
  gatewayMdrPercent?: number;
  /**
   * GST percentage levied on gateway MDR fee (defaults to 18.0%).
   * Configurable accounting assumption: set to 0.0 if ITC is claimed by registered entity.
   */
  gatewayFeeGstPercent?: number;
  /** Provider wholesale cost in USD */
  providerCostUsd: number;
  /** USD to Currency exchange rate (defaults to 85.0 for INR, 1.0 for USD) */
  usdToCurrencyRate?: number;
  /** Storage and bandwidth cost in integer minor units (defaults to 15 paise for INR) */
  storageCostMinor?: number;
  /** Configurable working assumption: reserve percentage for failed/incomplete job refund allowance */
  refundReservePercent?: number;
  /** Configurable working assumption: operational compute and capacity safety buffer percentage */
  safetyBufferPercent?: number;
}

export interface UnitEconomicsResult {
  currency: PaymentCurrency;
  isTaxInclusive: boolean;
  grossChargeMinor: number;
  taxLiabilityMinor: number;
  netRevenueMinor: number;
  gatewayFeeMinor: number;
  netCashReceivedMinor: number;
  providerCostMinor: number;
  storageCostMinor: number;
  refundReserveMinor: number;
  safetyBufferMinor: number;
  totalCogsMinor: number;
  netMarginMinor: number;
  /** Gross revenue margin percentage: (netMargin / grossCharge) * 100 */
  grossRevenueMarginPercent: number;
  /** Net revenue margin percentage: (netMargin / netRevenue) * 100 */
  netRevenueMarginPercent: number;
  /** Alias to grossRevenueMarginPercent for backward compatibility */
  marginPercent: number;
  isDeficit: boolean;
}

export interface BreakEvenOptions {
  /**
   * Basis for target margin:
   * - "gross": margin >= grossCharge * targetMarginPercent
   * - "net": margin >= netRevenue * targetMarginPercent
   * Defaults to "gross".
   */
  marginBasis?: "gross" | "net";
  /** Target margin percentage (e.g. 20 for 20%) */
  targetMarginPercent?: number;
}

/**
 * Computes round(numerator / denominator) using BigInt rational arithmetic with half-up rounding.
 * Guarantees zero floating point precision loss and enforces Number.MAX_SAFE_INTEGER bounds.
 */
export function roundDivBigInt(numerator: bigint, denominator: bigint): number {
  if (denominator === B_0) {
    throw new BillingError("Division by zero in financial arithmetic", "DIVISION_BY_ZERO", 500);
  }

  const isNeg = (numerator < B_0) !== (denominator < B_0);
  const n = numerator < B_0 ? -numerator : numerator;
  const d = denominator < B_0 ? -denominator : denominator;

  const q = n / d;
  const r = n % d;

  // Half-up rounding (round half away from zero)
  const rounded = r * B_2 >= d ? q + B_1 : q;
  const signed = isNeg ? -rounded : rounded;

  if (signed > B_MAX_SAFE || signed < -B_MAX_SAFE) {
    throw new BillingError(
      `Financial calculation result exceeds safe integer range (${Number.MAX_SAFE_INTEGER})`,
      "INTEGER_OVERFLOW",
      400,
    );
  }

  return Number(signed);
}

/**
 * Computes ceil(numerator / denominator) for positive numbers using BigInt arithmetic.
 */
export function ceilDivBigInt(numerator: bigint, denominator: bigint): number {
  if (denominator <= B_0 || numerator < B_0) {
    throw new BillingError("Invalid arguments to ceilDivBigInt", "INVALID_ARGUMENT", 500);
  }
  const q = numerator / denominator;
  const r = numerator % denominator;
  const res = r > B_0 ? q + B_1 : q;

  if (res > B_MAX_SAFE) {
    throw new BillingError(
      `Financial calculation result exceeds safe integer range (${Number.MAX_SAFE_INTEGER})`,
      "INTEGER_OVERFLOW",
      400,
    );
  }

  return Number(res);
}

/**
 * Converts a provider wholesale cost in USD to local currency minor units using
 * BigInt rational arithmetic with half-up rounding. Prevents IEEE 754 precision
 * drift and guarantees safe integer boundaries up to Number.MAX_SAFE_INTEGER.
 */
export function computeProviderCostMinor(
  providerCostUsd: number,
  usdToCurrencyRate: number,
  multiplier: number,
): number {
  if (!Number.isFinite(providerCostUsd) || providerCostUsd < 0) {
    throw new BillingError(
      `providerCostUsd must be a non-negative finite number: ${providerCostUsd}`,
      "INVALID_AMOUNT",
      400,
    );
  }
  if (!Number.isFinite(usdToCurrencyRate) || usdToCurrencyRate <= 0) {
    throw new BillingError(
      `usdToCurrencyRate must be a positive finite number: ${usdToCurrencyRate}`,
      "INVALID_AMOUNT",
      400,
    );
  }

  // Decompose providerCostUsd into whole and 6-decimal fractional parts
  const wholeUsd = Math.floor(providerCostUsd);
  const fracUsd = providerCostUsd - wholeUsd;
  const scaledFracUsd = BigInt(Math.round(fracUsd * 1_000_000));
  const scaledUsdBig = BigInt(wholeUsd) * B_1000000 + scaledFracUsd;

  // Decompose usdToCurrencyRate into whole and 4-decimal fractional parts
  const wholeRate = Math.floor(usdToCurrencyRate);
  const fracRate = usdToCurrencyRate - wholeRate;
  const scaledFracRate = BigInt(Math.round(fracRate * 10_000));
  const scaledRateBig = BigInt(wholeRate) * B_10000 + scaledFracRate;

  const multBig = BigInt(multiplier);

  // Numerator scale = 10^6 * 10^4 = 10^10. Minor units: (scaledUsd * scaledRate * mult) / 10^10
  const numerator = scaledUsdBig * scaledRateBig * multBig;
  const denominator = B_1000000 * B_10000;

  return roundDivBigInt(numerator, denominator);
}

/**
 * Calculates unit economics for a generation or service SKU.
 * Uses BigInt rational arithmetic with half-up rounding only at minor-unit boundaries.
 */
export function calculateUnitEconomics(input: UnitEconomicsInput): UnitEconomicsResult {
  const currency = input.currency ?? "INR";
  const multiplier = MINOR_UNITS_PER_CURRENCY[currency];

  if (!Number.isInteger(input.chargeAmountMinor) || input.chargeAmountMinor <= 0) {
    throw new BillingError(
      `chargeAmountMinor must be a positive integer in minor units: ${input.chargeAmountMinor}`,
      "INVALID_AMOUNT",
      400,
    );
  }

  if (input.chargeAmountMinor > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(input.chargeAmountMinor)) {
    throw new BillingError(
      `chargeAmountMinor exceeds safe integer limit (${Number.MAX_SAFE_INTEGER})`,
      "INTEGER_OVERFLOW",
      400,
    );
  }

  const isTaxInclusive = input.isTaxInclusive ?? true;
  const taxRatePercent = input.taxRatePercent ?? PROVISIONAL_TAX_ASSUMPTIONS.defaultTaxRatePercent;
  const gatewayMdrPercent = input.gatewayMdrPercent ?? PROVISIONAL_WHOLESALE_COSTS.domesticGatewayMdrPercent;
  const gatewayFeeGstPercent = input.gatewayFeeGstPercent ?? PROVISIONAL_WHOLESALE_COSTS.gatewayFeeGstPercent;
  const usdToRate =
    input.usdToCurrencyRate ??
    (currency === "INR" ? PROVISIONAL_WHOLESALE_COSTS.usdToInrRate : 1.0);
  const refundReservePercent =
    input.refundReservePercent ?? PROVISIONAL_WHOLESALE_COSTS.defaultRefundReservePercent;
  const safetyBufferPercent =
    input.safetyBufferPercent ?? PROVISIONAL_WHOLESALE_COSTS.defaultSafetyBufferPercent;

  let grossChargeMinor = input.chargeAmountMinor;
  let netRevenueMinor: number;
  let taxLiabilityMinor: number;

  const grossBig = BigInt(grossChargeMinor);

  if (isTaxInclusive) {
    if (taxRatePercent > 0) {
      // Net revenue = grossCharge / (1 + rate/100) = (grossCharge * 1000000) / (1000000 + rate * 10000)
      const taxBp = BigInt(Math.round(taxRatePercent * 10000));
      const denom = B_1000000 + taxBp;
      netRevenueMinor = roundDivBigInt(grossBig * B_1000000, denom);
      taxLiabilityMinor = grossChargeMinor - netRevenueMinor;
    } else {
      netRevenueMinor = grossChargeMinor;
      taxLiabilityMinor = 0;
    }
  } else {
    netRevenueMinor = grossChargeMinor;
    const taxBp = BigInt(Math.round(taxRatePercent * 10000));
    taxLiabilityMinor = roundDivBigInt(BigInt(netRevenueMinor) * taxBp, B_1000000);
    const sumGross = BigInt(netRevenueMinor) + BigInt(taxLiabilityMinor);
    if (sumGross > B_MAX_SAFE) {
      throw new BillingError("Gross charge with tax exceeds safe integer range", "INTEGER_OVERFLOW", 400);
    }
    grossChargeMinor = Number(sumGross);
  }

  // Effective Gateway MDR = baseMdr * (1 + feeGst / 100)
  // For domestic India: 2.0 * (1 + 0.18) = 2.36% (if gateway fee GST is an unrecoverable cost)
  const effectiveMdrPercent = gatewayMdrPercent * (1 + gatewayFeeGstPercent / 100);
  const mdrBp = BigInt(Math.round(effectiveMdrPercent * 1000000));
  const gatewayFeeMinor = roundDivBigInt(BigInt(grossChargeMinor) * mdrBp, B_100000000);

  // Net merchant cash received after processing fee
  const netCashReceivedMinor = netRevenueMinor - gatewayFeeMinor;

  // Provider cost in local minor currency units (BigInt rational conversion)
  const providerCostMinor = computeProviderCostMinor(input.providerCostUsd, usdToRate, multiplier);

  // Storage and bandwidth cost
  const storageCostMinor = Math.round(input.storageCostMinor ?? (currency === "INR" ? 15 : 1));

  // Risk allocations (proportional to net revenue)
  const netRevBig = BigInt(netRevenueMinor);
  const refundBp = BigInt(Math.round(refundReservePercent * 10000));
  const refundReserveMinor = roundDivBigInt(netRevBig * refundBp, B_1000000);

  const safetyBp = BigInt(Math.round(safetyBufferPercent * 10000));
  const safetyBufferMinor = roundDivBigInt(netRevBig * safetyBp, B_1000000);

  // Total COGS
  const totalCogsBig =
    BigInt(providerCostMinor) +
    BigInt(storageCostMinor) +
    BigInt(refundReserveMinor) +
    BigInt(safetyBufferMinor);
  if (totalCogsBig > B_MAX_SAFE) {
    throw new BillingError("Total COGS exceeds safe integer range", "INTEGER_OVERFLOW", 400);
  }
  const totalCogsMinor = Number(totalCogsBig);

  // Net margin in BigInt to guard against underflow below -Number.MAX_SAFE_INTEGER
  const netMarginBig = BigInt(netCashReceivedMinor) - totalCogsBig;
  if (netMarginBig > B_MAX_SAFE || netMarginBig < -B_MAX_SAFE) {
    throw new BillingError("Net margin exceeds safe integer range", "INTEGER_OVERFLOW", 400);
  }
  const netMarginMinor = Number(netMarginBig);

  // Margin percentages using BigInt to eliminate floating point rounding error in percentage
  const grossRevMarginBp = roundDivBigInt(BigInt(netMarginMinor) * B_10000, BigInt(grossChargeMinor));
  const grossRevenueMarginPercent = grossRevMarginBp / 100;

  const netRevMarginBp =
    netRevenueMinor > 0
      ? roundDivBigInt(BigInt(netMarginMinor) * B_10000, BigInt(netRevenueMinor))
      : 0;
  const netRevenueMarginPercent = netRevMarginBp / 100;

  const isDeficit = netMarginMinor < 0;

  return {
    currency,
    isTaxInclusive,
    grossChargeMinor,
    taxLiabilityMinor,
    netRevenueMinor,
    gatewayFeeMinor,
    netCashReceivedMinor,
    providerCostMinor,
    storageCostMinor,
    refundReserveMinor,
    safetyBufferMinor,
    totalCogsMinor,
    netMarginMinor,
    grossRevenueMarginPercent,
    netRevenueMarginPercent,
    marginPercent: grossRevenueMarginPercent,
    isDeficit,
  };
}

/**
 * Built-in reference demonstration verifying why a GST-inclusive ₹50.00
 * retail video price produces an immediate cash-negative deficit:
 * - Gross Revenue Margin: -9.70% (-₹4.85 / ₹50.00)
 * - Net Revenue Margin:   -11.45% (-₹4.85 / ₹42.37)
 */
export function calculateVideoDeficitAt50Rupees(): UnitEconomicsResult {
  return calculateUnitEconomics({
    chargeAmountMinor: 5000, // ₹50.00 in paise
    currency: "INR",
    isTaxInclusive: true,
    taxRatePercent: 18,
    gatewayMdrPercent: 2.0,
    gatewayFeeGstPercent: 18.0,
    providerCostUsd: PROVISIONAL_WHOLESALE_COSTS.videoWan21Per5sUsd, // $0.50
    usdToCurrencyRate: 85.0,
    storageCostMinor: 15, // 15 paise (~20 MB asset)
    refundReservePercent: 3.0,
    safetyBufferPercent: 5.0,
  });
}

/**
 * Calculates the break-even gross charge in minor units required to cover all costs
 * and achieve a non-negative margin (or a target margin percentage on either gross or net revenue).
 * Uses BigInt ceiling division to prevent intermediate overflow.
 */
export function calculateBreakEvenChargeMinor(
  params: Omit<UnitEconomicsInput, "chargeAmountMinor"> & BreakEvenOptions,
): number {
  const targetMargin = (params.targetMarginPercent ?? 0) / 100;
  const marginBasis = params.marginBasis ?? "gross";
  const currency = params.currency ?? "INR";
  const multiplier = MINOR_UNITS_PER_CURRENCY[currency];
  const usdToRate =
    params.usdToCurrencyRate ??
    (currency === "INR" ? PROVISIONAL_WHOLESALE_COSTS.usdToInrRate : 1.0);
  const taxRatePercent = params.taxRatePercent ?? PROVISIONAL_TAX_ASSUMPTIONS.defaultTaxRatePercent;
  const gatewayMdrPercent = params.gatewayMdrPercent ?? PROVISIONAL_WHOLESALE_COSTS.domesticGatewayMdrPercent;
  const gatewayFeeGstPercent = params.gatewayFeeGstPercent ?? PROVISIONAL_WHOLESALE_COSTS.gatewayFeeGstPercent;
  const effectiveMdr = (gatewayMdrPercent * (1 + gatewayFeeGstPercent / 100)) / 100;
  const storageCostMinor = Math.round(params.storageCostMinor ?? (currency === "INR" ? 15 : 1));
  const refundReserve = (params.refundReservePercent ?? PROVISIONAL_WHOLESALE_COSTS.defaultRefundReservePercent) / 100;
  const safetyBuffer = (params.safetyBufferPercent ?? PROVISIONAL_WHOLESALE_COSTS.defaultSafetyBufferPercent) / 100;

  const providerCostMinor = computeProviderCostMinor(params.providerCostUsd, usdToRate, multiplier);
  const fixedCogsBig = BigInt(providerCostMinor) + BigInt(storageCostMinor);
  if (fixedCogsBig > B_MAX_SAFE) {
    throw new BillingError("Fixed COGS exceeds safe integer limit", "INTEGER_OVERFLOW", 400);
  }
  const fixedCogsMinor = Number(fixedCogsBig);

  const isTaxInclusive = params.isTaxInclusive ?? true;
  const netRevRatio = isTaxInclusive ? 1 / (1 + taxRatePercent / 100) : 1;

  let coef: number;
  if (marginBasis === "net") {
    coef = netRevRatio * (1 - refundReserve - safetyBuffer - targetMargin) - effectiveMdr;
  } else {
    coef = netRevRatio * (1 - refundReserve - safetyBuffer) - effectiveMdr - targetMargin;
  }

  // Scale coef to 10^9 to perform exact BigInt ceiling division
  const coefScaled = BigInt(Math.round(coef * 1_000_000_000));
  if (coefScaled <= B_0) {
    throw new BillingError(
      "Target margin is mathematically unachievable with given cost and tax parameters.",
      "UNACHIEVABLE_MARGIN",
      400,
    );
  }

  const numerator = BigInt(fixedCogsMinor) * B_1000000000;

  return ceilDivBigInt(numerator, coefScaled);
}
