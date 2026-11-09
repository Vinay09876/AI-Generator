import { cache } from "react";
import { CreditTransactionType } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/** Balance plus the latest ledger entries. Cached per request (layout + page share it). */
export const getWalletSummary = cache(async (userId: string) => {
  const wallet = await prisma.creditWallet.findUnique({
    where: { userId },
    select: {
      balance: true,
      transactions: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, type: true, amount: true, balanceAfter: true, description: true, createdAt: true },
      },
    },
  });

  return {
    balance: wallet?.balance ?? 0,
    recentTransactions: wallet?.transactions ?? [],
  };
});

function startOfUtcMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Credits used = absolute sum of GENERATION_DEBIT ledger amounts (stored as negatives).
 * Refunds are reported separately and are NOT netted against usage.
 */
export const getCreditUsage = cache(async (userId: string) => {
  const types = [CreditTransactionType.GENERATION_DEBIT, CreditTransactionType.REFUND];
  const monthStart = startOfUtcMonth();

  const [allTime, thisMonth] = await Promise.all([
    prisma.creditTransaction.groupBy({
      by: ["type"],
      where: { userId, type: { in: types } },
      _sum: { amount: true },
    }),
    prisma.creditTransaction.groupBy({
      by: ["type"],
      where: { userId, type: { in: types }, createdAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
  ]);

  const pick = (rows: typeof allTime, type: CreditTransactionType) =>
    Math.abs(rows.find((r) => r.type === type)?._sum.amount ?? 0);

  return {
    usedThisMonth: pick(thisMonth, CreditTransactionType.GENERATION_DEBIT),
    usedAllTime: pick(allTime, CreditTransactionType.GENERATION_DEBIT),
    refundedThisMonth: pick(thisMonth, CreditTransactionType.REFUND),
    refundedAllTime: pick(allTime, CreditTransactionType.REFUND),
  };
});
