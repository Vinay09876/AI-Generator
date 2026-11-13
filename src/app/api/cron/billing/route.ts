import { NextResponse } from "next/server";
import { isVideoCronRequestAuthorized } from "@/features/video/cron-auth";
import { reconcileStuckPaymentOrders } from "@/features/billing/reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isVideoCronRequestAuthorized(request, { CRON_SECRET: process.env.CRON_SECRET, NODE_ENV: process.env.NODE_ENV })) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const batchSizeStr = searchParams.get("batchSize");
  const stuckMinutesStr = searchParams.get("stuckMinutes");

  const batchSize = batchSizeStr ? parseInt(batchSizeStr, 10) : 25;
  const stuckMinutes = stuckMinutesStr ? parseInt(stuckMinutesStr, 10) : 15;

  try {
    const summary = await reconcileStuckPaymentOrders({
      batchSize: isNaN(batchSize) ? 25 : batchSize,
      stuckThresholdMinutes: isNaN(stuckMinutes) ? 15 : stuckMinutes,
    });

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary,
    });
  } catch (err: any) {
    console.error("[api/cron/billing] Billing sweep error:", err);
    return NextResponse.json(
      { error: "Billing sweep failed", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
