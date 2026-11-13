/**
 * Payment Gateway Webhook API Handler (Stage 10 Batch 3).
 *
 * Route: POST /api/webhooks/payments/razorpay
 *
 * Security & Lifecycle:
 * - Reads raw request body as binary/text buffer.
 * - Verifies raw-body HMAC-SHA256 signature using timingSafeEqual.
 * - Rejects forged or tampered webhooks with HTTP 401 Unauthorized before parsing or storing.
 * - Persists verified events durably in PaymentWebhookEvent before Fast-ACK.
 * - Idempotently fast-acks duplicate deliveries with HTTP 200 without duplicate processing.
 * - Dispatches payload to shared settlePaymentOrder engine.
 */

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { defaultRateLimiter } from "@/lib/rate-limit";
import { recordPaymentWebhookEvent } from "../webhook-store";
import { processRecordedPaymentWebhookEvent } from "./processor";
import { getPurchaseAvailability, isMockGatewayAllowed } from "../availability";

/** Development/test-only default for the mock gateway. Never used when NODE_ENV=production. */
const DEV_ONLY_MOCK_WEBHOOK_SECRET = "mock_webhook_secret_dev";

export interface WebhookHandlerOptions {
  webhookSecret?: string;
  gateway?: "razorpay" | "mock";
  dbClient?: any;
}

/**
 * Verifies raw-body HMAC-SHA256 signature using constant-time comparison.
 */
export function verifyRawBodyHmacSha256(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!rawBody || !signature || !secret) return false;

  try {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");

    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

export async function handleRazorpayWebhookRequest(
  request: Request,
  options: WebhookHandlerOptions = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 0. While purchases are disabled (always in production until a real gateway ships), there are
  // no legitimate payment events: refuse before reading, verifying or storing anything.
  const availability = getPurchaseAvailability();
  if (!availability.enabled) {
    return NextResponse.json(
      { error: "Payment webhooks are not accepted while purchases are disabled.", code: availability.code },
      { status: 503 },
    );
  }

  // 1. IP Rate Limiting (120 webhook deliveries per minute per IP)
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown_ip";
  const rateLimit = defaultRateLimiter.check(`billing:webhook-ip:${clientIp}`, {
    max: 120,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many webhook requests from this IP", code: "RATE_LIMITED" },
      { status: 429 },
    );
  }

  // 2. Extract Raw Body Buffer
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Failed to read request body" }, { status: 400 });
  }

  // 3. Extract and Verify Cryptographic Signature
  const signature =
    request.headers.get("x-razorpay-signature") ||
    request.headers.get("x-mock-signature") ||
    "";

  const gateway = options.gateway ?? (request.headers.get("x-mock-signature") ? "mock" : "razorpay");

  // The mock gateway is a development/test fixture: in production it is rejected outright, before
  // any secret lookup, parsing or storage, so a forged "mock" event can never touch payment state.
  if (gateway === "mock" && !isMockGatewayAllowed()) {
    return NextResponse.json(
      { error: "Mock payment gateway is not accepted in production.", code: "GATEWAY_DISALLOWED" },
      { status: 403 },
    );
  }

  const secret =
    options.webhookSecret ??
    (gateway === "mock"
      ? process.env.MOCK_WEBHOOK_SECRET?.trim() || DEV_ONLY_MOCK_WEBHOOK_SECRET
      : process.env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? "");

  if (!secret) {
    console.error("[api/webhooks/payments] Webhook secret not configured for gateway:", gateway);
    return NextResponse.json(
      { error: "Webhook secret is not configured on the server", code: "SERVER_MISCONFIGURED" },
      { status: 500 },
    );
  }

  const isValid = verifyRawBodyHmacSha256(rawBody, signature, secret);
  if (!isValid) {
    return NextResponse.json(
      { error: "Cryptographic signature verification failed", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  // 4. Parse Verified JSON Payload
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "MALFORMED_JSON" }, { status: 400 });
  }

  const eventType = payload.event ?? payload.eventType ?? "payment.unknown";
  // Razorpay delivery ID or fallback composite ID
  const eventId =
    request.headers.get("x-razorpay-event-id") ||
    payload.id ||
    (payload.account_id ? `${payload.account_id}_${payload.created_at}_${eventType}` : null);

  if (!eventId) {
    return NextResponse.json(
      { error: "Missing unique event identifier in webhook payload", code: "MISSING_EVENT_ID" },
      { status: 400 },
    );
  }

  try {
    // 5. Durable Webhook Ingestion (Fast-ACK guarantee)
    const rec = await recordPaymentWebhookEvent(
      {
        gateway,
        eventId,
        eventType,
        payload,
      },
      options.dbClient,
    );

    // 6. If already recorded (duplicate delivery), fast-ack immediately without duplicate execution
    if (rec.duplicate) {
      return NextResponse.json(
        { received: true, duplicate: true, eventId },
        { status: 200 },
      );
    }

    // 7. Process the event inline under a lease. The row always ends PROCESSED, or back in PENDING
    // (retried by the /api/cron/billing sweep), or FAILED after max attempts — never stuck.
    if (rec.id) {
      await processRecordedPaymentWebhookEvent(rec.id, { dbClient: options.dbClient });
    }

    // 8. Return HTTP 200 Fast-ACK
    return NextResponse.json(
      { received: true, duplicate: false, eventId, eventRecordId: rec.id },
      { status: 200 },
    );
  } catch (err: any) {
    console.error("[api/webhooks/payments] Webhook persistence/processing error:", err);
    return NextResponse.json(
      { error: "Internal error processing verified webhook", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
