import { cache } from "react";
import { prisma } from "@/lib/prisma";

/** Public profile fields only. Never selects passwordHash. Cached per request. */
export const getProfile = cache(async (userId: string) => {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, image: true, createdAt: true },
  });
});

/** Which sign-in methods the account has. Returns booleans/names only, never the hash. */
export async function getSignInMethods(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, accounts: { select: { provider: true } } },
  });
  return {
    password: Boolean(user?.passwordHash),
    providers: user?.accounts.map((a) => a.provider) ?? [],
  };
}

export type Profile = NonNullable<Awaited<ReturnType<typeof getProfile>>>;
