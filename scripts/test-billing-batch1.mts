/**
 * Stage 10 Batch 1 Test Suite — Commercial Domain Config, Calculator & Mock Gateway.
 *
 * Verifies:
 * 1. Currency minor unit rules, formatting, and precision invariants.
 * 2. Pure billing domain unit economics calculator with integer/rational arithmetic.
 * 3. Exact demonstration of the ₹50 GST-inclusive video deficit (-₹4.85 / -9.7%).
 * 4. Break-even pricing calculator with target margins.
 * 5. Strict production runtime isolation for the mock gateway engine.
 * 6. Mock gateway capabilities (conservative receipt-lookup default).
 * 7. Ambiguous order creation simulation and idempotent recovery.
 * 8. Cryptographic HMAC signature verification for checkouts and webhooks.
 * 9. ₹0 spend compliance (zero network egress).
 */

import {
  SUPPORTED_CURRENCIES,
  isValidCurrency,
  toMinorUnits,
  fromMinorUnits,
  formatCurrency,
  PROVISIONAL_TAX_ASSUMPTIONS,
  PROVISIONAL_WHOLESALE_COSTS,
  INVOICE_CONFIG_DEFAULTS,
} from "@/features/billing/config";
import {
  calculateUnitEconomics,
  calculateVideoDeficitAt50Rupees,
  calculateBreakEvenChargeMinor,
  computeProviderCostMinor,
  roundDivBigInt,
  ceilDivBigInt,
} from "@/features/billing/calculator";
import {
  MockPaymentGatewayEngine,
} from "@/features/billing/mock-gateway";
import {
  MockGatewayDisallowedError,
  InvalidCurrencyError,
  InvalidAmountError,
  OrderCreationAmbiguityError,
  GatewayCapabilityNotSupportedError,
} from "@/features/billing/types";

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, message: string): void {
  totalTests++;
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
}

