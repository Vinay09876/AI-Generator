import { CreditTransactionType } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { AccountingError } from "@/features/generations/errors";

/**
 * Credit ledger primitives. They MUST run inside a caller-owned transaction so the
 * wallet change and its ledger entry commit (or roll back) together.
 */
type Tx = Prisma.TransactionClient;

export const jobDebitKey = (jobId: string) => `job-debit:${jobId}`;
export const jobRefundKey = (jobId: string) => `job-refund:${jobId}`;
export const paymentOrderCreditKey = (orderId: string) => `payment-order:${orderId}`;

/**
 * Atomic guarded debit: a single conditional UPDATE only matches when the balance covers
 * the amount, so concurrent debits can never take the wallet below zero (the
 * CreditWallet_balance_non_negative CHECK constraint is the database-level backstop).
 * The unique idempotencyKey makes a second debit for the same key impossible.
 */
export async function debitWallet(
  tx: Tx,
  params: { userId: string; amount: number; idempotencyKey: string; jobId?: string; description?: string },
) {
  const { userId, amount, idempotencyKey, jobId, description } = params;
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Debit amount must be a positive integer.");

  const rows = await tx.$queryRaw<{ id: string; balance: number }[]>`
    UPDATE "CreditWallet"
    SET "balance" = "balance" - ${amount}, "updatedAt" = now()
    WHERE "userId" = ${userId} AND "balance" >= ${amount}
    RETURNING "id", "balance"`;
  if (rows.length === 0) throw new AccountingError("INSUFFICIENT_CREDITS");

  const { id: walletId, balance } = rows[0];
  await tx.creditTransaction.create({
    data: {
      userId,
      walletId,
      jobId,
      type: CreditTransactionType.GENERATION_DEBIT,
      amount: -amount,
      balanceAfter: balance,
      description,
      idempotencyKey,
    },
  });
  return { walletId, balanceAfter: balance };
}

/**
 * Refund exactly what was debited for a job. Callers guard against double settlement by
 * transitioning the job's status in the same transaction; the unique `job-refund:<jobId>`
 * key is the backstop (a duplicate insert aborts the whole transaction, including the
 * balance increment). Returns null when the job has no debit to refund.
 */
export async function refundJobDebit(tx: Tx, params: { jobId: string; description?: string }) {
  const { jobId, description } = params;

  const debit = await tx.creditTransaction.findUnique({
    where: { idempotencyKey: jobDebitKey(jobId) },
    select: { userId: true, amount: true },
  });
  if (!debit) return null;

  const alreadyRefunded = await tx.creditTransaction.findUnique({
    where: { idempotencyKey: jobRefundKey(jobId) },
    select: { id: true },
  });
  if (alreadyRefunded) return { refunded: false as const, reason: "already-refunded" as const };

  const amount = Math.abs(debit.amount);
  const rows = await tx.$queryRaw<{ id: string; balance: number }[]>`
    UPDATE "CreditWallet"
    SET "balance" = "balance" + ${amount}, "updatedAt" = now()
    WHERE "userId" = ${debit.userId}
    RETURNING "id", "balance"`;
  if (rows.length === 0) throw new Error("Wallet not found for refund.");

  await tx.creditTransaction.create({
    data: {
      userId: debit.userId,
      walletId: rows[0].id,
      jobId,
      type: CreditTransactionType.REFUND,
      amount,
      balanceAfter: rows[0].balance,
      description,
      idempotencyKey: jobRefundKey(jobId),
    },
  });
  return { refunded: true as const, amount, balanceAfter: rows[0].balance };
}

/**
 * Atomic purchase-credit allocation primitive (Stage 10 Batch 2).
 * Operates strictly inside a caller-supplied database transaction.
 * Guarantees that wallet balance increment and PURCHASE ledger entry happen together.
 * The unique paymentOrderId on CreditTransaction enforces at database constraint level
 * that a payment order can only be credited once.
 */
export async function creditWalletForPurchase(
  tx: Tx,
  params: {
    userId: string;
    paymentOrderId: string;
    creditsAllocated: number;
    description?: string;
  },
) {
  const { userId, paymentOrderId, creditsAllocated, description } = params;
  if (!Number.isInteger(creditsAllocated) || creditsAllocated <= 0) {
    throw new Error("Purchase credit amount must be a positive integer.");
  }

  // Guard against duplicate credit transaction for this payment order
  const existingTx = await tx.creditTransaction.findUnique({
    where: { paymentOrderId },
    select: { id: true, balanceAfter: true, walletId: true },
  });
  if (existingTx) {
    return { walletId: existingTx.walletId, balanceAfter: existingTx.balanceAfter, alreadyCredited: true };
  }

  // Atomic guarded wallet update
  const rows = await tx.$queryRaw<{ id: string; balance: number }[]>`
    UPDATE "CreditWallet"
    SET "balance" = "balance" + ${creditsAllocated}, "updatedAt" = now()
    WHERE "userId" = ${userId}
    RETURNING "id", "balance"`;

  let walletId: string;
  let balanceAfter: number;

  if (rows.length === 0) {
    const newWallet = await tx.creditWallet.create({
      data: {
        userId,
        balance: creditsAllocated,
      },
      select: { id: true, balance: true },
    });
    walletId = newWallet.id;
    balanceAfter = newWallet.balance;
  } else {
    walletId = rows[0].id;
    balanceAfter = rows[0].balance;
  }

  await tx.creditTransaction.create({
    data: {
      userId,
      walletId,
      paymentOrderId,
      type: CreditTransactionType.PURCHASE,
      amount: creditsAllocated,
      balanceAfter,
      description: description ?? "Credit package purchase",
      idempotencyKey: paymentOrderCreditKey(paymentOrderId),
    },
  });

  return { walletId, balanceAfter, alreadyCredited: false };
}
