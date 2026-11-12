/**
 * Server-Side Credit Packages & Pricing Catalog (Stage 10).
 *
 * SECURITY & INTEGRITY INVARIANT:
 * - Package pricing, credit allocations, currencies, and tax rules are resolved
 *   EXCLUSIVELY on the server.
 * - Client-supplied amounts, credit quantities, or prices are NEVER trusted.
 * - Unknown, disabled, or malformed package IDs are rejected at the API boundary.
 *
 * PROVISIONAL / DEV STATUS:
 * - Production packages and retail pricing have NOT been finalized or authorized.
 * - The packages defined here serve strictly as a development and automated test
 *   fixture. Do not invent final retail prices.
 */

import { BillingError } from "./types";
import type { PaymentCurrency } from "./config";

export interface BillingCreditPackage {
  /** Unique stable package identifier (e.g. PKG_STARTER, PKG_CREATOR) */
  readonly id: string;
  /** Human-readable package display name */
  readonly name: string;
  /** Number of generation compute credits granted */
  readonly creditsAllocated: number;
  /** Total price in minor units (e.g. 5000 paise = ₹50.00) */
  readonly amountMinor: number;
  /** ISO currency code ("INR" | "USD") */
  readonly currency: PaymentCurrency;
  /** Whether the package amount is tax inclusive (true for consumer INR) */
  readonly isTaxInclusive: boolean;
  /** Applicable GST/tax rate percentage (e.g. 18.0) */
  readonly taxRatePercent: number;
  /** Whether the package is currently available for purchase */
  readonly isActive: boolean;
  /** Optional metadata describing the tier */
  readonly metadata?: Record<string, unknown>;
}

export interface PackagePricingSnapshot {
  readonly packageId: string;
  readonly name: string;
  readonly creditsAllocated: number;
  readonly amountMinor: number;
  readonly currency: PaymentCurrency;
  readonly isTaxInclusive: boolean;
  readonly taxRatePercent: number;
  readonly resolvedAt: string;
  readonly catalogSource: "server_provisional" | "server_production";
  readonly metadata?: Record<string, unknown>;
}

/**
 * Provisional server-side credit packages catalog for development and testing.
 * Final customer-facing pricing has not been finalized.
 */
export const PROVISIONAL_SERVER_CREDIT_PACKAGES: Readonly<Record<string, BillingCreditPackage>> = {
  PKG_STARTER: {
    id: "PKG_STARTER",
    name: "Starter Package (Provisional Dev/Test)",
    creditsAllocated: 100,
    amountMinor: 5000, // ₹50.00 provisional test price
    currency: "INR",
    isTaxInclusive: true,
    taxRatePercent: 18,
    isActive: true,
    metadata: { tier: "starter", provisional: true },
  },
  PKG_CREATOR: {
    id: "PKG_CREATOR",
    name: "Creator Package (Provisional Dev/Test)",
    creditsAllocated: 500,
    amountMinor: 69900, // ₹699.00 provisional test price
    currency: "INR",
    isTaxInclusive: true,
    taxRatePercent: 18,
    isActive: true,
    metadata: { tier: "creator", provisional: true },
  },
  PKG_PRO: {
    id: "PKG_PRO",
    name: "Pro Package (Provisional Dev/Test)",
    creditsAllocated: 1500,
    amountMinor: 159900, // ₹1,599.00 provisional test price
    currency: "INR",
    isTaxInclusive: true,
    taxRatePercent: 18,
    isActive: true,
    metadata: { tier: "pro", provisional: true },
  },
  PKG_USD_TEST: {
    id: "PKG_USD_TEST",
    name: "USD Test Package (Provisional Dev/Test)",
    creditsAllocated: 250,
    amountMinor: 1000, // $10.00 provisional test price
    currency: "USD",
    isTaxInclusive: false,
    taxRatePercent: 0,
    isActive: true,
    metadata: { tier: "test_usd", provisional: true },
  },
  PKG_DISABLED_TEST: {
    id: "PKG_DISABLED_TEST",
    name: "Disabled Test Package",
    creditsAllocated: 100,
    amountMinor: 5000,
    currency: "INR",
    isTaxInclusive: true,
    taxRatePercent: 18,
    isActive: false, // Disabled for purchase
    metadata: { disabled: true },
  },
};

/**
 * Resolves a credit package from the server-side catalog.
 * Validates existence and active status.
 */
export function resolveServerCreditPackage(
  packageId: unknown,
  catalog: Record<string, BillingCreditPackage> = PROVISIONAL_SERVER_CREDIT_PACKAGES,
): BillingCreditPackage {
  if (typeof packageId !== "string" || packageId.trim().length === 0) {
    throw new BillingError("Invalid or missing package identifier", "INVALID_PACKAGE", 400);
  }

  const cleanId = packageId.trim();
  const pkg = catalog[cleanId];

  if (!pkg) {
    throw new BillingError(`Unknown credit package: ${cleanId}`, "UNKNOWN_PACKAGE", 400);
  }

  if (!pkg.isActive) {
    throw new BillingError(`Credit package is inactive or disabled: ${cleanId}`, "PACKAGE_DISABLED", 400);
  }

  return pkg;
}

/**
 * Creates an immutable snapshot from a resolved server package definition.
 */
export function createPackagePricingSnapshot(pkg: BillingCreditPackage): PackagePricingSnapshot {
  return {
    packageId: pkg.id,
    name: pkg.name,
    creditsAllocated: pkg.creditsAllocated,
    amountMinor: pkg.amountMinor,
    currency: pkg.currency,
    isTaxInclusive: pkg.isTaxInclusive,
    taxRatePercent: pkg.taxRatePercent,
    resolvedAt: new Date().toISOString(),
    catalogSource: "server_provisional",
    metadata: pkg.metadata,
  };
}
