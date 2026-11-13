/**
 * Shared Payment Settlement Service & Lifecycle Coordinator (Stage 10 Batch 2).
 *
 * Enforces:
 * - Atomic transitions from PENDING/CREATED/CREATION_UNKNOWN to PAID inside a database transaction.
 * - Single-settlement guarantee: exactly one purchase credit transaction per PaymentOrder.
 * - Immediate escalation to NEEDS_REVIEW upon parameter mismatches (amount, currency, gateway).
 * - Safe late-capture handling for orders that previously timed out or expired.
 * - Idempotent deduplication across concurrent webhook deliveries and browser verifications.
 */

import { prisma } from "@/lib/prisma";
import { PaymentOrderStatus, PaymentAttemptStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { creditWalletForPurchase } from "@/features/credits/ledger";
import { BillingError, OrderNotFoundError } from "./types";

export interface SettlePaymentInput {
  /** Internal PaymentOrder.id or unique merchant receipt */
  orderId?: string;
  receipt?: string;
  /** Payment gateway provider ("mock" | "razorpay") */
  gateway: "mock" | "razorpay";
  /** External gateway capture/payment identifier */
  gatewayPaymentId: string;
  /** External gateway order identifier */
  gatewayOrderId?: string;
  /** Cryptographic HMAC signature from client checkout or webhook */
  gatewaySignature?: string;
  /** Verified minor units amount paid */
  amountMinor?: number;
  /** Verified ISO currency string */
  currency?: string;
  /** Settlement trigger source */
  source: "webhook" | "client_verify" | "reconciliation";
  /** Override flag when manually resolving an order under operator review */
  allowReviewResolution?: boolean;
  /** Audit metadata */
  metadata?: Record<string, unknown>;
}

export interface SettlementResult {
  success: boolean;
  orderId: string;
  status: PaymentOrderStatus;
  creditsAllocated: number;
  balanceAfter?: number;
  alreadySettled?: boolean;
  requiresManualReview?: boolean;
  reviewReason?: string;
  error?: string;
}

export interface RecordFailureInput {
  orderId?: string;
  receipt?: string;
  gateway: "mock" | "razorpay";
  gatewayPaymentId?: string;
  gatewayOrderId?: string;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Executes atomic settlement of a payment order.
 * Operates strictly within an ACID transaction.
 */
export async function settlePaymentOrder(
  input: SettlePaymentInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SettlementResult> {
  const whereClause = input.orderId
    ? { id: input.orderId }
    : input.receipt
      ? { receipt: input.receipt }
      : null;

  if (!whereClause) {
    throw new Error("Either orderId or receipt must be provided for settlement.");
  }

  if (
    !input.gatewayPaymentId ||
    typeof input.gatewayPaymentId !== "string" ||
    input.gatewayPaymentId.trim().length === 0
  ) {
    throw new BillingError("gatewayPaymentId must be a non-empty string", "INVALID_PAYMENT_ID", 400);
  }

  // 1. Fetch current order state
  const order = await client.paymentOrder.findUnique({
    where: whereClause,
    include: { creditTransaction: true },
  });

  if (!order) {
    throw new OrderNotFoundError(input.orderId ?? input.receipt ?? "unknown");
  }

  // 2. Enforce Gateway Consistency
  if (order.gateway !== input.gateway) {
    await flagOrderForReview(
      client,
      order.id,
      "GATEWAY_MISMATCH",
      `Expected gateway ${order.gateway}, received ${input.gateway}`,
      input,
    );
    return {
      success: false,
      orderId: order.id,
      status: PaymentOrderStatus.NEEDS_REVIEW,
      creditsAllocated: 0,
      requiresManualReview: true,
      reviewReason: "GATEWAY_MISMATCH",
      error: "Gateway mismatch detected",
    };
  }

  // 3. Enforce Currency & Amount Consistency
  if (input.currency && input.currency !== order.currency) {
    await flagOrderForReview(
      client,
      order.id,
      "CURRENCY_MISMATCH",
      `Expected currency ${order.currency}, received ${input.currency}`,
      input,
    );
    return {
      success: false,
      orderId: order.id,
      status: PaymentOrderStatus.NEEDS_REVIEW,
      creditsAllocated: 0,
      requiresManualReview: true,
      reviewReason: "CURRENCY_MISMATCH",
      error: "Currency mismatch detected",
    };
  }

  if (input.amountMinor !== undefined && input.amountMinor !== order.totalAmountMinor) {
    await flagOrderForReview(
      client,
      order.id,
      "AMOUNT_MISMATCH",
      `Expected total amount ${order.totalAmountMinor}, received ${input.amountMinor}`,
      input,
    );
    return {
      success: false,
      orderId: order.id,
      status: PaymentOrderStatus.NEEDS_REVIEW,
      creditsAllocated: 0,
      requiresManualReview: true,
      reviewReason: "AMOUNT_MISMATCH",
      error: "Amount mismatch detected",
    };
  }

  // 4. Enforce Immutable Server-Side Snapshot Consistency
  const snapshot = order.packageSnapshot as Record<string, unknown> | null;
  if (snapshot && typeof snapshot === "object") {
    const snapshotAmountMinor = typeof snapshot.amountMinor === "number" ? snapshot.amountMinor : undefined;
    const snapshotCurrency = typeof snapshot.currency === "string" ? snapshot.currency : undefined;
    const snapshotCredits = typeof snapshot.creditsAllocated === "number" ? snapshot.creditsAllocated : undefined;

    if (snapshotAmountMinor !== undefined && snapshotAmountMinor !== order.totalAmountMinor) {
      await flagOrderForReview(
        client,
        order.id,
        "SNAPSHOT_AMOUNT_MISMATCH",
        `Order totalAmountMinor ${order.totalAmountMinor} does not match snapshot amount ${snapshotAmountMinor}`,
        input,
      );
      return {
        success: false,
        orderId: order.id,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        creditsAllocated: 0,
        requiresManualReview: true,
        reviewReason: "SNAPSHOT_AMOUNT_MISMATCH",
        error: "Server-side package snapshot amount mismatch detected",
      };
    }

    if (snapshotCurrency && snapshotCurrency !== order.currency) {
      await flagOrderForReview(
        client,
        order.id,
        "SNAPSHOT_CURRENCY_MISMATCH",
        `Order currency ${order.currency} does not match snapshot currency ${snapshotCurrency}`,
        input,
      );
      return {
        success: false,
        orderId: order.id,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        creditsAllocated: 0,
        requiresManualReview: true,
        reviewReason: "SNAPSHOT_CURRENCY_MISMATCH",
        error: "Server-side package snapshot currency mismatch detected",
      };
    }

    if (snapshotCredits !== undefined && snapshotCredits !== order.creditsAllocated) {
      await flagOrderForReview(
        client,
        order.id,
        "SNAPSHOT_CREDITS_MISMATCH",
        `Order creditsAllocated ${order.creditsAllocated} does not match snapshot credits ${snapshotCredits}`,
        input,
      );
      return {
        success: false,
        orderId: order.id,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        creditsAllocated: 0,
        requiresManualReview: true,
        reviewReason: "SNAPSHOT_CREDITS_MISMATCH",
        error: "Server-side package snapshot credits mismatch detected",
      };
    }
  }

  // 4. Enforce Gateway Order ID Consistency if both are known
  if (
    input.gatewayOrderId &&
    order.gatewayOrderId &&
    input.gatewayOrderId !== order.gatewayOrderId
  ) {
    await flagOrderForReview(
      client,
      order.id,
      "GATEWAY_ORDER_MISMATCH",
      `Expected gatewayOrderId ${order.gatewayOrderId}, received ${input.gatewayOrderId}`,
      input,
    );
    return {
      success: false,
      orderId: order.id,
      status: PaymentOrderStatus.NEEDS_REVIEW,
      creditsAllocated: 0,
      requiresManualReview: true,
      reviewReason: "GATEWAY_ORDER_MISMATCH",
      error: "Gateway order ID mismatch detected",
    };
  }

  // 5. Handle Terminal or In-Progress States
  if (order.status === PaymentOrderStatus.PAID) {
    // If a different gatewayPaymentId is reported for an already PAID order, flag conflict!
    if (
      order.gatewayPaymentId &&
      input.gatewayPaymentId &&
      order.gatewayPaymentId !== input.gatewayPaymentId
    ) {
      await flagOrderForReview(
        client,
        order.id,
        "MULTIPLE_CAPTURES_DETECTED",
        `Order was already settled with payment ${order.gatewayPaymentId}; second capture ${input.gatewayPaymentId} reported`,
        input,
      );
      return {
        success: false,
        orderId: order.id,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        creditsAllocated: 0,
        requiresManualReview: true,
        reviewReason: "MULTIPLE_CAPTURES_DETECTED",
        error: "Multiple distinct payment captures reported for order",
      };
    }

    // Idempotent duplicate delivery: order is already settled cleanly
    const wallet = await client.creditWallet.findUnique({
      where: { userId: order.userId },
      select: { balance: true },
    });
    return {
      success: true,
      orderId: order.id,
      status: PaymentOrderStatus.PAID,
      creditsAllocated: order.creditsAllocated,
      balanceAfter: wallet?.balance,
      alreadySettled: true,
    };
  }

  // Late capture after failure or expiry: MUST NOT silently credit or discard
  if (
    order.status === PaymentOrderStatus.FAILED ||
    order.status === PaymentOrderStatus.EXPIRED
  ) {
    const reason =
      order.status === PaymentOrderStatus.FAILED
        ? "LATE_CAPTURE_AFTER_FAILURE"
        : "LATE_CAPTURE_AFTER_EXPIRY";
    await flagOrderForReview(
      client,
      order.id,
      reason,
      `Successful payment capture received after order was marked ${order.status}`,
      input,
    );
    return {
      success: false,
      orderId: order.id,
      status: PaymentOrderStatus.NEEDS_REVIEW,
      creditsAllocated: 0,
      requiresManualReview: true,
      reviewReason: reason,
      error: `Late capture received for ${order.status.toLowerCase()} order; escalated to manual review`,
    };
  }

  if (order.status === PaymentOrderStatus.NEEDS_REVIEW && !input.allowReviewResolution) {
    return {
      success: false,
      orderId: order.id,
      status: PaymentOrderStatus.NEEDS_REVIEW,
      creditsAllocated: 0,
      requiresManualReview: true,
      reviewReason: order.reviewReason ?? "NEEDS_REVIEW",
      error: "Order is under manual review and cannot be automatically settled",
    };
  }

  // 6. Execute Atomic State Transition & Credit Allocation
  // If client is top-level prisma, wrap in transaction; otherwise reuse caller tx
  const executeAtomic = async (tx: Prisma.TransactionClient) => {
    // Atomic guarded update ensuring transition occurs only once
    const updated = await tx.paymentOrder.updateMany({
      where: {
        id: order.id,
        status: {
          in: input.allowReviewResolution
            ? [
                PaymentOrderStatus.PENDING,
                PaymentOrderStatus.CREATED,
                PaymentOrderStatus.CREATION_UNKNOWN,
                PaymentOrderStatus.NEEDS_REVIEW,
              ]
            : [
                PaymentOrderStatus.PENDING,
                PaymentOrderStatus.CREATED,
                PaymentOrderStatus.CREATION_UNKNOWN,
              ],
        },
      },
      data: {
        status: PaymentOrderStatus.PAID,
        gatewayOrderId: input.gatewayOrderId ?? order.gatewayOrderId,
        gatewayPaymentId: input.gatewayPaymentId,
        gatewaySignature: input.gatewaySignature ?? order.gatewaySignature,
        paidAt: new Date(),
        updatedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      // Another worker settled concurrently
      const current = await tx.paymentOrder.findUnique({
        where: { id: order.id },
      });
      const wallet = await tx.creditWallet.findUnique({
        where: { userId: order.userId },
      });
      return {
        success: current?.status === PaymentOrderStatus.PAID,
        orderId: order.id,
        status: current?.status ?? PaymentOrderStatus.NEEDS_REVIEW,
        creditsAllocated: order.creditsAllocated,
        balanceAfter: wallet?.balance,
        alreadySettled: true,
      };
    }

    // Allocate purchase credits atomically
    const { balanceAfter } = await creditWalletForPurchase(tx, {
      userId: order.userId,
      paymentOrderId: order.id,
      creditsAllocated: order.creditsAllocated,
      description: `Purchase: ${order.packageId} (${order.creditsAllocated} credits)`,
    });

    // Record successful capture attempt
    await tx.paymentAttempt.create({
      data: {
        orderId: order.id,
        gateway: input.gateway,
        gatewayOrderId: input.gatewayOrderId ?? order.gatewayOrderId,
        gatewayPaymentId: input.gatewayPaymentId,
        status: PaymentAttemptStatus.CAPTURED,
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        metadata: {
          source: input.source,
          settledAt: new Date().toISOString(),
          ...(input.metadata ?? {}),
        } as any,
      },
    });

    return {
      success: true,
      orderId: order.id,
      status: PaymentOrderStatus.PAID,
      creditsAllocated: order.creditsAllocated,
      balanceAfter,
      alreadySettled: false,
    };
  };

  if ("$transaction" in client) {
    return await (client as typeof prisma).$transaction(async (tx) => executeAtomic(tx));
  }
  return await executeAtomic(client as Prisma.TransactionClient);
}

/**
 * Records a payment failure notification from gateway webhook or checkout decline.
 */
export async function recordPaymentFailure(
  input: RecordFailureInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ orderId: string; status: PaymentOrderStatus; recorded: boolean }> {
  const whereClause = input.orderId
    ? { id: input.orderId }
    : input.receipt
      ? { receipt: input.receipt }
      : null;

  if (!whereClause) {
    throw new Error("Either orderId or receipt must be provided.");
  }

  const order = await client.paymentOrder.findUnique({
    where: whereClause,
  });
  if (!order) {
    throw new OrderNotFoundError(input.orderId ?? input.receipt ?? "unknown");
  }

  // If already paid, do NOT transition to FAILED: flag for review
  if (order.status === PaymentOrderStatus.PAID) {
    await flagOrderForReview(
      client,
      order.id,
      "FAILURE_NOTIFICATION_AFTER_PAID",
      `Received failure notification (${input.errorMessage}) for already settled order`,
      input,
    );
    return { orderId: order.id, status: PaymentOrderStatus.NEEDS_REVIEW, recorded: false };
  }

  // Transition to FAILED if currently pending/created
  if (
    order.status === PaymentOrderStatus.PENDING ||
    order.status === PaymentOrderStatus.CREATED ||
    order.status === PaymentOrderStatus.CREATION_UNKNOWN
  ) {
    await client.paymentOrder.update({
      where: { id: order.id },
      data: {
        status: PaymentOrderStatus.FAILED,
        failedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await client.paymentAttempt.create({
      data: {
        orderId: order.id,
        gateway: input.gateway,
        gatewayOrderId: input.gatewayOrderId ?? order.gatewayOrderId,
        gatewayPaymentId: input.gatewayPaymentId,
        status: PaymentAttemptStatus.FAILED,
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        metadata: (input.metadata ?? {}) as any,
      },
    });

    return { orderId: order.id, status: PaymentOrderStatus.FAILED, recorded: true };
  }

  return { orderId: order.id, status: order.status, recorded: false };
}

/**
 * Marks an uncompleted order as EXPIRED after its session window elapses.
 */
export async function expirePaymentOrder(
  orderId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ orderId: string; status: PaymentOrderStatus }> {
  const order = await client.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new OrderNotFoundError(orderId);

  if (
    order.status === PaymentOrderStatus.PENDING ||
    order.status === PaymentOrderStatus.CREATED ||
    order.status === PaymentOrderStatus.CREATION_UNKNOWN
  ) {
    await client.paymentOrder.update({
      where: { id: orderId },
      data: {
        status: PaymentOrderStatus.EXPIRED,
        expiredAt: new Date(),
        updatedAt: new Date(),
      },
    });
    return { orderId, status: PaymentOrderStatus.EXPIRED };
  }

  return { orderId, status: order.status };
}

/**
 * Helper: Transitions an order to NEEDS_REVIEW with an audit reason and records an attempt.
 */
export async function flagOrderForReview(
  client: Prisma.TransactionClient | typeof prisma,
  orderId: string,
  reviewReason: string,
  description: string,
  input: SettlePaymentInput | RecordFailureInput,
) {
  const current = await client.paymentOrder.findUnique({
    where: { id: orderId },
    select: { gatewayPaymentId: true },
  });

  await client.paymentOrder.update({
    where: { id: orderId },
    data: {
      status: PaymentOrderStatus.NEEDS_REVIEW,
      reviewReason,
      // Retain existing gatewayPaymentId if already present to preserve audit history and prevent index collisions
      gatewayPaymentId: current?.gatewayPaymentId ?? input.gatewayPaymentId,
      metadata: {
        reviewDescription: description,
        flaggedAt: new Date().toISOString(),
        inputPayload: input as any,
      },
      updatedAt: new Date(),
    },
  });
}
