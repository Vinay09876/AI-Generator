/**
 * Payment Order Management Primitives (Stage 10 Batch 2).
 *
 * Responsibilities:
 * - Creates durable PaymentOrder records with immutable package snapshots and tax calculations.
 * - Enforces integer minor-unit and currency rules.
 * - Records individual gateway checkout attempts in PaymentAttempt.
 * - Supports ambiguous order creation handling and receipt lookups.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { PaymentOrderStatus, PaymentAttemptStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { roundDivBigInt } from "./calculator";
import {
  isValidCurrency,
  PROVISIONAL_TAX_ASSUMPTIONS,
  type PaymentCurrency,
} from "./config";
import {
  BillingError,
  InvalidAmountError,
  InvalidCurrencyError,
  OrderNotFoundError,
} from "./types";

export interface CreatePaymentOrderInput {
  userId: string;
  packageId: string;
  creditsAllocated: number;
  amountMinor: number;
  currency?: PaymentCurrency;
  gateway?: "mock" | "razorpay";
  isTaxInclusive?: boolean;
  taxRatePercent?: number;
  receipt?: string;
  packageSnapshot: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function generateMerchantReceipt(prefix = "rcpt"): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(6).toString("hex");
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Creates a new PaymentOrder in PENDING status.
 * Evaluates tax liability using exact integer rational arithmetic.
 */
export async function createPaymentOrder(
  input: CreatePaymentOrderInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const currency = input.currency ?? "INR";
  if (!isValidCurrency(currency)) {
    throw new InvalidCurrencyError(currency);
  }

  if (!Number.isInteger(input.creditsAllocated) || input.creditsAllocated <= 0) {
    throw new BillingError("creditsAllocated must be a positive integer", "INVALID_CREDITS", 400);
  }

  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new InvalidAmountError(input.amountMinor);
  }

  const gateway = input.gateway ?? "mock";
  const isTaxInclusive = input.isTaxInclusive ?? true;
  const taxRatePercent = input.taxRatePercent ?? PROVISIONAL_TAX_ASSUMPTIONS.defaultTaxRatePercent;
  const receipt = input.receipt ?? generateMerchantReceipt();

  let baseAmountMinor: number;
  let taxAmountMinor: number;
  let totalAmountMinor: number;

  const grossBig = BigInt(input.amountMinor);

  if (isTaxInclusive) {
    if (taxRatePercent > 0) {
      const taxBp = BigInt(Math.round(taxRatePercent * 10_000));
      const denom = BigInt(1_000_000) + taxBp;
      baseAmountMinor = roundDivBigInt(grossBig * BigInt(1_000_000), denom);
      taxAmountMinor = input.amountMinor - baseAmountMinor;
      totalAmountMinor = input.amountMinor;
    } else {
      baseAmountMinor = input.amountMinor;
      taxAmountMinor = 0;
      totalAmountMinor = input.amountMinor;
    }
  } else {
    baseAmountMinor = input.amountMinor;
    const taxBp = BigInt(Math.round(taxRatePercent * 10_000));
    taxAmountMinor = roundDivBigInt(grossBig * taxBp, BigInt(1_000_000));
    totalAmountMinor = baseAmountMinor + taxAmountMinor;
  }

  return await client.paymentOrder.create({
    data: {
      userId: input.userId,
      receipt,
      packageId: input.packageId,
      packageSnapshot: input.packageSnapshot as any,
      creditsAllocated: input.creditsAllocated,
      currency,
      baseAmountMinor,
      taxAmountMinor,
      totalAmountMinor,
      status: PaymentOrderStatus.PENDING,
      gateway,
      metadata: (input.metadata ?? {}) as any,
    },
  });
}

/**
 * Records a gateway checkout order ID against a PaymentOrder and registers
 * an audit attempt row in PaymentAttempt.
 */
export async function recordGatewayOrderAttempt(
  orderId: string,
  gatewayOrderId: string,
  gateway: string,
  options?: {
    isAmbiguous?: boolean;
    metadata?: Record<string, unknown>;
  },
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const status = options?.isAmbiguous
    ? PaymentOrderStatus.CREATION_UNKNOWN
    : PaymentOrderStatus.CREATED;

  const order = await client.paymentOrder.update({
    where: { id: orderId },
    data: {
      gatewayOrderId,
      gateway,
      status,
      updatedAt: new Date(),
    },
  });

  await client.paymentAttempt.create({
    data: {
      orderId,
      gateway,
      gatewayOrderId,
      status: PaymentAttemptStatus.INITIATED,
      amountMinor: order.totalAmountMinor,
      currency: order.currency,
      metadata: (options?.metadata ?? {}) as any,
    },
  });

  return order;
}

/**
 * Queries a PaymentOrder by its internal ID or unique merchant receipt.
 */
export async function getPaymentOrder(
  identifier: { id?: string; receipt?: string },
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  if (identifier.id) {
    const order = await client.paymentOrder.findUnique({
      where: { id: identifier.id },
      include: {
        creditTransaction: true,
        attempts: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!order) throw new OrderNotFoundError(identifier.id);
    return order;
  }

  if (identifier.receipt) {
    const order = await client.paymentOrder.findUnique({
      where: { receipt: identifier.receipt },
      include: {
        creditTransaction: true,
        attempts: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!order) throw new OrderNotFoundError(identifier.receipt);
    return order;
  }

  throw new BillingError("Either id or receipt must be provided", "INVALID_ARGUMENT", 400);
}
