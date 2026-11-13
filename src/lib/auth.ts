import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/lib/auth.config";
import { prisma } from "@/lib/prisma";
import { loginSchema } from "@/features/auth/schemas";
import { verifyPassword } from "@/features/auth/password";
import { isSessionAccountActive } from "@/features/auth/account-status";

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
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, name: true, email: true, image: true, passwordHash: true, isDeleted: true, isSuspended: true },
        });

        // Always run a bcrypt comparison so timing does not reveal whether the email exists.
        const valid = await verifyPassword(password, user?.passwordHash);
        if (!user || user.isDeleted || (user as any).isSuspended || !valid) return null;

        // Never return the password hash: this object becomes the session token payload.
        return { id: user.id, name: user.name, email: user.email, image: user.image };
      },
    }),
  ],
});
