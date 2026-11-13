/**
 * Authenticated Operator Payment Reconciliation API Handler (Stage 10 Batch 6).
 *
 * Route: POST /api/billing/reconcile
 *
 * Security & Access Control:
 * - NextAuth session authentication strictly required (401 UNAUTHORIZED).
 * - Operator / Admin authorization verification (403 FORBIDDEN for standard users).
 * - Rate limiting on reconciliation operations (30 req/min per operator).
 * - Never returns gateway private keys, webhooks secrets, or sensitive financial secrets.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isTrustedOrigin, resolveTrustedOrigins } from "@/lib/api";
import { defaultRateLimiter } from "@/lib/rate-limit";
import {
  reconcilePaymentOrder,
  reconcileStuckPaymentOrders,
  type ReconcileOrderResult,
  type ReconcileBatchSummary,
} from "../reconciliation";
import { MockPaymentGatewayEngine } from "../mock-gateway";
import { OrderNotFoundError } from "../types";

export interface ReconcileHandlerDeps {
  getUserId?: () => Promise<string | null>;
  isOperator?: (userId: string) => Promise<boolean> | boolean;
  trustedOrigins?: () => readonly string[];
  dbClient?: any;
  gatewayEngine?: MockPaymentGatewayEngine;
}

export interface ReconcileRequestBody {
  orderId?: string;
  receipt?: string;
  sweepBatch?: boolean;
  stuckThresholdMinutes?: number;
  resolutionAction?: "approve" | "reject";
  resolutionReason?: string;
}

function checkDefaultOperatorAuthorization(userId: string, sessionUser?: any): boolean {
  if (sessionUser?.role === "admin" || sessionUser?.role === "operator") {
    return true;
  }
  const adminIds = process.env.ADMIN_USER_IDS?.split(",").map((s) => s.trim()) ?? [];
  return adminIds.includes(userId);
}

export async function handleReconcileRequest(
  request: Request,
  deps?: ReconcileHandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return NextResponse.json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }

  // 1. Origin Check
  const trustedOrigins = deps?.trustedOrigins ? deps.trustedOrigins() : resolveTrustedOrigins();
  if (process.env.NODE_ENV === "production" && !isTrustedOrigin(request, trustedOrigins)) {
    return NextResponse.json({ error: "Untrusted origin", code: "FORBIDDEN" }, { status: 403 });
  }

  // 2. Authentication Check
  let userId: string | null = null;
  let sessionUser: any = null;
  if (deps?.getUserId) {
    userId = await deps.getUserId();
  } else {
    try {
      const session = await auth();
      userId = session?.user?.id ?? null;
      sessionUser = session?.user ?? null;
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return NextResponse.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 });
  }

  // 3. Operator Authorization Check
  let authorized = false;
  if (deps?.isOperator) {
    authorized = await deps.isOperator(userId);
  } else {
    authorized = checkDefaultOperatorAuthorization(userId, sessionUser);
  }

  if (!authorized) {
    return NextResponse.json(
      { error: "Operator or administrative privileges required", code: "FORBIDDEN" },
      { status: 403 },
    );
  }

  // 4. Rate Limiting Check (30 requests/min per operator)
  const rateLimit = defaultRateLimiter.check(`billing:reconcile:${userId}`, {
    max: 30,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many reconciliation requests. Please wait.", code: "RATE_LIMITED" },
      { status: 429 },
    );
  }

  // 5. Parse Request Body
  let body: ReconcileRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload", code: "BAD_REQUEST" }, { status: 400 });
  }

  try {
    // 6. Sweep Batch Mode
    if (body.sweepBatch) {
      const summary = await reconcileStuckPaymentOrders(
        {
          stuckThresholdMinutes: body.stuckThresholdMinutes ?? 15,
          operatorId: userId,
          gatewayEngine: deps?.gatewayEngine,
        },
        deps?.dbClient,
      );

      return NextResponse.json({ success: true, mode: "sweep", summary });
    }

    // 7. Single Order Reconciliation
    if (body.orderId || body.receipt) {
      const result = await reconcilePaymentOrder(
        { orderId: body.orderId, receipt: body.receipt },
        {
          operatorId: userId,
          resolutionAction: body.resolutionAction,
          resolutionReason: body.resolutionReason,
          gatewayEngine: deps?.gatewayEngine,
        },
        deps?.dbClient,
      );

      const status = result.success ? 200 : (body.resolutionAction ? 422 : 200);
      return NextResponse.json({ success: result.success, mode: "single", result }, { status });
    }

    return NextResponse.json(
      { error: "Either orderId, receipt, or sweepBatch must be specified", code: "BAD_REQUEST" },
      { status: 400 },
    );
  } catch (err: any) {
    if (err instanceof OrderNotFoundError) {
      return NextResponse.json({ error: err.message, code: "ORDER_NOT_FOUND" }, { status: 404 });
    }
    console.error("[api/billing/reconcile] Reconciliation error:", err);
    return NextResponse.json(
      { error: "Reconciliation operation failed", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
