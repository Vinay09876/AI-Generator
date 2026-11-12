import { NextResponse } from "next/server";
import { PROVISIONAL_SERVER_CREDIT_PACKAGES } from "@/features/billing/packages";
import { INVOICE_CONFIG_DEFAULTS, PROVISIONAL_TAX_ASSUMPTIONS } from "@/features/billing/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const isRegisteredForGst = Boolean(
    INVOICE_CONFIG_DEFAULTS.supplierGstin && PROVISIONAL_TAX_ASSUMPTIONS.gstInvoiceEnabled,
  );

  const packages = Object.values(PROVISIONAL_SERVER_CREDIT_PACKAGES)
    .filter((pkg) => pkg.isActive)
    .map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      creditsAllocated: pkg.creditsAllocated,
      amountMinor: pkg.amountMinor,
      currency: pkg.currency,
      isTaxInclusive: isRegisteredForGst ? pkg.isTaxInclusive : false,
      taxRatePercent: isRegisteredForGst ? pkg.taxRatePercent : 0,
      metadata: pkg.metadata,
    }));

  return NextResponse.json({ packages });
}
