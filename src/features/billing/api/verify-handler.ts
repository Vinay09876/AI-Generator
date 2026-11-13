/**
 * Browser Payment Verification API Handler (Stage 10 Batch 3).
 *
 * Route: POST /api/billing/verify
 *
 * Security:
 * - Enforces NextAuth session authentication; callers can only verify their own orders.
 * - CSRF origin validation against resolveTrustedOrigins().
 * - Sliding window rate limiting (20 req/min per user).
 * - Cryptographically verifies the checkout payment signature (HMAC-SHA256).
 * - Never credits a wallet based on a client-supplied success flag alone.
 * - Delegates directly to shared settlePaymentOrder primitive.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isTrustedOrigin, resolveTrustedOrigins } from "@/lib/api";
import { defaultRateLimiter } from "@/lib/rate-limit";
import { getPaymentOrder } from "../orders";
import { settlePaymentOrder } from "../settlement";
import { MockPaymentGatewayEngine } from "../mock-gateway";
import { getPurchaseAvailability } from "../availability";
import { OrderNotFoundError } from "../types";
import type { BillingHandlerDeps } from "./orders-handler";

export interface VerifyPaymentRequestBody {
  orderId?: string;
  receipt?: string;
  gateway?: "mock" | "razorpay";
  gatewayOrderId: string;
  gatewayPaymentId: string;
  gatewaySignature: string;
}

export async function handleVerifyPaymentRequest(
  request: Request,
  deps?: BillingHandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 0. Purchases are disabled until a real gateway + webhook processing exist (see ../availability).
  const availability = getPurchaseAvailability();
  if (!availability.enabled) {
    return NextResponse.json(
      { error: availability.message, code: availability.code },
      { status: 503 },
    );
  }

  // 1. Origin Check (CSRF protection)
  const trustedOrigins = deps?.trustedOrigins ? deps.trustedOrigins() : resolveTrustedOrigins();
  if (process.env.NODE_ENV === "production" && !isTrustedOrigin(request, trustedOrigins)) {
    return NextResponse.json({ error: "Untrusted origin", code: "FORBIDDEN" }, { status: 403 });
  }

  // 2. Authentication Check
  let userId: string | null = null;
  if (deps?.getUserId) {
    userId = await deps.getUserId();
  } else {
    try {
      const session = await auth();
      userId = session?.user?.id ?? null;
    } catch {
      userId = null;
    }
  }
  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  // 3. Rate Limiting Check (20 verifications per minute per user)
  const rateLimit = defaultRateLimiter.check(`billing:verify-payment:${userId}`, {
    max: 20,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many verification requests. Please try again shortly.",
        code: "RATE_LIMITED",
        retryAfter: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  // 4. Request Body Validation
  let body: VerifyPaymentRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  const {
    orderId,
    receipt,
    gateway = "mock",
    gatewayOrderId,
    gatewayPaymentId,
    gatewaySignature,
  } = body;

  if (!orderId && !receipt) {
    return NextResponse.json(
      { error: "Either orderId or receipt must be provided", code: "INVALID_ARGUMENT" },
      { status: 400 },
    );
  }

  if (!gatewayOrderId || !gatewayPaymentId || !gatewaySignature) {
    return NextResponse.json(
      {
        error: "gatewayOrderId, gatewayPaymentId, and gatewaySignature are required",
        code: "INVALID_SIGNATURE_PAYLOAD",
      },
      { status: 400 },
    );
  }

  try {
    // 5. Look up the order and verify caller ownership
    const order = await getPaymentOrder({ id: orderId, receipt }, deps?.dbClient);
    if (order.userId !== userId) {
      return NextResponse.json(
        { error: "Forbidden: You can only verify your own payment orders.", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    // 6. Cryptographic Payment Signature Verification & Gateway Amount Resolution
    let isSignatureValid = false;
    let gatewayVerifiedAmountMinor: number | undefined;
    let gatewayVerifiedCurrency: string | undefined;

    if (gateway === "mock") {
      const mockEngine = deps?.mockEngine ?? new MockPaymentGatewayEngine();
      isSignatureValid = mockEngine.verifyPaymentSignature({
        gatewayOrderId,
        gatewayPaymentId,
        gatewaySignature,
      });

      const lookup = await mockEngine.lookupOrderByGatewayId(gatewayOrderId);
      if (lookup.found) {
        gatewayVerifiedAmountMinor = lookup.amountMinor;
        gatewayVerifiedCurrency = lookup.currency;
      }
    } else {
      // Future live Razorpay HMAC verification over `${gatewayOrderId}|${gatewayPaymentId}`
      return NextResponse.json(
        { error: "Live Razorpay verification not yet enabled in this phase.", code: "GATEWAY_UNAVAILABLE" },
        { status: 501 },
      );
    }

    if (!isSignatureValid) {
      return NextResponse.json(
        {
          error: "Cryptographic payment signature verification failed. Tampered payload rejected.",
          code: "INVALID_SIGNATURE",
        },
        { status: 400 },
      );
    }

    // 7. Settle Payment Order Atomically
    const settlement = await settlePaymentOrder(
      {
        orderId: order.id,
        gateway,
        gatewayOrderId,
        gatewayPaymentId,
        gatewaySignature,
        amountMinor: gatewayVerifiedAmountMinor,
        currency: gatewayVerifiedCurrency,
        source: "client_verify",
        metadata: {
          verifiedByUserId: userId,
          ip: request.headers.get("x-forwarded-for") ?? undefined,
          userAgent: request.headers.get("user-agent") ?? undefined,
        },
      },
      deps?.dbClient,
    );

    return NextResponse.json({
      success: settlement.success,
      orderId: settlement.orderId,
      status: settlement.status,
      creditsAllocated: settlement.creditsAllocated,
      balanceAfter: settlement.balanceAfter,
      alreadySettled: settlement.alreadySettled ?? false,
      requiresManualReview: settlement.requiresManualReview ?? false,
      reviewReason: settlement.reviewReason,
    });
  } catch (err: any) {
    if (err instanceof OrderNotFoundError || err?.code === "ORDER_NOT_FOUND") {
      return NextResponse.json(
        { error: "Payment order not found", code: "ORDER_NOT_FOUND" },
        { status: 404 },
      );
    }
    console.error("[api/billing/verify] Payment verification error:", err);
    return NextResponse.json(
      { error: "Payment verification failed", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
