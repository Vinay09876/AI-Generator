import { NextResponse } from "next/server";
import { PROVISIONAL_SERVER_CREDIT_PACKAGES } from "@/features/billing/packages";

export const dynamic = "force-dynamic";

export async function GET() {
  const packages = Object.values(PROVISIONAL_SERVER_CREDIT_PACKAGES)
    .filter((pkg) => pkg.isActive)
    .map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      creditsAllocated: pkg.creditsAllocated,
      amountMinor: pkg.amountMinor,
      currency: pkg.currency,
      isTaxInclusive: pkg.isTaxInclusive,
      taxRatePercent: pkg.taxRatePercent,
      metadata: pkg.metadata,
    }));

  return NextResponse.json({ packages });
}
