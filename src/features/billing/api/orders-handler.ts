/**
 * Payment Order Creation API Handler (Stage 10 Batch 3).
 *
 * Route: POST /api/billing/orders
 *
 * Security:
 * - Enforces NextAuth session authentication.
 * - CSRF origin validation against resolveTrustedOrigins().
 * - Process-local sliding window rate limiting (10 req/min per user).
 * - Fails closed if mock gateway is requested in production.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isTrustedOrigin, resolveTrustedOrigins } from "@/lib/api";
import { defaultRateLimiter } from "@/lib/rate-limit";
import { createPaymentOrder, recordGatewayOrderAttempt } from "../orders";
import { MockPaymentGatewayEngine } from "../mock-gateway";
import {
  BillingError,
  MockGatewayDisallowedError,
  type PaymentCurrency,
} from "../types";
import {
  resolveServerCreditPackage,
  createPackagePricingSnapshot,
  type BillingCreditPackage,
} from "../packages";

export interface BillingHandlerDeps {
  getUserId?: () => Promise<string | null>;
  trustedOrigins?: () => readonly string[];
  dbClient?: any;
  mockEngine?: MockPaymentGatewayEngine;
  packageCatalog?: Record<string, BillingCreditPackage>;
}

export interface CreateOrderRequestBody {
  packageId: string;
  gateway?: "mock" | "razorpay";
  metadata?: Record<string, unknown>;
}

export async function handleCreateOrderRequest(
  request: Request,
  deps?: BillingHandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
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

  // 3. Rate Limiting Check (10 orders per minute per user)
  const rateLimit = defaultRateLimiter.check(`billing:create-order:${userId}`, {
    max: 10,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many order creation requests. Please try again shortly.",
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
  let body: CreateOrderRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  const { packageId, gateway = "mock", metadata } = body ?? {};

  // 4. Resolve Financial Values Exclusively from Server-Side Package Catalog
  let pkg: BillingCreditPackage;
  try {
    pkg = resolveServerCreditPackage(packageId, deps?.packageCatalog);
  } catch (err: any) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "Invalid package", code: "INVALID_PACKAGE" }, { status: 400 });
  }

  // 5. Enforce Mock Gateway Environment Isolation
  if (gateway === "mock" && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      {
        error: "Mock payment gateway is strictly disallowed in production.",
        code: "GATEWAY_DISALLOWED",
      },
      { status: 403 },
    );
  }

  try {
    // 6. Create Immutable Server-Side Package Snapshot
    const packageSnapshot = createPackagePricingSnapshot(pkg);

    // 7. Create PaymentOrder record in database with server-resolved values
    const order = await createPaymentOrder(
      {
        userId,
        packageId: pkg.id,
        creditsAllocated: pkg.creditsAllocated,
        amountMinor: pkg.amountMinor,
        currency: pkg.currency,
        isTaxInclusive: pkg.isTaxInclusive,
        taxRatePercent: pkg.taxRatePercent,
        gateway,
        packageSnapshot: packageSnapshot as unknown as Record<string, unknown>,
        metadata: {
          userAgent: request.headers.get("user-agent") ?? undefined,
          ip: request.headers.get("x-forwarded-for") ?? undefined,
          clientMetadata: metadata,
        },
      },
      deps?.dbClient,
    );

    // 8. Gateway Order Creation with Server-Resolved Financials
    let gatewayOrderId: string;
    let keyId: string;

    if (gateway === "mock") {
      const mockEngine = deps?.mockEngine ?? new MockPaymentGatewayEngine();
      const mockOrder = await mockEngine.createOrder({
        userId,
        packageId: pkg.id,
        creditsAllocated: pkg.creditsAllocated,
        amountMinor: order.totalAmountMinor,
        currency: order.currency as PaymentCurrency,
        receipt: order.receipt,
      });
      gatewayOrderId = mockOrder.gatewayOrderId;
      keyId = "mock_key_public_test";
    } else {
      // Future live Razorpay integration (Batch 4/Phase live)
      return NextResponse.json(
        { error: "Live Razorpay orders not yet enabled in this phase.", code: "GATEWAY_UNAVAILABLE" },
        { status: 501 },
      );
    }

    // 9. Record the gateway attempt and update order
    await recordGatewayOrderAttempt(order.id, gatewayOrderId, gateway, undefined, deps?.dbClient);

    return NextResponse.json(
      {
        orderId: order.id,
        receipt: order.receipt,
        gateway,
        gatewayOrderId,
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        creditsAllocated: order.creditsAllocated,
        keyId,
        packageSnapshot: order.packageSnapshot,
      },
      { status: 201 },
    );
  } catch (err: any) {
    if (err instanceof MockGatewayDisallowedError || err?.code === "GATEWAY_DISALLOWED") {
      return NextResponse.json(
        { error: err.message, code: "GATEWAY_DISALLOWED" },
        { status: 403 },
      );
    }
    console.error("[api/billing/orders] Order creation failed:", err);
    return NextResponse.json(
      { error: "Failed to create payment order", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
