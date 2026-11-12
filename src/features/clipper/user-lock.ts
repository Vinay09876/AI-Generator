/**
 * Per-user serialisation for upload reservation / discard / release (Batch 5, extracted in Batch 7
 * so the real lock can be exercised against PostgreSQL in integration tests).
 *
 * Takes the same `User` row lock (SELECT … FOR UPDATE) that serialises job creation. The lock is
 * held across bounded storage calls (list + placeholder, each ≤5 s) on purpose, so concurrent
 * intents cannot both pass the one-pending-upload check.
 */

import { AccountingError } from "@/features/generations/errors";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { getActiveClipSourceKeys } from "./queries";
import type { ClipperUploadDeps } from "./uploads/uploads";

export function createPrismaUserLock(db: PrismaClient): ClipperUploadDeps["withUserLock"] {
  return (userId, fn) =>
    db.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        if (locked.length === 0) throw new AccountingError("USER_NOT_FOUND");
        return fn({ activeSourceKeys: () => getActiveClipSourceKeys(userId, tx) });
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
}
