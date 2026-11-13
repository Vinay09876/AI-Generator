/**
 * Payment Order Reconciliation & Operational Recovery Service (Stage 10 Batch 6).
 *
 * Invariants & Guarantees:
 * 1. Single-Settlement Invariant: Reuses shared settlePaymentOrder, guaranteeing that
 *    wallet credits and ledger rows are inserted atomically and exactly once.
 * 2. Never Re-Authorizes Ambiguous Orders: When order creation at the gateway is uncertain
 *    (CREATION_UNKNOWN), reconciliation never blindly issues a new order; it checks
 *    the gateway by receipt reference and terminates as FAILED if absent.
 * 3. Parameter Discrepancy Escalation: Amount or currency mismatches are immediately
 *    escalated to NEEDS_REVIEW without crediting the wallet.
 * 4. Audit History Retention: All reconciliation events, reasons, and operator decisions
 *    are recorded in PaymentOrder.metadata.reconciliationHistory without exposing secrets.
 * 5. Mock / Test Gateway Isolation: Reconciles against MockPaymentGatewayEngine in dev/test;
 *    zero live network egress and ₹0 spend strictly enforced.
 */

import { prisma } from "@/lib/prisma";
import { PaymentOrderStatus, PaymentAttemptStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import {
  settlePaymentOrder,
  flagOrderForReview,
  recordPaymentFailure,
  type SettlementResult,
} from "./settlement";
import { MockPaymentGatewayEngine } from "./mock-gateway";
import { OrderNotFoundError } from "./types";

export interface ReconcileOrderOptions {
  operatorId?: string;
  resolutionAction?: "approve" | "reject";
  resolutionReason?: string;
  gatewayPaymentId?: string;
  maxAgeMinutes?: number;
  gatewayEngine?: MockPaymentGatewayEngine;
  metadata?: Record<string, unknown>;
}

export interface ReconcileOrderResult {
  success: boolean;
  orderId: string;
  previousStatus: PaymentOrderStatus;
  newStatus: PaymentOrderStatus;
  creditsAllocated: number;
  balanceAfter?: number;
  actionTaken:
  | "settled"
  | "already_settled"
  | "expired"
  | "failed"
  | "escalated_review"
  | "manual_approved"
  | "manual_rejected"
  | "no_action";
  reason?: string;
  reviewReason?: string;
  reconciliationAudit?: Record<string, unknown>;
  error?: string;
}

export interface ReconcileBatchOptions {
  stuckThresholdMinutes?: number;
  batchSize?: number;
  gateway?: "mock" | "razorpay";
  operatorId?: string;
  gatewayEngine?: MockPaymentGatewayEngine;
}

export interface ReconcileBatchSummary {
  totalChecked: number;
  settledCount: number;
  expiredCount: number;
  failedCount: number;
  reviewCount: number;
  noActionCount: number;
  results: ReconcileOrderResult[];
}

/**
 * Appends an audit entry to the order's metadata.reconciliationHistory without leaking secrets.
 */
function appendReconciliationAudit(
  existingMetadata: Record<string, unknown> | null | undefined,
  entry: {
    timestamp: string;
    action: string;
    previousStatus: string;
    newStatus: string;
    reason?: string;
    operatorId?: string;
  },
): Record<string, unknown> {
  const current = (existingMetadata ?? {}) as Record<string, unknown>;
  const history = Array.isArray(current.reconciliationHistory)
    ? [...current.reconciliationHistory]
    : [];

  history.push(entry);

  return {
    ...current,
    reconciliationHistory: history,
    lastReconciledAt: entry.timestamp,
  };
}

/**
 * Reconciles a single payment order against external gateway reality.
 */
export async function reconcilePaymentOrder(
  identifier: { orderId?: string; receipt?: string },
  options: ReconcileOrderOptions = {},
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ReconcileOrderResult> {
  const whereClause = identifier.orderId
    ? { id: identifier.orderId }
    : identifier.receipt
      ? { receipt: identifier.receipt }
      : null;

  if (!whereClause) {
    throw new Error("Either orderId or receipt must be provided for reconciliation.");
  }

  const order = await client.paymentOrder.findUnique({
    where: whereClause,
    include: { creditTransaction: true, attempts: true },
  });

  if (!order) {
    throw new OrderNotFoundError(identifier.orderId ?? identifier.receipt ?? "unknown");
  }

  const now = new Date();
  const maxAgeMinutes = options.maxAgeMinutes ?? 30;
  const maxAgeMs = maxAgeMinutes * 60_000;
  const isOlderThanThreshold = now.getTime() - order.createdAt.getTime() > maxAgeMs;

  const mockEngine =
  options.gatewayEngine !== undefined
    ? options.gatewayEngine
    : (order.gateway === "mock" ? new MockPaymentGatewayEngine({ supportsReceiptLookup: true }) : null);

  // -------------------------------------------------------------------------
  // 1. Order is already settled (PAID)
  // -------------------------------------------------------------------------
  if (order.status === PaymentOrderStatus.PAID) {
    return {
      success: true,
      orderId: order.id,
      previousStatus: PaymentOrderStatus.PAID,
      newStatus: PaymentOrderStatus.PAID,
      creditsAllocated: order.creditsAllocated,
      actionTaken: "already_settled",
      reason: "Order is already in PAID status with purchase credit transaction",
    };
  }

  // -------------------------------------------------------------------------
  // 2. Order is under manual review (NEEDS_REVIEW)
  // -------------------------------------------------------------------------
  if (order.status === PaymentOrderStatus.NEEDS_REVIEW) {
    // Requires explicit operator decision
    if (options.resolutionAction === "approve") {
      if (!options.operatorId || !options.resolutionReason) {
        throw new Error("Operator ID and resolution reason are required to approve an order under review.");
      }

      // Safeguard 1: Operator approval MUST NOT bypass payment verification.
      // Require verified gateway payment identity, captured status, exact amount, currency, and order association.
      let verifiedPaymentId: string | null = null;
      let verifiedGatewayOrderId: string | undefined = order.gatewayOrderId ?? undefined;
      let verifiedAmountMinor: number = order.totalAmountMinor;
      let verifiedCurrency: string = order.currency;
      let rejectionReason: string | null = null;
      let rejectionCode: string | null = null;

      if (mockEngine) {
        // Query the gateway authoritatively using gatewayOrderId or receipt
        try {
          const lookupTarget = order.gatewayOrderId ?? order.receipt;
          const lookup = order.gatewayOrderId
            ? await mockEngine.lookupOrderByGatewayId(order.gatewayOrderId)
            : await mockEngine.lookupOrderByReceipt(order.receipt);

          if (!lookup.found) {
            rejectionCode = "GATEWAY_ORDER_NOT_FOUND";
            rejectionReason = `Gateway confirms order ${lookupTarget} does not exist. Cannot approve without gateway order.`;
          } else if (lookup.status !== "PAID") {
            rejectionCode = "GATEWAY_PAYMENT_NOT_CAPTURED";
            rejectionReason = `Gateway reports order status is ${lookup.status}, not PAID. Cannot approve uncaptured payment.`;
          } else if (!lookup.gatewayPaymentId || typeof lookup.gatewayPaymentId !== "string" || lookup.gatewayPaymentId.trim().length === 0) {
            rejectionCode = "MISSING_GATEWAY_PAYMENT_ID";
            rejectionReason = "Gateway reports PAID status but payment ID is missing or malformed.";
          } else if (lookup.amountMinor !== undefined && lookup.amountMinor !== order.totalAmountMinor) {
            rejectionCode = "AMOUNT_MISMATCH";
            rejectionReason = `Gateway capture amount (${lookup.amountMinor}) does not match order total (${order.totalAmountMinor}). Cannot approve mismatched amount.`;
          } else if (lookup.currency && lookup.currency !== order.currency) {
            rejectionCode = "CURRENCY_MISMATCH";
            rejectionReason = `Gateway capture currency (${lookup.currency}) does not match order currency (${order.currency}). Cannot approve mismatched currency.`;
          } else if (order.gatewayOrderId && lookup.gatewayOrderId && lookup.gatewayOrderId !== order.gatewayOrderId) {
            rejectionCode = "GATEWAY_ORDER_MISMATCH";
            rejectionReason = `Gateway order ID (${lookup.gatewayOrderId}) does not match order gatewayOrderId (${order.gatewayOrderId}).`;
          } else {
            // Gateway evidence authoritatively verified
            verifiedPaymentId = lookup.gatewayPaymentId;
            verifiedGatewayOrderId = lookup.gatewayOrderId ?? verifiedGatewayOrderId;
            verifiedAmountMinor = lookup.amountMinor ?? verifiedAmountMinor;
            verifiedCurrency = lookup.currency ?? verifiedCurrency;
          }
        } catch (err: any) {
          rejectionCode = "AMBIGUOUS_GATEWAY_EVIDENCE";
          rejectionReason = `Gateway verification failed or timed out (${err?.message ?? "unknown error"}). Cannot approve during gateway ambiguity.`;
        }
      } else {
        // Gateway engine not provided. Check if order has an authentic captured attempt in the database
        const capturedAttempt = order.attempts?.find(
          (a) =>
            a.status === PaymentAttemptStatus.CAPTURED &&
            a.gatewayPaymentId &&
            typeof a.gatewayPaymentId === "string" &&
            !a.gatewayPaymentId.startsWith("rec_ovr_") &&
            a.amountMinor === order.totalAmountMinor &&
            a.currency === order.currency &&
            a.gateway === order.gateway &&
            (!order.gatewayOrderId || !a.gatewayOrderId || a.gatewayOrderId === order.gatewayOrderId),
        );

        if (capturedAttempt) {
          verifiedPaymentId = capturedAttempt.gatewayPaymentId!;
          verifiedGatewayOrderId = capturedAttempt.gatewayOrderId ?? verifiedGatewayOrderId;
          verifiedAmountMinor = capturedAttempt.amountMinor;
          verifiedCurrency = capturedAttempt.currency;
        } else if (
          order.gatewayPaymentId &&
          typeof order.gatewayPaymentId === "string" &&
          !order.gatewayPaymentId.startsWith("rec_ovr_")
        ) {
          verifiedPaymentId = order.gatewayPaymentId;
        } else {
          rejectionCode = "MISSING_GATEWAY_EVIDENCE";
          rejectionReason = "No verified gateway capture evidence found. Gateway engine is not configured and no captured attempt exists.";
        }
      }

      // If gateway evidence is missing, ambiguous, or mismatched -> REJECT APPROVAL
      if (!verifiedPaymentId || rejectionCode) {
        const finalCode = rejectionCode ?? "MISSING_GATEWAY_EVIDENCE";
        const finalReason = rejectionReason ?? "Missing verified gateway capture payment identity.";

        const rejectAudit = {
          timestamp: now.toISOString(),
          action: "approval_rejected",
          previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
          newStatus: PaymentOrderStatus.NEEDS_REVIEW,
          operatorId: options.operatorId,
          reason: `Approval rejected: ${finalReason}`,
          reviewReason: finalCode,
        };

        const updatedMeta = appendReconciliationAudit(order.metadata as any, rejectAudit);
        await client.paymentOrder.update({
          where: { id: order.id },
          data: { metadata: updatedMeta as any },
        });

        return {
          success: false,
          orderId: order.id,
          previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
          newStatus: PaymentOrderStatus.NEEDS_REVIEW,
          creditsAllocated: 0,
          actionTaken: "escalated_review",
          reviewReason: finalCode,
          reason: `Approval rejected: ${finalReason}`,
          reconciliationAudit: rejectAudit,
          error: `Cannot approve order without verified payment: ${finalReason}`,
        };
      }

      // All gateway evidence verified: proceed to atomic settlement
      const settlement = await settlePaymentOrder(
        {
          orderId: order.id,
          gateway: order.gateway as "mock" | "razorpay",
          gatewayPaymentId: verifiedPaymentId,
          gatewayOrderId: verifiedGatewayOrderId,
          amountMinor: verifiedAmountMinor,
          currency: verifiedCurrency,
          source: "reconciliation",
          allowReviewResolution: true,
          metadata: {
            approvedBy: options.operatorId,
            reason: options.resolutionReason,
            verifiedPaymentId,
          },
        },
        client,
      );

      if (!settlement.success) {
        // Settlement itself rejected (e.g. internal snapshot mismatch or database constraint)
        const rejectAudit = {
          timestamp: now.toISOString(),
          action: "approval_settlement_failed",
          previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
          newStatus: settlement.status,
          operatorId: options.operatorId,
          reason: `Settlement rejected by coordinator: ${settlement.error ?? "unknown"}`,
          reviewReason: settlement.reviewReason ?? "SETTLEMENT_REJECTED",
        };

        const updatedMeta = appendReconciliationAudit(order.metadata as any, rejectAudit);
        await client.paymentOrder.update({
          where: { id: order.id },
          data: { metadata: updatedMeta as any },
        });

        return {
          success: false,
          orderId: order.id,
          previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
          newStatus: settlement.status,
          creditsAllocated: 0,
          actionTaken: "escalated_review",
          reviewReason: settlement.reviewReason,
          reason: `Settlement rejected: ${settlement.error}`,
          reconciliationAudit: rejectAudit,
          error: settlement.error,
        };
      }

      const audit = {
        timestamp: now.toISOString(),
        action: "manual_approved",
        previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
        newStatus: PaymentOrderStatus.PAID,
        operatorId: options.operatorId,
        reason: options.resolutionReason,
        verifiedPaymentId,
      };

      const updatedMeta = appendReconciliationAudit(order.metadata as any, audit);
      await client.paymentOrder.update({
        where: { id: order.id },
        data: { metadata: updatedMeta as any },
      });

      return {
        success: true,
        orderId: order.id,
        previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
        newStatus: PaymentOrderStatus.PAID,
        creditsAllocated: order.creditsAllocated,
        balanceAfter: settlement.balanceAfter,
        actionTaken: "manual_approved",
        reason: options.resolutionReason,
        reconciliationAudit: audit,
      };
    }

    if (options.resolutionAction === "reject") {
      if (!options.operatorId || !options.resolutionReason) {
        throw new Error("Operator ID and resolution reason are required to reject an order under review.");
      }

      const audit = {
        timestamp: now.toISOString(),
        action: "manual_rejected",
        previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
        newStatus: PaymentOrderStatus.FAILED,
        operatorId: options.operatorId,
        reason: options.resolutionReason,
      };

      const updatedMeta = appendReconciliationAudit(order.metadata as any, audit);
      await client.paymentOrder.update({
        where: { id: order.id },
        data: {
          status: PaymentOrderStatus.FAILED,
          failedAt: now,
          metadata: updatedMeta as any,
        },
      });

      return {
        success: true,
        orderId: order.id,
        previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
        newStatus: PaymentOrderStatus.FAILED,
        creditsAllocated: 0,
        actionTaken: "manual_rejected",
        reason: options.resolutionReason,
        reconciliationAudit: audit,
      };
    }

    // No operator action provided: order must remain under review, never auto-settled
    return {
      success: false,
      orderId: order.id,
      previousStatus: PaymentOrderStatus.NEEDS_REVIEW,
      newStatus: PaymentOrderStatus.NEEDS_REVIEW,
      creditsAllocated: 0,
      actionTaken: "escalated_review",
      reviewReason: order.reviewReason ?? "NEEDS_REVIEW",
      reason: "Order is flagged for manual review and cannot be automatically settled without operator resolution",
    };
  }

  // -------------------------------------------------------------------------
  // 3. Ambiguous Order Creation (CREATION_UNKNOWN)
  // -------------------------------------------------------------------------
  if (order.status === PaymentOrderStatus.CREATION_UNKNOWN) {
    // Safeguard 2: CREATION_UNKNOWN lookup safety.
    // Distinguish authoritative gateway confirmation that an order does not exist
    // from lookup failures, timeouts, incomplete results, and ambiguous responses.
    // Only mark an order FAILED when non-creation is authoritatively confirmed.
    // Keep uncertain outcomes in NEEDS_REVIEW with an auditable reason.
    // Never retry ambiguous order creation automatically.

      if (!mockEngine) {
        // Gateway engine is not available to confirm non-creation.
        // Must keep in NEEDS_REVIEW. Never mark FAILED. Never retry.
        const audit = {
          timestamp: now.toISOString(),
          action: "review_uncertain_creation",
          previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
          newStatus: PaymentOrderStatus.NEEDS_REVIEW,
          reason: "Gateway engine not configured to verify order creation. Kept under manual review without automatic retry.",
        };

        const updatedMeta = appendReconciliationAudit(order.metadata as any, audit);
        await client.paymentOrder.update({
          where: { id: order.id },
          data: {
            status: PaymentOrderStatus.NEEDS_REVIEW,
            reviewReason: "GATEWAY_UNAVAILABLE_FOR_CREATION_CHECK",
            metadata: updatedMeta as any,
          },
        });

        return {
          success: false,
          orderId: order.id,
          previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
          newStatus: PaymentOrderStatus.NEEDS_REVIEW,
          creditsAllocated: 0,
          actionTaken: "escalated_review",
          reviewReason: "GATEWAY_UNAVAILABLE_FOR_CREATION_CHECK",
          reason: "Gateway not reachable to verify order creation; escalated to NEEDS_REVIEW without automatic retry",
          reconciliationAudit: audit,
        };
      }

        let lookup: any;
        try {
          lookup = await mockEngine.lookupOrderByReceipt(order.receipt);
        } catch (lookupErr: any) {
          // Lookup failed or timed out: this is NOT authoritative proof of non-creation!
          // Keep in NEEDS_REVIEW. Never mark FAILED. Never retry.
          const audit = {
            timestamp: now.toISOString(),
            action: "review_lookup_failure",
            previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
            newStatus: PaymentOrderStatus.NEEDS_REVIEW,
            reason: `Gateway order lookup failed or timed out (${lookupErr?.message ?? "unknown error"}). Kept under manual review without automatic retry.`,
          };

          const updatedMeta = appendReconciliationAudit(order.metadata as any, audit);
          await client.paymentOrder.update({
            where: { id: order.id },
            data: {
              status: PaymentOrderStatus.NEEDS_REVIEW,
              reviewReason: "CREATION_LOOKUP_FAILED",
              metadata: updatedMeta as any,
            },
          });

          return {
            success: false,
            orderId: order.id,
            previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
            newStatus: PaymentOrderStatus.NEEDS_REVIEW,
            creditsAllocated: 0,
            actionTaken: "escalated_review",
            reviewReason: "CREATION_LOOKUP_FAILED",
            reason: "Gateway order lookup failed or timed out; escalated to NEEDS_REVIEW without automatic retry",
            reconciliationAudit: audit,
          };
        }

        // Authoritative check 1: Non-existence confirmed authoritatively by gateway
        if (!lookup || lookup.found === false) {
          // Gateway authoritatively confirmed the order does not exist in its records.
          // Safe to terminate as FAILED without creating duplicate orders.
          const audit = {
            timestamp: now.toISOString(),
            action: "failed_uncreated_order",
            previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
            newStatus: PaymentOrderStatus.FAILED,
            reason: "Gateway authoritatively confirmed order was never created. Safely terminated without retry.",
          };

          const updatedMeta = appendReconciliationAudit(order.metadata as any, audit);
          await client.paymentOrder.update({
            where: { id: order.id },
            data: {
              status: PaymentOrderStatus.FAILED,
              failedAt: now,
              reviewReason: "GATEWAY_ORDER_NOT_FOUND",
              metadata: updatedMeta as any,
            },
          });

          return {
            success: true,
            orderId: order.id,
            previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
            newStatus: PaymentOrderStatus.FAILED,
            creditsAllocated: 0,
            actionTaken: "failed",
            reason: "Order does not exist on gateway. Safely terminated without blind re-creation.",
            reconciliationAudit: audit,
          };
        }

          // Authoritative check 2: Gateway found order, but response is incomplete or ambiguous
          if (!lookup.gatewayOrderId || typeof lookup.gatewayOrderId !== "string") {
            const audit = {
              timestamp: now.toISOString(),
              action: "review_incomplete_gateway_data",
              previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
              newStatus: PaymentOrderStatus.NEEDS_REVIEW,
              reason: "Gateway reported order found but gatewayOrderId is missing. Escalated to manual review.",
            };

            const updatedMeta = appendReconciliationAudit(order.metadata as any, audit);
            await client.paymentOrder.update({
              where: { id: order.id },
              data: {
                status: PaymentOrderStatus.NEEDS_REVIEW,
                reviewReason: "INCOMPLETE_GATEWAY_RESPONSE",
                metadata: updatedMeta as any,
              },
            });

            return {
              success: false,
              orderId: order.id,
              previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
              newStatus: PaymentOrderStatus.NEEDS_REVIEW,
              creditsAllocated: 0,
              actionTaken: "escalated_review",
              reviewReason: "INCOMPLETE_GATEWAY_RESPONSE",
              reason: "Gateway returned incomplete order data; escalated to NEEDS_REVIEW",
              reconciliationAudit: audit,
            };
          }

          const resolvedGatewayOrderId = lookup.gatewayOrderId;

          // Authoritative check 3: Order was created and payment was captured!
          if (lookup.status === "PAID" && lookup.gatewayPaymentId) {
            // Validate amount and currency before settling
            if (lookup.amountMinor !== undefined && lookup.amountMinor !== order.totalAmountMinor) {
              await flagOrderForReview(
                client,
                order.id,
                "AMOUNT_MISMATCH",
                `Gateway capture amount ${lookup.amountMinor} does not match order total ${order.totalAmountMinor}`,
                {
                  orderId: order.id,
                  gateway: order.gateway as "mock" | "razorpay",
                  gatewayPaymentId: lookup.gatewayPaymentId,
                  gatewayOrderId: resolvedGatewayOrderId,
                  amountMinor: lookup.amountMinor,
                  currency: lookup.currency,
                  source: "reconciliation",
                },
              );
              return {
                success: false,
                orderId: order.id,
                previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
                newStatus: PaymentOrderStatus.NEEDS_REVIEW,
                creditsAllocated: 0,
                actionTaken: "escalated_review",
                reviewReason: "AMOUNT_MISMATCH",
                reason: "Gateway payment amount differs from order total",
              };
            }

            if (lookup.currency && lookup.currency !== order.currency) {
              await flagOrderForReview(
                client,
                order.id,
                "CURRENCY_MISMATCH",
                `Gateway currency ${lookup.currency} does not match order currency ${order.currency}`,
                {
                  orderId: order.id,
                  gateway: order.gateway as "mock" | "razorpay",
                  gatewayPaymentId: lookup.gatewayPaymentId,
                  gatewayOrderId: resolvedGatewayOrderId,
                  amountMinor: lookup.amountMinor,
                  currency: lookup.currency,
                  source: "reconciliation",
                },
              );
              return {
                success: false,
                orderId: order.id,
                previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
                newStatus: PaymentOrderStatus.NEEDS_REVIEW,
                creditsAllocated: 0,
                actionTaken: "escalated_review",
                reviewReason: "CURRENCY_MISMATCH",
                reason: "Gateway payment currency differs from order currency",
              };
            }

            const settlement = await settlePaymentOrder(
              {
                orderId: order.id,
                receipt: order.receipt,
                gateway: order.gateway as "mock" | "razorpay",
                gatewayPaymentId: lookup.gatewayPaymentId,
                gatewayOrderId: resolvedGatewayOrderId,
                amountMinor: lookup.amountMinor,
                currency: lookup.currency,
                source: "reconciliation",
                metadata: {
                  reconciledFrom: "CREATION_UNKNOWN",
                  reconciledAt: now.toISOString(),
                },
              },
              client,
            );

            return {
              success: settlement.success,
              orderId: order.id,
              previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
              newStatus: settlement.status,
              creditsAllocated: settlement.creditsAllocated,
              balanceAfter: settlement.balanceAfter,
              actionTaken: settlement.success ? "settled" : "escalated_review",
              reviewReason: settlement.reviewReason,
              reason: "Discovered completed capture for ambiguous creation; settled cleanly",
            };
          }

          // Authoritative check 4: Gateway order exists but is unpaid: transition to CREATED with the resolved orderId
          await client.paymentOrder.update({
            where: { id: order.id },
            data: {
              status: PaymentOrderStatus.CREATED,
              gatewayOrderId: resolvedGatewayOrderId,
            },
          });

          return {
            success: true,
            orderId: order.id,
            previousStatus: PaymentOrderStatus.CREATION_UNKNOWN,
            newStatus: PaymentOrderStatus.CREATED,
            creditsAllocated: 0,
            actionTaken: "no_action",
            reason: "Confirmed gateway order existence; transitioned from CREATION_UNKNOWN to CREATED",
          };
        }

        // -------------------------------------------------------------------------
        // 4. In-Flight Orders (PENDING or CREATED)
        // -------------------------------------------------------------------------
        if (
          order.status === PaymentOrderStatus.PENDING ||
          order.status === PaymentOrderStatus.CREATED
        ) {
          const gwOrderId = order.gatewayOrderId;

          if (gwOrderId && mockEngine) {
            const lookup = await mockEngine.lookupOrderByGatewayId(gwOrderId);

            if (lookup.found) {
              // Case 4.1: Gateway confirms capture succeeded
              if (lookup.status === "PAID" && lookup.gatewayPaymentId) {
                // Amount/currency check
                if (lookup.amountMinor !== undefined && lookup.amountMinor !== order.totalAmountMinor) {
                  await flagOrderForReview(
                    client,
                    order.id,
                    "AMOUNT_MISMATCH",
                    `Gateway capture amount ${lookup.amountMinor} does not match order total ${order.totalAmountMinor}`,
                    {
                      orderId: order.id,
                      gateway: order.gateway as "mock" | "razorpay",
                      gatewayPaymentId: lookup.gatewayPaymentId,
                      gatewayOrderId: gwOrderId,
                      amountMinor: lookup.amountMinor,
                      currency: lookup.currency,
                      source: "reconciliation",
                    },
                  );
                  return {
                    success: false,
                    orderId: order.id,
                    previousStatus: order.status,
                    newStatus: PaymentOrderStatus.NEEDS_REVIEW,
                    creditsAllocated: 0,
                    actionTaken: "escalated_review",
                    reviewReason: "AMOUNT_MISMATCH",
                    reason: "Gateway payment amount differs from order total",
                  };
                }

                if (lookup.currency && lookup.currency !== order.currency) {
                  await flagOrderForReview(
                    client,
                    order.id,
                    "CURRENCY_MISMATCH",
                    `Gateway currency ${lookup.currency} does not match order currency ${order.currency}`,
                    {
                      orderId: order.id,
                      gateway: order.gateway as "mock" | "razorpay",
                      gatewayPaymentId: lookup.gatewayPaymentId,
                      gatewayOrderId: gwOrderId,
                      amountMinor: lookup.amountMinor,
                      currency: lookup.currency,
                      source: "reconciliation",
                    },
                  );
                  return {
                    success: false,
                    orderId: order.id,
                    previousStatus: order.status,
                    newStatus: PaymentOrderStatus.NEEDS_REVIEW,
                    creditsAllocated: 0,
                    actionTaken: "escalated_review",
                    reviewReason: "CURRENCY_MISMATCH",
                    reason: "Gateway payment currency differs from order currency",
                  };
                }

                // Matching capture: execute shared settlement
                const settlement = await settlePaymentOrder(
                  {
                    orderId: order.id,
                    gateway: order.gateway as "mock" | "razorpay",
                    gatewayPaymentId: lookup.gatewayPaymentId,
                    gatewayOrderId: gwOrderId,
                    amountMinor: lookup.amountMinor,
                    currency: lookup.currency,
                    source: "reconciliation",
                    metadata: {
                      reconciledFrom: order.status,
                      reconciledAt: now.toISOString(),
                    },
                  },
                  client,
                );

                return {
                  success: settlement.success,
                  orderId: order.id,
                  previousStatus: order.status,
                  newStatus: settlement.status,
                  creditsAllocated: settlement.creditsAllocated,
                  balanceAfter: settlement.balanceAfter,
                  actionTaken: "settled",
                  reason: "Gateway capture discovered and settled atomically",
                };
              }

              // Case 4.2: Gateway reports payment failed
              if (lookup.status === "FAILED") {
                await recordPaymentFailure(
                  {
                    orderId: order.id,
                    gateway: order.gateway as "mock" | "razorpay",
                    gatewayOrderId: gwOrderId,
                    errorCode: "GATEWAY_FAILURE",
                    errorMessage: "Gateway reported payment failure during reconciliation",
                  },
                  client,
                );

                return {
                  success: true,
                  orderId: order.id,
                  previousStatus: order.status,
                  newStatus: PaymentOrderStatus.FAILED,
                  creditsAllocated: 0,
                  actionTaken: "failed",
                  reason: "Gateway confirmed payment failure",
                };
              }
            }
          }

          // Case 4.3: Payment not captured. If past expiration threshold, expire order
          if (isOlderThanThreshold) {
            const audit = {
              timestamp: now.toISOString(),
              action: "expired_stuck_order",
              previousStatus: order.status,
              newStatus: PaymentOrderStatus.EXPIRED,
              reason: `Order exceeded active window of ${maxAgeMinutes} minutes without payment capture.`,
            };

            const updatedMeta = appendReconciliationAudit(order.metadata as any, audit);
            await client.paymentOrder.update({
              where: { id: order.id },
              data: {
                status: PaymentOrderStatus.EXPIRED,
                expiredAt: now,
                metadata: updatedMeta as any,
              },
            });

            return {
              success: true,
              orderId: order.id,
              previousStatus: order.status,
              newStatus: PaymentOrderStatus.EXPIRED,
              creditsAllocated: 0,
              actionTaken: "expired",
              reason: `Order expired after ${maxAgeMinutes} minutes without payment`,
              reconciliationAudit: audit,
            };
          }

          // Still within active checkout window
          return {
            success: true,
            orderId: order.id,
            previousStatus: order.status,
            newStatus: order.status,
            creditsAllocated: 0,
            actionTaken: "no_action",
            reason: `Order is within active checkout window (${Math.round((now.getTime() - order.createdAt.getTime()) / 60_000)}m / ${maxAgeMinutes}m)`,
          };
        }

        // Fallback for terminal states (FAILED, EXPIRED, REFUNDED)
        return {
          success: true,
          orderId: order.id,
          previousStatus: order.status,
          newStatus: order.status,
          creditsAllocated: 0,
          actionTaken: "no_action",
          reason: `Order is already in terminal state ${order.status}`,
        };
      }

      /**
       * Sweeps and reconciles multiple stuck or ambiguous payment orders.
       * Bounded execution prevents long-running transaction stalls.
       */
      export async function reconcileStuckPaymentOrders(
        options: ReconcileBatchOptions = {},
        client: Prisma.TransactionClient | typeof prisma = prisma,
      ): Promise<ReconcileBatchSummary> {
        const stuckMinutes = options.stuckThresholdMinutes ?? 15;
        const batchSize = Math.max(1, Math.min(options.batchSize ?? 25, 100));
        const thresholdDate = new Date(Date.now() - stuckMinutes * 60_000);

        const whereClause: Prisma.PaymentOrderWhereInput = {
          ...(options.gateway ? { gateway: options.gateway } : {}),
          OR: [
            {
              status: {
                in: [
                  PaymentOrderStatus.PENDING,
                  PaymentOrderStatus.CREATED,
                  PaymentOrderStatus.CREATION_UNKNOWN,
                ],
              },
              createdAt: { lt: thresholdDate },
            },
            {
              status: PaymentOrderStatus.NEEDS_REVIEW,
            },
          ],
        };

        const candidateOrders = await client.paymentOrder.findMany({
          where: whereClause,
          orderBy: { createdAt: "asc" },
          take: batchSize,
          select: { id: true, receipt: true, status: true },
        });

        const summary: ReconcileBatchSummary = {
          totalChecked: candidateOrders.length,
          settledCount: 0,
          expiredCount: 0,
          failedCount: 0,
          reviewCount: 0,
          noActionCount: 0,
          results: [],
        };

        for (const cand of candidateOrders) {
          try {
            const res = await reconcilePaymentOrder(
              { orderId: cand.id },
              {
                operatorId: options.operatorId,
                gatewayEngine: options.gatewayEngine,
                maxAgeMinutes: stuckMinutes,
              },
              client,
            );

            summary.results.push(res);

            if (res.actionTaken === "settled" || res.actionTaken === "manual_approved") {
              summary.settledCount++;
            } else if (res.actionTaken === "expired") {
              summary.expiredCount++;
            } else if (res.actionTaken === "failed" || res.actionTaken === "manual_rejected") {
              summary.failedCount++;
            } else if (res.actionTaken === "escalated_review") {
              summary.reviewCount++;
            } else {
              summary.noActionCount++;
            }
          } catch (err: any) {
            summary.results.push({
              success: false,
              orderId: cand.id,
              previousStatus: cand.status,
              newStatus: cand.status,
              creditsAllocated: 0,
              actionTaken: "no_action",
              error: String(err?.message ?? err),
            });
            summary.noActionCount++;
          }
        }

        return summary;
      }
