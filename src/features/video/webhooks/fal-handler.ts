import { persistVerifiedWebhookEvent } from "@/features/video/webhooks/durable-events";
import { verifyFalWebhookSignature } from "@/features/video/webhooks/fal-verify";
import { verifyWebhookCorrelationToken } from "@/features/video/webhooks/correlation";
import { processVideoWebhookEvent } from "@/features/video/webhooks/process-event";
import { getObjectStorage } from "@/features/generations/storage";
import { SupabaseVideoObjectStorage } from "@/features/video/storage/supabase";

export interface FalWebhookRouteContext {
  params?: Promise<Record<string, string | string[]>>;
  db?: any;
  storage?: any;
}

/**
 * Fal.ai Video Webhook Handler.
 *
 * Implements durable ingestion architecture:
 *   1. Cryptographic Ed25519 signature verification on raw request body bytes.
 *   2. Timestamp freshness and replay protection (within +/- 300 seconds).
 *   3. Rejection of unverified requests (HTTP 401).
 *   4. Durable persistence into ProviderWebhookEvent table BEFORE acknowledging receipt.
 *   5. Idempotent duplicate delivery deduplication on requestId (HTTP 200).
 *   6. Fast ACK (< 200ms) with HTTP 200 to satisfy Fal.ai delivery timeouts.
 *   7. HTTP 500 on database write failure to trigger provider exponential retry.
 *   8. Asynchronous background event processing with leased worker claims.
 */
export async function handleFalWebhookRequest(request: Request, context?: FalWebhookRouteContext) {
  try {
    const rawBuffer = Buffer.from(await request.arrayBuffer());

    // Extract headers as lowercase map
    const headers: Record<string, string | undefined> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // 1. Verify Ed25519 cryptographic signature
    const verification = await verifyFalWebhookSignature({
      rawBody: rawBuffer,
      headers,
    });

    if (!verification.valid) {
      console.warn("[fal-webhook] Signature verification failed:", verification.error);
      return Response.json(
        { error: "Invalid webhook signature", reason: verification.error },
        { status: 401 },
      );
    }

    const deliveryRequestId = verification.requestId!;

    // 2. Parse payload safely after cryptographic verification
    let payloadJson: Record<string, unknown>;
    try {
      payloadJson = JSON.parse(rawBuffer.toString("utf-8"));
    } catch {
      return Response.json({ error: "Malformed JSON payload" }, { status: 400 });
    }

    // 3. Validate payload identity and check for header/body mismatch
    const bodyRequestId = typeof payloadJson.request_id === "string" ? payloadJson.request_id.trim() : null;
    if (!bodyRequestId) {
      return Response.json(
        { error: "Malformed payload: missing or invalid request_id in body" },
        { status: 400 },
      );
    }

    if (bodyRequestId !== deliveryRequestId) {
      console.warn(
        `[fal-webhook] Identity mismatch: Header X-Fal-Webhook-Request-Id (${deliveryRequestId}) does not match body request_id (${bodyRequestId})`,
      );
      return Response.json(
        {
          error: "Identity mismatch",
          message: `Header X-Fal-Webhook-Request-Id does not match body request_id`,
        },
        { status: 400 },
      );
    }

    // Extract optional jobId and correlation token query parameters (passed in fal_webhook query string for recovery)
    let correlatedJobId: string | null = null;
    let correlationToken: string | null = null;
    try {
      const url = new URL(request.url);
      correlatedJobId = url.searchParams.get("jobId")?.trim() || null;
      correlationToken = url.searchParams.get("token")?.trim() || null;
    } catch {
      // URL parsing fallback
    }

    // Security Guard: If a jobId is passed in query parameters, a cryptographically
    // bound correlation token is MANDATORY and must be verified.
    // A valid Fal Ed25519 signature alone CANNOT authorize an attacker-controlled or modified jobId.
    if (correlatedJobId) {
      if (!correlationToken) {
        console.warn(`[fal-webhook] Missing correlation token for jobId=${correlatedJobId}`);
        return Response.json(
          {
            error: "Invalid correlation",
            message: "Query parameter 'token' is required when 'jobId' is provided.",
          },
          { status: 400 },
        );
      }

      const isValid = verifyWebhookCorrelationToken({
        token: correlationToken,
        jobId: correlatedJobId,
        provider: "fal-ai",
      });

      if (!isValid) {
        console.warn(`[fal-webhook] Correlation token verification failed for jobId=${correlatedJobId}`);
        return Response.json(
          {
            error: "Invalid correlation",
            message: "Correlation token verification failed.",
          },
          { status: 400 },
        );
      }
    }

    if (correlationToken) {
      (payloadJson as any)._correlationToken = correlationToken;
    }

    // 4. Durably persist event in database before returning ACK
    try {
      await persistVerifiedWebhookEvent({
        provider: "fal-ai",
        eventId: deliveryRequestId,
        jobId: correlatedJobId,
        payload: payloadJson,
        ...(context?.db ? { db: context.db } : {}),
      });
    } catch (dbErr) {
      console.error("[fal-webhook] Failed to durably persist webhook event:", dbErr);
      // Return 500 so Fal.ai retries with exponential backoff
      return Response.json(
        { error: "Database persistence failed; provider should retry" },
        { status: 500 },
      );
    }

    // 5. Trigger asynchronous processing (non-blocking best-effort execution)
    try {
      const storage = context?.storage ?? (getObjectStorage() as unknown as SupabaseVideoObjectStorage);
      processVideoWebhookEvent({
        eventId: deliveryRequestId,
        storage,
        ...(context?.db ? { db: context.db } : {}),
      }).catch((procErr) => {
        console.error(`[fal-webhook] Background event processing error for ${deliveryRequestId}:`, procErr);
      });
    } catch {
      // Storage initialization or worker trigger error does not fail the ACK
    }

    // 6. Fast ACK confirmed
    return Response.json(
      {
        received: true,
        requestId: deliveryRequestId,
      },
      { status: 200 },
    );
  } catch (err) {
    console.error("[fal-webhook] Unhandled webhook error:", err);
    return Response.json({ error: "Internal webhook processing error" }, { status: 500 });
  }
}

