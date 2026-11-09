import type { NextAuthConfig } from "next-auth";
import { ROUTES } from "@/lib/constants";

/**
 * Provider-free Auth.js config shared by the full auth instance and proxy.ts.
 * Keeping it free of Prisma/bcrypt lets the proxy verify the session cookie cheaply.
 */
export const authConfig = {
  pages: {
    signIn: ROUTES.login,
  },
  session: {
    strategy: "jwt", // required by the Credentials provider
    maxAge: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh the session cookie at most once a day
  },
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub && session.user) session.user.id = token.sub;
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
