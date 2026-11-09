import { CreditTransactionType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { INITIAL_CREDITS } from "@/lib/constants";

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with this email already exists.");
    this.name = "EmailAlreadyRegisteredError";
  }
}

type CreateUserInput = {
  name: string;
  email: string;
  passwordHash: string;
};

/**
 * Creates the user, their credit wallet and the INITIAL_GRANT ledger entry in a
 * single database transaction: either all three rows are written or none are.
 * Duplicate emails are rejected by the unique constraint on User.email.
 */
export async function createUserWithWallet({ name, email, passwordHash }: CreateUserInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          passwordHash,
          wallet: { create: { balance: INITIAL_CREDITS } },
        },
        select: { id: true, name: true, email: true, wallet: { select: { id: true } } },
      });

      if (!user.wallet) throw new Error("Wallet was not created.");

      await tx.creditTransaction.create({
        data: {
          userId: user.id,
          walletId: user.wallet.id,
          type: CreditTransactionType.INITIAL_GRANT,
          amount: INITIAL_CREDITS,
          balanceAfter: INITIAL_CREDITS,
          description: "Welcome credits",
          idempotencyKey: `initial-grant:${user.id}`,
        },
      });

      return { id: user.id, name: user.name, email: user.email };
    });
  } catch (error) {
    // P2002 = unique constraint violation. The only user-supplied unique field is email.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new EmailAlreadyRegisteredError();
    }
    throw error;
  }
}