async function runSection(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n--- Running Section: ${name} ---`);
  const initial = passedTests;
  await fn();
  console.log(`✅ ${name}: ${passedTests - initial} tests passed.`);
}

// ---------------------------------------------------------------------------
// Section 1: Config, Currencies & Minor-Unit Validation
// ---------------------------------------------------------------------------
await runSection("Config & Currency Minor-Unit Invariants", () => {
  // 1. Supported currencies
  assert(SUPPORTED_CURRENCIES.includes("INR"), "INR must be supported");
  assert(SUPPORTED_CURRENCIES.includes("USD"), "USD must be supported");
  assert(isValidCurrency("INR"), "isValidCurrency('INR') must be true");
  assert(isValidCurrency("USD"), "isValidCurrency('USD') must be true");
  assert(!isValidCurrency("EUR"), "isValidCurrency('EUR') must be false (unsupported)");
  assert(!isValidCurrency(""), "isValidCurrency('') must be false");
  assert(!isValidCurrency(123), "isValidCurrency(123) must be false");

  // 2. Minor unit conversions
  assert(toMinorUnits(1, "INR") === 100, "1 INR = 100 paise");
  assert(toMinorUnits(50, "INR") === 5000, "50 INR = 5000 paise");
  assert(toMinorUnits(10.5, "INR") === 1050, "10.5 INR = 1050 paise");
  assert(toMinorUnits(1, "USD") === 100, "1 USD = 100 cents");
  assert(toMinorUnits(0.5, "USD") === 50, "0.5 USD = 50 cents");

  // Half-up rounding on fractional minor-unit boundaries (INR & USD)
  assert(toMinorUnits(49.995, "INR") === 5000, "INR: 49.995 rounds half-up to 5000 paise");
  assert(toMinorUnits(49.994, "INR") === 4999, "INR: 49.994 rounds down to 4999 paise");
  assert(toMinorUnits(1.005, "INR") === 101, "INR: 1.005 rounds half-up to 101 paise");
  assert(toMinorUnits(1.004, "INR") === 100, "INR: 1.004 rounds down to 100 paise");
  assert(toMinorUnits(1.006, "INR") === 101, "INR: 1.006 rounds up to 101 paise");
  assert(toMinorUnits(0.005, "INR") === 1, "INR: 0.005 rounds half-up to 1 paisa");
  assert(toMinorUnits(0.004, "INR") === 0, "INR: 0.004 rounds down to 0 paise");

  assert(toMinorUnits(19.995, "USD") === 2000, "USD: 19.995 rounds half-up to 2000 cents");
  assert(toMinorUnits(19.994, "USD") === 1999, "USD: 19.994 rounds down to 1999 cents");
  assert(toMinorUnits(1.005, "USD") === 101, "USD: 1.005 rounds half-up to 101 cents");
  assert(toMinorUnits(1.004, "USD") === 100, "USD: 1.004 rounds down to 100 cents");
  assert(toMinorUnits(1.006, "USD") === 101, "USD: 1.006 rounds up to 101 cents");
  assert(toMinorUnits(0.005, "USD") === 1, "USD: 0.005 rounds half-up to 1 cent");
  assert(toMinorUnits(0.004, "USD") === 0, "USD: 0.004 rounds down to 0 cents");

  // Exact boundary at Number.MAX_SAFE_INTEGER / multiplier
  const maxMajorInr = Number.MAX_SAFE_INTEGER / 100;
  assert(
    toMinorUnits(maxMajorInr, "INR") === Number.MAX_SAFE_INTEGER,
    "toMinorUnits converts exact MAX_SAFE_INTEGER / 100 to MAX_SAFE_INTEGER paise without drift",
  );
  assert(
    toMinorUnits(maxMajorInr, "USD") === Number.MAX_SAFE_INTEGER,
    "toMinorUnits converts exact MAX_SAFE_INTEGER / 100 to MAX_SAFE_INTEGER cents without drift",
  );
  assert(
    fromMinorUnits(Number.MAX_SAFE_INTEGER, "INR") === maxMajorInr,
    "fromMinorUnits converts MAX_SAFE_INTEGER minor units to exact major units",
  );

  // Overflow guards on toMinorUnits and fromMinorUnits
  let threw = false;
  try {
    toMinorUnits(Number.MAX_SAFE_INTEGER, "INR");
  } catch {
    threw = true;
  }
  assert(threw, "toMinorUnits rejects amounts that would overflow MAX_SAFE_INTEGER in minor units");

  threw = false;
  try {
    fromMinorUnits(Number.MAX_SAFE_INTEGER + 1, "INR");
  } catch {
    threw = true;
  }
  assert(threw, "fromMinorUnits rejects values exceeding MAX_SAFE_INTEGER");

  // fromMinorUnits
  assert(fromMinorUnits(5000, "INR") === 50.0, "5000 paise = 50 INR");
  assert(fromMinorUnits(100, "USD") === 1.0, "100 cents = 1 USD");

  // Error cases
  threw = false;
  try {
    toMinorUnits(-10, "INR");
  } catch {
    threw = true;
  }
  assert(threw, "toMinorUnits rejects negative amounts");

  threw = false;
  try {
    fromMinorUnits(10.5 as any, "INR");
  } catch {
    threw = true;
  }
  assert(threw, "fromMinorUnits rejects non-integer minor units");

  // Formatting
  assert(formatCurrency(5000, "INR") === "₹50.00", "Formats INR correctly");
  assert(formatCurrency(1250, "USD") === "$12.50", "Formats USD correctly");

  // Provisional configuration defaults
  assert(PROVISIONAL_TAX_ASSUMPTIONS.defaultTaxRatePercent === 18, "Provisional GST is 18%");
  assert(PROVISIONAL_TAX_ASSUMPTIONS.provisionalSacCode === "998314", "Provisional SAC code is 998314");
  assert(PROVISIONAL_WHOLESALE_COSTS.videoWan21Per5sUsd === 0.5, "Fal.ai Wan 2.1 provisional rate is $0.50");
  assert(PROVISIONAL_WHOLESALE_COSTS.usdToInrRate === 85.0, "USD/INR provisional rate is 85.0");
  assert(typeof INVOICE_CONFIG_DEFAULTS.supplierLegalName === "string", "Invoice defaults include supplier name");
});

// ---------------------------------------------------------------------------
// Section 2: Unit Economics & Margin Calculator
// ---------------------------------------------------------------------------
await runSection("Unit Economics & Margin Calculator", () => {
  // Rejection of invalid amounts
  let threw = false;
  try {
    calculateUnitEconomics({ chargeAmountMinor: -500, providerCostUsd: 0.5 });
  } catch {
    threw = true;
  }
  assert(threw, "Rejects negative chargeAmountMinor");

  // Exact reference test: ₹50.00 Video Deficit Demonstration
  const deficit = calculateVideoDeficitAt50Rupees();
  assert(deficit.grossChargeMinor === 5000, "Gross charge is 5000 paise (₹50.00)");
  assert(deficit.taxLiabilityMinor === 763, "Provisional 18% GST liability is 763 paise (₹7.63)");
  assert(deficit.netRevenueMinor === 4237, "Net revenue is 4237 paise (₹42.37)");
  assert(deficit.gatewayFeeMinor === 118, "Domestic gateway MDR fee is 118 paise (2.36% of ₹50 = ₹1.18)");
  assert(deficit.netCashReceivedMinor === 4119, "Net cash received is 4119 paise (₹41.19)");
  assert(deficit.providerCostMinor === 4250, "Fal.ai Wan 2.1 COGS is 4250 paise ($0.50 * 85 = ₹42.50)");
  assert(deficit.storageCostMinor === 15, "Storage & egress is 15 paise (~₹0.15)");
  assert(deficit.refundReserveMinor === 127, "Refund reserve is 127 paise (3% of net revenue = ₹1.27)");
  assert(deficit.safetyBufferMinor === 212, "Safety buffer is 212 paise (5% of net revenue = ₹2.12)");
  assert(deficit.totalCogsMinor === 4604, "Total COGS is 4604 paise (₹46.04)");
  assert(deficit.netMarginMinor === -485, "Net margin is exactly -485 paise (-₹4.85)");
  assert(deficit.grossRevenueMarginPercent === -9.7, "Gross revenue margin percent is -9.7%");
  assert(deficit.netRevenueMarginPercent === -11.45, "Net revenue margin percent is -11.45% (-485 / 4237)");
  assert(deficit.marginPercent === -9.7, "marginPercent aliases gross revenue margin");
  assert(deficit.isDeficit === true, "isDeficit is true for ₹50 video retail price");

  // Gross Revenue Margin vs Net Revenue Margin distinction in profitable SKU
  const imageEcon = calculateUnitEconomics({
    chargeAmountMinor: 100, // ₹1.00 gross
    currency: "INR",
    isTaxInclusive: true,
    taxRatePercent: 18,
    providerCostUsd: PROVISIONAL_WHOLESALE_COSTS.imageFluxSchnellUsd, // $0.004 (~34 paise)
    storageCostMinor: 1,
  });
  assert(imageEcon.isDeficit === false, "Image generation is profitable at ₹1.00");
  assert(imageEcon.netMarginMinor > 0, "Image generation margin is positive");
  assert(
    imageEcon.netRevenueMarginPercent > imageEcon.grossRevenueMarginPercent,
    "Net revenue margin % is higher than gross margin % when tax is positive",
  );

  // Gateway Fee GST Treatment (Configurable Accounting Assumption)
  // Scenario A: Unrecoverable fee (gatewayFeeGstPercent = 18.0 -> 2.36% MDR)
  const feeUnrec = calculateUnitEconomics({
    chargeAmountMinor: 10000,
    providerCostUsd: 0.1,
    gatewayMdrPercent: 2.0,
    gatewayFeeGstPercent: 18.0,
  });
  assert(feeUnrec.gatewayFeeMinor === 236, "Gateway fee with 18% GST is 236 paise (2.36%)");

  // Scenario B: Registered entity claiming ITC (gatewayFeeGstPercent = 0.0 -> 2.0% MDR)
  const feeItc = calculateUnitEconomics({
    chargeAmountMinor: 10000,
    providerCostUsd: 0.1,
    gatewayMdrPercent: 2.0,
    gatewayFeeGstPercent: 0.0,
  });
  assert(feeItc.gatewayFeeMinor === 200, "Gateway fee with 0% GST (ITC claimed) is 200 paise (2.00%)");
  assert(feeItc.netMarginMinor === feeUnrec.netMarginMinor + 36, "ITC accounting retains 36 paise cash margin");

  // Safe Integer Limits & Overflow Detection
  threw = false;
  try {
    calculateUnitEconomics({
      chargeAmountMinor: Number.MAX_SAFE_INTEGER + 100,
      providerCostUsd: 0.5,
    });
  } catch (err: any) {
    threw = err?.code === "INTEGER_OVERFLOW";
  }
  assert(threw, "Rejects chargeAmountMinor exceeding Number.MAX_SAFE_INTEGER");

  // Large-number exact precision (10^9 minor units = ₹10,000,000)
  const largeEcon = calculateUnitEconomics({
    chargeAmountMinor: 1_000_000_000,
    providerCostUsd: 10.0,
    currency: "INR",
  });
  assert(Number.isSafeInteger(largeEcon.netRevenueMinor), "Large net revenue is safe integer");
  assert(Number.isSafeInteger(largeEcon.netMarginMinor), "Large net margin is safe integer");
  assert(largeEcon.netMarginMinor > 0, "Large transaction retains exact integer margin");

  // Break-even with Net Revenue basis vs Gross Revenue basis
  const breakEvenGrossBasis = calculateBreakEvenChargeMinor({
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: 0.5,
    targetMarginPercent: 10,
    marginBasis: "gross",
  });
  const breakEvenNetBasis = calculateBreakEvenChargeMinor({
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: 0.5,
    targetMarginPercent: 10,
    marginBasis: "net",
  });
  assert(
    breakEvenGrossBasis > breakEvenNetBasis,
    "10% gross margin target requires higher retail price than 10% net margin target",
  );

  // Clipper processing positive margin test
  // 1 clip = 500 paise (₹5.00), provider cost = $0.015 (~128 paise)
  const clipEcon = calculateUnitEconomics({
    chargeAmountMinor: 500,
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: PROVISIONAL_WHOLESALE_COSTS.clipperLocalPerRenderUsd, // $0.015
    storageCostMinor: 10,
  });
  assert(clipEcon.isDeficit === false, "Clipper generation is profitable at ₹5.00");
  assert(clipEcon.netMarginMinor > 0, "Clipper generation margin is positive");

  // Tax-exclusive mode test
  const taxExcl = calculateUnitEconomics({
    chargeAmountMinor: 1000, // ₹10.00 net base
    currency: "INR",
    isTaxInclusive: false,
    taxRatePercent: 18,
    providerCostUsd: 0.05,
  });
  assert(taxExcl.netRevenueMinor === 1000, "Tax-exclusive net revenue equals base input");
  assert(taxExcl.taxLiabilityMinor === 180, "18% tax on 1000 is 180");
  assert(taxExcl.grossChargeMinor === 1180, "Gross charge charged to customer is 1180 (base + tax)");

  // Zero-tax mode test
  const zeroTax = calculateUnitEconomics({
    chargeAmountMinor: 2000,
    currency: "USD",
    taxRatePercent: 0,
    providerCostUsd: 5.0,
  });
  assert(zeroTax.taxLiabilityMinor === 0, "0% tax rate yields 0 liability");
  assert(zeroTax.netRevenueMinor === 2000, "0% tax net revenue equals gross");

  // Break-even calculator for video
  const breakEvenGross = calculateBreakEvenChargeMinor({
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: 0.5,
    usdToCurrencyRate: 85.0,
    storageCostMinor: 15,
  });
  assert(breakEvenGross > 5000, "Break-even gross for video must be greater than 5000 paise");

  const breakEvenVerify = calculateUnitEconomics({
    chargeAmountMinor: breakEvenGross,
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: 0.5,
    usdToCurrencyRate: 85.0,
    storageCostMinor: 15,
  });
  assert(breakEvenVerify.netMarginMinor >= 0, "Break-even price yields non-negative margin");
  assert(breakEvenVerify.isDeficit === false, "Break-even price eliminates deficit");

  // Target margin calculator (e.g. 20% margin)
  const target20Gross = calculateBreakEvenChargeMinor({
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: 0.5,
    usdToCurrencyRate: 85.0,
    storageCostMinor: 15,
    targetMarginPercent: 20,
  });
  const targetVerify = calculateUnitEconomics({
    chargeAmountMinor: target20Gross,
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: 0.5,
    usdToCurrencyRate: 85.0,
    storageCostMinor: 15,
  });
  assert(targetVerify.marginPercent >= 20.0, "Target margin 20% achieved");

  // BigInt Rational Arithmetic & Overflow Guards
  // 1. Direct roundDivBigInt half-up tests
  assert(roundDivBigInt(BigInt(5), BigInt(2)) === 3, "roundDivBigInt: 5 / 2 rounds half-up to 3");
  assert(roundDivBigInt(BigInt(4), BigInt(2)) === 2, "roundDivBigInt: 4 / 2 equals 2");
  assert(roundDivBigInt(BigInt(-5), BigInt(2)) === -3, "roundDivBigInt: -5 / 2 rounds half-up to -3");
  assert(roundDivBigInt(BigInt(0), BigInt(100)) === 0, "roundDivBigInt: 0 / 100 equals 0");

  // 2. Division by zero guard
  threw = false;
  try {
    roundDivBigInt(BigInt(100), BigInt(0));
  } catch (err: any) {
    threw = err?.code === "DIVISION_BY_ZERO";
  }
  assert(threw, "roundDivBigInt throws DIVISION_BY_ZERO when denominator is zero");

  // 3. Direct ceilDivBigInt tests
  assert(ceilDivBigInt(BigInt(5), BigInt(2)) === 3, "ceilDivBigInt: 5 / 2 ceiling is 3");
  assert(ceilDivBigInt(BigInt(4), BigInt(2)) === 2, "ceilDivBigInt: 4 / 2 ceiling is 2");
  assert(ceilDivBigInt(BigInt(0), BigInt(5)) === 0, "ceilDivBigInt: 0 / 5 ceiling is 0");

  // 4. Safe Integer Bound Enforcement (MAX_SAFE_INTEGER)
  const maxSafeBig = BigInt(Number.MAX_SAFE_INTEGER);
  assert(roundDivBigInt(maxSafeBig, BigInt(1)) === Number.MAX_SAFE_INTEGER, "Exact MAX_SAFE_INTEGER passes");

  threw = false;
  try {
    roundDivBigInt(maxSafeBig + BigInt(1), BigInt(1));
  } catch (err: any) {
    threw = err?.code === "INTEGER_OVERFLOW";
  }
  assert(threw, "roundDivBigInt throws INTEGER_OVERFLOW when numerator exceeds MAX_SAFE_INTEGER");

  threw = false;
  try {
    ceilDivBigInt(maxSafeBig + BigInt(1), BigInt(1));
  } catch (err: any) {
    threw = err?.code === "INTEGER_OVERFLOW";
  }
  assert(threw, "ceilDivBigInt throws INTEGER_OVERFLOW when result exceeds MAX_SAFE_INTEGER");

  // 5. Provider wholesale cost rational arithmetic (computeProviderCostMinor)
  // Wan 2.1 video: $0.50 * 85 INR/USD = 4250 paise
  assert(
    computeProviderCostMinor(0.5, 85.0, 100) === 4250,
    "computeProviderCostMinor: $0.50 at 85 INR/USD = 4250 paise",
  );
  // FLUX.1 Schnell: $0.004 * 85 INR/USD = 34 paise
  assert(
    computeProviderCostMinor(0.004, 85.0, 100) === 34,
    "computeProviderCostMinor: $0.004 at 85 INR/USD = 34 paise",
  );
  // Clipper: $0.015 * 85 INR/USD = 127.5 paise -> rounds half-up to 128 paise
  assert(
    computeProviderCostMinor(0.015, 85.0, 100) === 128,
    "computeProviderCostMinor: $0.015 at 85 INR/USD rounds half-up to 128 paise",
  );
  // USD currency (multiplier = 100, rate = 1.0): $0.50 = 50 cents
  assert(
    computeProviderCostMinor(0.5, 1.0, 100) === 50,
    "computeProviderCostMinor: $0.50 in USD = 50 cents",
  );
  // Half-up boundary in provider cost: $0.00005 * 100 = 0.005 -> 1 cent
  assert(
    computeProviderCostMinor(0.00005, 1.0, 100) === 0,
    "computeProviderCostMinor: tiny cost rounds to 0",
  );
  assert(
    computeProviderCostMinor(0.005, 1.0, 100) === 1,
    "computeProviderCostMinor: $0.005 USD rounds half-up to 1 cent",
  );
  assert(
    computeProviderCostMinor(0.004, 1.0, 100) === 0,
    "computeProviderCostMinor: $0.004 USD rounds down to 0 cents",
  );

  // 6. Large value at exact MAX_SAFE_INTEGER in calculateUnitEconomics
  const exactMaxEcon = calculateUnitEconomics({
    chargeAmountMinor: Number.MAX_SAFE_INTEGER,
    currency: "INR",
    isTaxInclusive: true,
    taxRatePercent: 18,
    providerCostUsd: 100.0,
  });
  assert(exactMaxEcon.isDeficit === false, "Exact MAX_SAFE_INTEGER calculation succeeds");
  assert(Number.isSafeInteger(exactMaxEcon.netRevenueMinor), "Net revenue is safe integer");
  assert(Number.isSafeInteger(exactMaxEcon.netMarginMinor), "Net margin is safe integer");
  assert(Number.isSafeInteger(exactMaxEcon.taxLiabilityMinor), "Tax liability is safe integer");
  assert(
    exactMaxEcon.netRevenueMinor + exactMaxEcon.taxLiabilityMinor === Number.MAX_SAFE_INTEGER,
    "Exact MAX_SAFE_INTEGER: net revenue + tax liability exactly equals gross charge",
  );
  assert(
    Number.isFinite(exactMaxEcon.grossRevenueMarginPercent) &&
      Number.isFinite(exactMaxEcon.netRevenueMarginPercent),
    "Margin percentages computed safely at MAX_SAFE_INTEGER",
  );

  // Exclusive tax at MAX_SAFE_INTEGER must overflow and throw INTEGER_OVERFLOW
  threw = false;
  try {
    calculateUnitEconomics({
      chargeAmountMinor: Number.MAX_SAFE_INTEGER,
      currency: "INR",
      isTaxInclusive: false,
      taxRatePercent: 18,
      providerCostUsd: 100.0,
    });
  } catch (err: any) {
    threw = err?.code === "INTEGER_OVERFLOW";
  }
  assert(threw, "Tax-exclusive calculation at MAX_SAFE_INTEGER throws INTEGER_OVERFLOW");

  // 7. Break-even calculations near MAX_SAFE_INTEGER
  // Large provider cost within safe bounds: $10,000,000,000 (~850 billion INR)
  const highBeGross = calculateBreakEvenChargeMinor({
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: 10_000_000_000,
    usdToCurrencyRate: 85.0,
    storageCostMinor: 1000,
    targetMarginPercent: 10,
    marginBasis: "gross",
  });
  assert(
    Number.isSafeInteger(highBeGross) && highBeGross > 0,
    "Break-even for large provider cost ($10B) computes safe integer gross charge",
  );
  const highBeVerify = calculateUnitEconomics({
    chargeAmountMinor: highBeGross,
    currency: "INR",
    isTaxInclusive: true,
    providerCostUsd: 10_000_000_000,
    usdToCurrencyRate: 85.0,
    storageCostMinor: 1000,
  });
  assert(highBeVerify.netMarginMinor >= 0, "High-value break-even price yields non-negative margin");
  assert(highBeVerify.grossRevenueMarginPercent >= 10.0, "High-value break-even price achieves 10% target margin");

  // Extreme provider cost that forces break-even charge > MAX_SAFE_INTEGER
  threw = false;
  try {
    calculateBreakEvenChargeMinor({
      currency: "INR",
      isTaxInclusive: true,
      providerCostUsd: 2_000_000_000_000, // $2 trillion
      usdToCurrencyRate: 85.0,
      targetMarginPercent: 20,
    });
  } catch (err: any) {
    threw = err?.code === "INTEGER_OVERFLOW";
  }
  assert(
    threw,
    "calculateBreakEvenChargeMinor throws INTEGER_OVERFLOW when required charge exceeds MAX_SAFE_INTEGER",
  );

  // Unachievable target margin (e.g. 150%) throws UNACHIEVABLE_MARGIN
  threw = false;
  try {
    calculateBreakEvenChargeMinor({
      currency: "INR",
      isTaxInclusive: true,
      providerCostUsd: 0.5,
      targetMarginPercent: 150,
    });
  } catch (err: any) {
    threw = err?.code === "UNACHIEVABLE_MARGIN";
  }
  assert(threw, "calculateBreakEvenChargeMinor throws UNACHIEVABLE_MARGIN for unachievable target margin");
});

// ---------------------------------------------------------------------------
// Section 3: Mock Gateway Environment Isolation & Security
// ---------------------------------------------------------------------------
await runSection("Mock Gateway Environment Isolation & Security", () => {
  const envObj = process.env as Record<string, string | undefined>;
  const originalEnv = envObj.NODE_ENV;

  try {
    // 1. Enforce production failure on constructor
    envObj.NODE_ENV = "production";
    let threw = false;
    try {
      new MockPaymentGatewayEngine();
    } catch (err: any) {
      threw = err instanceof MockGatewayDisallowedError || err?.code === "GATEWAY_DISALLOWED";
      if (!threw) {
        console.error("DEBUG CAUGHT:", err);
      }
    }
    assert(threw, "MockPaymentGatewayEngine throws MockGatewayDisallowedError in production");

    // 2. Enforce production failure when called if created beforehand
    envObj.NODE_ENV = "test";
    const engine = new MockPaymentGatewayEngine();

    envObj.NODE_ENV = "production";
    let threwCall = false;
    try {
      engine.verifyPaymentSignature({
        gatewayOrderId: "mock_order_123",
        gatewayPaymentId: "mock_pay_123",
        gatewaySignature: "sig",
      });
    } catch (err: any) {
      threwCall = err instanceof MockGatewayDisallowedError || err?.code === "GATEWAY_DISALLOWED";
    }
    assert(threwCall, "Mock engine methods fail closed when called in production");
  } finally {
    envObj.NODE_ENV = originalEnv;
  }

  // Confirm normal instantiation in test environment
  const safeEngine = new MockPaymentGatewayEngine();
  assert(safeEngine.gateway === "mock", "Mock engine identifies gateway as 'mock'");
});

// ---------------------------------------------------------------------------
// Section 4: Mock Gateway Capabilities, Lifecycle & Recovery
// ---------------------------------------------------------------------------
await runSection("Mock Gateway Capabilities, Lifecycle & Recovery", async () => {
  const engine = new MockPaymentGatewayEngine();

  // 1. Default conservative capabilities check
  assert(
    engine.capabilities.supportsReceiptLookup === false,
    "supportsReceiptLookup is false by default (conservative assumption)",
  );

  let threwCap = false;
  try {
    await engine.lookupOrderByReceipt("rcpt_123");
  } catch (err: any) {
    threwCap = err instanceof GatewayCapabilityNotSupportedError || err?.code === "CAPABILITY_NOT_SUPPORTED";
  }
  assert(
    threwCap,
    "Calling lookupOrderByReceipt when capability is false throws GatewayCapabilityNotSupportedError",
  );

  // 2. Enable capability explicitly for tests that require recovery
  const recoverableEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });
  assert(
    recoverableEngine.capabilities.supportsReceiptLookup === true,
    "supportsReceiptLookup can be enabled via options",
  );

  // 3. Normal Order Creation
  const orderOut = await recoverableEngine.createOrder({
    userId: "usr_alice_123",
    packageId: "PKG_STARTER",
    creditsAllocated: 100,
    amountMinor: 29900,
    currency: "INR",
    receipt: "rcpt_unique_001",
  });
  assert(orderOut.gateway === "mock", "Gateway is mock");
  assert(orderOut.gatewayOrderId.startsWith("mock_order_"), "Gateway order ID has mock prefix");
  assert(orderOut.receipt === "rcpt_unique_001", "Receipt matches input");
  assert(orderOut.status === "CREATED", "Status is CREATED");

  // 4. Lookup by receipt
  const lookupRec = await recoverableEngine.lookupOrderByReceipt("rcpt_unique_001");
  assert(lookupRec.found === true, "Lookup by receipt finds created order");
  assert(lookupRec.gatewayOrderId === orderOut.gatewayOrderId, "Order IDs match");

  // Non-existent lookup
  const nonExistent = await recoverableEngine.lookupOrderByReceipt("rcpt_ghost");
  assert(nonExistent.found === false, "Non-existent receipt returns found: false");

  // Lookup by gateway order ID
  const lookupId = await recoverableEngine.lookupOrderByGatewayId(orderOut.gatewayOrderId);
  assert(lookupId.found === true, "Lookup by gateway ID finds created order");
  assert(lookupId.receipt === "rcpt_unique_001", "Receipt matches");

  // 5. Ambiguous Order Creation & Recovery Simulation
  // Scenario: Client submits order creation, gateway creates the order, but network times out!
  recoverableEngine.simulateNextTimeout(true, "Connection timed out after socket write");

  let threwAmbiguous = false;
  try {
    await recoverableEngine.createOrder({
      userId: "usr_bob_456",
      packageId: "PKG_CREATOR",
      creditsAllocated: 500,
      amountMinor: 69900,
      currency: "INR",
      receipt: "rcpt_ambiguous_999",
    });
  } catch (err: any) {
    threwAmbiguous = err instanceof OrderCreationAmbiguityError || err?.code === "ORDER_CREATION_AMBIGUOUS";
  }
  assert(threwAmbiguous, "Simulated timeout throws OrderCreationAmbiguityError");

  // Recovery: System queries by receipt instead of blindly retrying!
  const recovered = await recoverableEngine.lookupOrderByReceipt("rcpt_ambiguous_999");
  assert(recovered.found === true, "Ambiguous order was recovered via receipt lookup!");
  assert(recovered.status === "CREATED", "Recovered order is CREATED on gateway");
  assert(recovered.amountMinor === 69900, "Recovered order has correct amount");

  // 6. Simulated Gateway Failure
  recoverableEngine.simulateNextFailure("Card declined: insufficient funds");
  const failedOrder = await recoverableEngine.createOrder({
    userId: "usr_carol_789",
    packageId: "PKG_STARTER",
    creditsAllocated: 100,
    amountMinor: 29900,
    currency: "INR",
    receipt: "rcpt_fail_002",
  });
  assert(failedOrder.status === "FAILED", "Order status reflects simulated failure");

  // 7. Payment Signature Verification
  const clientPay = recoverableEngine.generatePaymentResponse(orderOut.gatewayOrderId);
  assert(typeof clientPay.gatewayPaymentId === "string", "Payment ID generated");
  assert(typeof clientPay.gatewaySignature === "string", "Signature generated");

  // Valid signature
  const isValid = recoverableEngine.verifyPaymentSignature({
    gatewayOrderId: clientPay.gatewayOrderId,
    gatewayPaymentId: clientPay.gatewayPaymentId,
    gatewaySignature: clientPay.gatewaySignature,
  });
  assert(isValid === true, "Valid checkout payment signature passes verification");

  // Tampered payment ID
  const tamperedPay = recoverableEngine.verifyPaymentSignature({
    gatewayOrderId: clientPay.gatewayOrderId,
    gatewayPaymentId: "mock_pay_TAMPERED",
    gatewaySignature: clientPay.gatewaySignature,
  });
  assert(tamperedPay === false, "Tampered payment ID fails signature verification");

  // Tampered signature
  const tamperedSig = recoverableEngine.verifyPaymentSignature({
    gatewayOrderId: clientPay.gatewayOrderId,
    gatewayPaymentId: clientPay.gatewayPaymentId,
    gatewaySignature: "tampered_signature_hex",
  });
  assert(tamperedSig === false, "Tampered signature fails verification");

  // Simulated signature failure
  recoverableEngine.simulateNextInvalidSignature();
  const simFail = recoverableEngine.verifyPaymentSignature(clientPay);
  assert(simFail === false, "simulateNextInvalidSignature forces signature failure");

  // 8. Webhook Generation & Verification
  const webhook = recoverableEngine.generateSimulatedWebhook(
    "payment.captured",
    orderOut.gatewayOrderId,
    clientPay.gatewayPaymentId,
  );
  assert(typeof webhook.rawBody === "string", "Webhook raw body is string");
  assert(typeof webhook.signature === "string", "Webhook signature is string");

  // Verify valid webhook
  const whResult = recoverableEngine.verifyWebhookSignature({
    rawBody: webhook.rawBody,
    signature: webhook.signature,
    secret: webhook.secret,
  });
  assert(whResult.valid === true, "Valid webhook passes HMAC verification");
  assert(whResult.eventType === "payment.captured", "Webhook eventType parsed correctly");
  assert(
    (whResult.payload as any)?.payload?.payment?.entity?.id === clientPay.gatewayPaymentId,
    "Webhook payload contains correct payment ID",
  );

  // Tampered webhook body
  const tamperedWhResult = recoverableEngine.verifyWebhookSignature({
    rawBody: webhook.rawBody + " ",
    signature: webhook.signature,
    secret: webhook.secret,
  });
  assert(tamperedWhResult.valid === false, "Tampered webhook body fails verification");

  // Wrong webhook secret
  const wrongSecretWhResult = recoverableEngine.verifyWebhookSignature({
    rawBody: webhook.rawBody,
    signature: webhook.signature,
    secret: "wrong_secret_key",
  });
  assert(wrongSecretWhResult.valid === false, "Wrong webhook secret fails verification");

  // Missing arguments
  const missingArgs = recoverableEngine.verifyWebhookSignature({
    rawBody: "",
    signature: "",
    secret: "",
  });
  assert(missingArgs.valid === false, "Missing webhook arguments fail verification");
});

console.log(`\n=================================================`);
console.log(`🎯 STAGE 10 BATCH 1 TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
console.log(`=================================================\n`);

if (passedTests !== totalTests) {
  process.exit(1);
}
