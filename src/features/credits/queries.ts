import { prisma } from "@/lib/prisma";

export async function getWalletSummary(userId: string) {
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
}
