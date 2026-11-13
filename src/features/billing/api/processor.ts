/**
 * Payment Webhook Worker & Event Processor (Stage 10 Batch 3).
 *
 * Responsibilities:
 * - Claims durable webhook events using atomic leases with crash recovery.
 * - Dispatches payload events (e.g. payment.captured, payment.failed) to settlePaymentOrder.
 * - Handles bounded exponential backoff on transient errors and marks terminal states.
 * - Provides idempotent execution for duplicate webhook deliveries.
 */

import {
  claimPaymentWebhookBatch,
  claimPaymentWebhookEventById,
  completePaymentWebhookEvent,
  failPaymentWebhookEvent,
} from "../webhook-store";
import {
  settlePaymentOrder,
  recordPaymentFailure,
  type SettlementResult,
} from "../settlement";
import { WebhookEventStatus } from "@/generated/prisma/enums";

export interface ProcessWebhookResult {
  eventId: string;
  eventType: string;
  status: WebhookEventStatus;
  settlement?: SettlementResult;
  error?: string;
}

function sanitizeWebhookError(msg: string): string {
  return msg
    .replace(/(?:key|secret|token|password|auth|signature)=['"]?[^'"\s]+['"]?/gi, "$1=[REDACTED]")
    .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
}

/**
 * Processes a single claimed payment webhook event payload.
 */
export async function processPaymentWebhookEvent(
  event: {
    id: string;
    gateway: string;
    eventId: string;
    eventType: string;
    payload: any;
  },
  client?: any,
): Promise<ProcessWebhookResult> {
  const payload = event.payload;

  try {
    // 1. Successful payment capture (Razorpay / Mock)
    if (
      event.eventType === "payment.captured" ||
      event.eventType === "order.paid"
    ) {
      const paymentEntity = payload?.payload?.payment?.entity ?? payload?.payment ?? payload;
      const orderEntity = payload?.payload?.order?.entity ?? payload?.order;

      const gatewayPaymentId = paymentEntity?.id ?? paymentEntity?.gatewayPaymentId;
      const gatewayOrderId = paymentEntity?.order_id ?? orderEntity?.id ?? paymentEntity?.gatewayOrderId;
      const receipt = orderEntity?.receipt ?? paymentEntity?.receipt ?? payload?.receipt;
      const amountMinor = paymentEntity?.amount ?? paymentEntity?.amountMinor;
      const currency = paymentEntity?.currency;

      if (!gatewayPaymentId) {
        throw new Error(`Webhook payload missing payment ID for event ${event.eventId}`);
      }

      const settlement = await settlePaymentOrder(
        {
          orderId: payload?.orderId, // Optional direct internal ID if present
          receipt,
          gateway: event.gateway as "mock" | "razorpay",
          gatewayPaymentId,
          gatewayOrderId,
          amountMinor: typeof amountMinor === "number" ? amountMinor : undefined,
          currency,
          source: "webhook",
          metadata: {
            webhookEventId: event.eventId,
            receivedAt: new Date().toISOString(),
          },
        },
        client,
      );

      return {
        eventId: event.eventId,
        eventType: event.eventType,
        status: WebhookEventStatus.PROCESSED,
        settlement,
      };
    }

    // 2. Failed payment (Razorpay / Mock)
    if (event.eventType === "payment.failed") {
      const paymentEntity = payload?.payload?.payment?.entity ?? payload?.payment ?? payload;
      const orderEntity = payload?.payload?.order?.entity ?? payload?.order;

      const gatewayPaymentId = paymentEntity?.id ?? paymentEntity?.gatewayPaymentId;
      const gatewayOrderId = paymentEntity?.order_id ?? orderEntity?.id ?? paymentEntity?.gatewayOrderId;
      const receipt = orderEntity?.receipt ?? paymentEntity?.receipt ?? payload?.receipt;
      const errorCode = paymentEntity?.error_code ?? "PAYMENT_FAILED";
      const errorMessage = paymentEntity?.error_description ?? "Payment failed on gateway";

      await recordPaymentFailure(
        {
          orderId: payload?.orderId,
          receipt,
          gateway: event.gateway as "mock" | "razorpay",
          gatewayPaymentId,
          gatewayOrderId,
          errorCode,
          errorMessage,
          metadata: {
            webhookEventId: event.eventId,
          },
        },
        client,
      );

      return {
        eventId: event.eventId,
        eventType: event.eventType,
        status: WebhookEventStatus.PROCESSED,
      };
    }

    // Unhandled event type: mark processed so it does not block the queue
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      status: WebhookEventStatus.PROCESSED,
    };
  } catch (err: any) {
    const rawError = String(err?.message ?? err);
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      status: WebhookEventStatus.FAILED,
      error: sanitizeWebhookError(rawError),
    };
  }
}

/**
 * Claims and processes a batch of eligible payment webhook events.
 */
export async function processPendingPaymentWebhookBatch(options: {
  gateway?: "mock" | "razorpay";
  batchSize?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  dbClient?: any;
} = {}): Promise<{
  processedCount: number;
  failedCount: number;
  results: ProcessWebhookResult[];
}> {
  const { workerToken, events } = await claimPaymentWebhookBatch(
    {
      gateway: options.gateway,
      batchSize: options.batchSize ?? 10,
      leaseDurationMs: options.leaseDurationMs ?? 30_000,
    },
    options.dbClient,
  );

  if (events.length === 0) {
    return { processedCount: 0, failedCount: 0, results: [] };
  }

  const results: ProcessWebhookResult[] = [];
  let processedCount = 0;
  let failedCount = 0;

  for (const evt of events) {
    const res = await processAndSettleClaimedEvent(evt, workerToken, options.maxAttempts, options.dbClient);
    results.push(res);
    if (res.status === WebhookEventStatus.PROCESSED) processedCount++;
    else failedCount++;
  }

  return { processedCount, failedCount, results };
}

/**
 * Processes one claimed event and records the outcome on its row: PROCESSED on success, otherwise
 * back to PENDING for a later retry (or FAILED once maxAttempts is reached).
 */
async function processAndSettleClaimedEvent(
  evt: { id: string; gateway: string; eventId: string; eventType: string; payload: any },
  workerToken: string,
  maxAttempts: number | undefined,
  dbClient?: any,
): Promise<ProcessWebhookResult> {
  const res = await processPaymentWebhookEvent(evt, dbClient);
  if (res.status === WebhookEventStatus.PROCESSED) {
    await completePaymentWebhookEvent(evt.id, workerToken, dbClient);
  } else {
    await failPaymentWebhookEvent(
      {
        id: evt.id,
        workerToken,
        errorMessage: res.error ?? "Webhook processing failed",
        maxAttempts: maxAttempts ?? 5,
      },
      dbClient,
    );
  }
  return res;
}

/**
 * Inline processing for a webhook the current request just recorded. Claims the row under a lease
 * first, so a concurrent batch worker can never process the same event twice, and always leaves the
 * row in a terminal or retryable state. Returns null if the row was already claimed elsewhere.
 * Events that fail here stay PENDING and are retried by processPendingPaymentWebhookBatch, which
 * the /api/cron/billing sweep runs.
 */
export async function processRecordedPaymentWebhookEvent(
  id: string,
  options: { leaseDurationMs?: number; maxAttempts?: number; dbClient?: any } = {},
): Promise<ProcessWebhookResult | null> {
  const { workerToken, event } = await claimPaymentWebhookEventById(
    id,
    { leaseDurationMs: options.leaseDurationMs },
    options.dbClient,
  );
  if (!event) return null;
  return processAndSettleClaimedEvent(event as any, workerToken, options.maxAttempts, options.dbClient);
}
