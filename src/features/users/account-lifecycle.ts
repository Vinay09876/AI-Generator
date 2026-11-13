import { CreditTransactionType, GenerationStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/features/auth/password";

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User ${userId} not found.`);
    this.name = "UserNotFoundError";
  }
}

export class AccountAlreadyDeletedError extends Error {
  constructor() {
    super("This account has already been decommissioned and anonymized.");
    this.name = "AccountAlreadyDeletedError";
  }
}

export class ActiveJobsInFlightError extends Error {
  constructor() {
    super("Cannot decommission account while generation jobs are active. Please wait for in-flight tasks to complete.");
    this.name = "ActiveJobsInFlightError";
  }
}

export class InvalidConfirmationError extends Error {
  constructor(message = "Invalid password or confirmation phrase.") {
    super(message);
    this.name = "InvalidConfirmationError";
  }
}

export interface DeleteAccountInput {
  password?: string;
  confirmPhrase?: string;
}

export interface DeleteAccountResult {
  success: boolean;
  userId: string;
  deletedAt: Date;
  forfeitedCredits: number;
  storageCleanup: "marked_for_asynchronous_purge";
}

/**
 * Executes safe self-service account decommissioning and cryptographic tombstoning.
 *
 * Adheres to SOP-OPS-004:
 * 1. Prohibits destructive CASCADE deletion on User table.
 * 2. Anonymizes all personal identifiable information (PII).
 * 3. Preserves immutable double-entry financial ledger records (CreditTransaction, PaymentOrder)
 *    to satisfy statutory tax and commercial accounting obligations (onDelete: Restrict).
 * 4. Forfeits remaining promotional/unspent credit balance with an audited balancing transaction.
 * 5. Revokes all active user sessions and OAuth connections immediately.
 * 6. De-identifies user media assets and storage pointers, marking them as pending deletion.
 *    Physical byte erasure in cloud storage is executed asynchronously via maintenance tooling,
 *    ensuring the atomic database transaction never stalls on external network I/O.
 */
export async function requestAccountDeletion(
  userId: string,
  input: DeleteAccountInput = {},
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<DeleteAccountResult> {
  // 1. Fetch current user state
  const user = await client.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      isDeleted: true,
      wallet: { select: { id: true, balance: true } },
    },
  });

  if (!user) throw new UserNotFoundError(userId);
  if (user.isDeleted) throw new AccountAlreadyDeletedError();

  // 2. Validate confirmation credentials
  if (user.passwordHash) {
    if (!input.password) {
      throw new InvalidConfirmationError("Password is required to confirm account deletion.");
    }
    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      throw new InvalidConfirmationError("Incorrect password provided.");
    }
  } else {
    // OAuth-only user: require explicit confirmation phrase
    if (input.confirmPhrase !== "DELETE") {
      throw new InvalidConfirmationError('Please type "DELETE" to confirm account decommissioning.');
    }
  }

  // 3. Guard against active in-flight generation jobs across all studios
  const activeJob = await client.generationJob.findFirst({
    where: {
      userId,
      status: {
        in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING],
      },
    },
    select: { id: true, status: true, type: true },
  });

  if (activeJob) {
    throw new ActiveJobsInFlightError();
  }

  const now = new Date();
  const anonymizedEmail = `deleted_${userId.slice(0, 10)}_${Date.now()}@tombstone.local`;

  const executeAtomic = async (tx: Prisma.TransactionClient): Promise<DeleteAccountResult> => {
    let forfeitedCredits = 0;

    // 4. Ledger Reconciliation: If wallet has remaining balance, insert balancing forfeiture entry
    if (user.wallet && user.wallet.balance > 0) {
      forfeitedCredits = user.wallet.balance;

      await tx.creditTransaction.create({
        data: {
          userId,
          walletId: user.wallet.id,
          type: CreditTransactionType.ADMIN_ADJUSTMENT,
          amount: -forfeitedCredits,
          balanceAfter: 0,
          description: "Account closure: unspent credit balance forfeited upon user-requested account deletion",
          idempotencyKey: `account-closure-forfeiture:${userId}`,
        },
      });

      await tx.creditWallet.update({
        where: { userId },
        data: { balance: 0 },
      });
    }

    // 5. Revoke Sessions & OAuth Accounts
    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });

    // 6. De-identify Media Assets: mark storage pointers as pending deletion
    // Cloud storage objects are marked for out-of-band asynchronous purging
    await tx.generatedAsset.updateMany({
      where: { userId },
      data: {
        storageKey: `pending_purge/${userId}`,
        fileUrl: null,
        thumbnailKey: null,
      },
    });

    // 7. Cryptographically Tombstone User PII
    // Retains immutable primary key and relational links to statutory PaymentOrder rows
    await tx.user.update({
      where: { id: userId },
      data: {
        name: "Deleted User",
        email: anonymizedEmail,
        passwordHash: null,
        image: null,
        emailVerified: null,
        isDeleted: true,
        deletedAt: now,
      },
    });

    return {
      success: true,
      userId,
      deletedAt: now,
      forfeitedCredits,
      storageCleanup: "marked_for_asynchronous_purge",
    };
  };

  if ("$transaction" in client) {
    return await (client as typeof prisma).$transaction(executeAtomic, TX_OPTIONS);
  }
  return await executeAtomic(client as Prisma.TransactionClient);
}
