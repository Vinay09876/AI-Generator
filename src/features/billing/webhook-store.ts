/**
 * Durable Payment Webhook Store & Worker Lifecycle Coordinator (Stage 10 Batch 2).
 *
 * Responsibilities:
 * - Persists verified incoming payment gateway webhooks durably before asynchronous settlement.
 * - Idempotently rejects duplicate gateway event IDs via @@unique([gateway, eventId]).
 * - Provides atomic lease-based event claiming with crash recovery for background worker processing.
 * - Manages bounded retry schedules and escalation to terminal failure states.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

export interface RecordWebhookInput {
  gateway: "mock" | "razorpay";
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ClaimBatchInput {
  gateway?: "mock" | "razorpay";
  batchSize?: number;
  leaseDurationMs?: number;
  workerToken?: string;
}

export interface FailEventInput {
  id: string;
  workerToken?: string;
  errorMessage: string;
  maxAttempts?: number;
}

/**
 * Persists an incoming gateway webhook payload durably.
 * Idempotently rejects duplicate deliveries for the same gateway eventId.
 */
export async function recordPaymentWebhookEvent(
  input: RecordWebhookInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ recorded: boolean; duplicate: boolean; id?: string; eventId: string }> {
  try {
    const event = await client.paymentWebhookEvent.create({
      data: {
        gateway: input.gateway,
        eventId: input.eventId,
        eventType: input.eventType,
        payload: input.payload as any,
        status: WebhookEventStatus.PENDING,
      },
    });
    return { recorded: true, duplicate: false, id: event.id, eventId: event.eventId };
  } catch (err: any) {
    // Unique constraint violation on [gateway, eventId]
    if (err?.code === "P2002" || String(err).includes("Unique constraint")) {
      const existing = await client.paymentWebhookEvent.findUnique({
        where: {
          gateway_eventId: {
            gateway: input.gateway,
            eventId: input.eventId,
          },
        },
        select: { id: true, eventId: true },
      });
      return {
        recorded: false,
        duplicate: true,
        id: existing?.id,
        eventId: input.eventId,
      };
    }
    throw err;
  }
}

/**
 * Claims a batch of pending or expired webhook events for background worker execution.
 * Uses atomic leases to prevent race conditions across parallel workers.
 */
export async function claimPaymentWebhookBatch(
  input: ClaimBatchInput = {},
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 10, 50));
  const leaseDurationMs = input.leaseDurationMs ?? 30_000;
  const workerToken = input.workerToken ?? `wrk_${randomBytes(8).toString("hex")}`;
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  const whereClause: Prisma.PaymentWebhookEventWhereInput = {
    ...(input.gateway ? { gateway: input.gateway } : {}),
    OR: [
      { status: WebhookEventStatus.PENDING },
      {
        status: WebhookEventStatus.PROCESSING,
        leaseExpiresAt: { lt: now },
      },
    ],
  };

  // Find candidate event IDs ordered by creation time
  const candidates = await client.paymentWebhookEvent.findMany({
    where: whereClause,
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: { id: true },
  });

  if (candidates.length === 0) {
    return { workerToken, events: [] };
  }

  const ids = candidates.map((c) => c.id);

  // Atomically claim candidate rows
  await client.paymentWebhookEvent.updateMany({
    where: {
      id: { in: ids },
      OR: [
        { status: WebhookEventStatus.PENDING },
        { status: WebhookEventStatus.PROCESSING, leaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      status: WebhookEventStatus.PROCESSING,
      processingToken: workerToken,
      leaseExpiresAt,
      attempts: { increment: 1 },
      updatedAt: now,
    },
  });

  // Return the successfully claimed events
  const claimed = await client.paymentWebhookEvent.findMany({
    where: {
      id: { in: ids },
      processingToken: workerToken,
      status: WebhookEventStatus.PROCESSING,
    },
    orderBy: { createdAt: "asc" },
  });

  return { workerToken, events: claimed };
}

/**
 * Marks a claimed webhook event as successfully PROCESSED and clears the lease.
 */
export async function completePaymentWebhookEvent(
  id: string,
  workerToken?: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return await client.paymentWebhookEvent.updateMany({
    where: {
      id,
      ...(workerToken ? { processingToken: workerToken } : {}),
      status: WebhookEventStatus.PROCESSING,
    },
    data: {
      status: WebhookEventStatus.PROCESSED,
      processingToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    },
  });
}

/**
 * Marks a claimed webhook event as failed.
 * Escalates to FAILED if maximum attempts are exceeded, otherwise resets to PENDING for retry.
 */
export async function failPaymentWebhookEvent(
  input: FailEventInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const maxAttempts = input.maxAttempts ?? 5;
  const event = await client.paymentWebhookEvent.findUnique({
    where: { id: input.id },
    select: { attempts: true },
  });

  if (!event) return { updated: false };

  const isTerminal = event.attempts >= maxAttempts;
  const nextStatus = isTerminal ? WebhookEventStatus.FAILED : WebhookEventStatus.PENDING;

  await client.paymentWebhookEvent.update({
    where: { id: input.id },
    data: {
      status: nextStatus,
      lastError: input.errorMessage.slice(0, 2000),
      processingToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    },
  });

  return { updated: true, isTerminal, nextStatus };
}
