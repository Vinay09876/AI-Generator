import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/lib/auth.config";
import { prisma } from "@/lib/prisma";
import { isSessionAccountActive } from "@/features/auth/account-status";
import { authorizeCredentials } from "@/features/auth/authorize";

const lookupAccountStatus = (userId: string) =>
  prisma.user.findUnique({ where: { id: userId }, select: { isDeleted: true, isSuspended: true } });

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    // Runs on every session read in the Node.js runtime (pages, route handlers, server actions).
    // JWT sessions are stateless, so this is where suspension and deletion take effect: returning
    // null makes auth() return no session and clears the cookie. The proxy (src/proxy.ts) uses the
    // DB-free authConfig and stays an optimistic redirect only.
    async jwt(params) {
      const token = await authConfig.callbacks.jwt(params);
      return (await isSessionAccountActive(token?.sub, lookupAccountStatus)) ? token : null;
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      // Shared by the login form and direct POSTs to /api/auth/callback/credentials, so the
      // per-account failure limit applies to every sign-in path (src/features/auth/authorize.ts).
      authorize: (credentials) =>
        authorizeCredentials(credentials, {
          findUserByEmail: (email) =>
            prisma.user.findUnique({
              where: { email },
              select: { id: true, name: true, email: true, image: true, passwordHash: true, isDeleted: true, isSuspended: true },
            }),
        }),
    }),
  ],
});
