import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/lib/auth.config";
import { prisma } from "@/lib/prisma";
import { loginSchema } from "@/features/auth/schemas";
import { verifyPassword } from "@/features/auth/password";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
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
          select: { id: true, name: true, email: true, image: true, passwordHash: true },
        });

        // Always run a bcrypt comparison so timing does not reveal whether the email exists.
        const valid = await verifyPassword(password, user?.passwordHash);
        if (!user || !valid) return null;

        // Never return the password hash: this object becomes the session token payload.
        return { id: user.id, name: user.name, email: user.email, image: user.image };
      },
    }),
  ],
});
