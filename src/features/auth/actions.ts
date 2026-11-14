"use server";

import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut } from "@/lib/auth";
import { DEFAULT_LOGIN_REDIRECT, ROUTES } from "@/lib/constants";
import { authRateLimiter, RATE_LIMITS, trustedClientIp } from "@/lib/rate-limit";
import { hashPassword } from "@/features/auth/password";
import { createAccountWithThrottle } from "@/features/auth/register-throttle";
import { safeRedirectPath } from "@/features/auth/redirect";
import { loginSchema, registerSchema } from "@/features/auth/schemas";
import { createUserWithWallet, EmailAlreadyRegisteredError } from "@/features/users/create-user";

export type AuthFormState = {
  error?: string;
  fieldErrors?: Partial<Record<"name" | "email" | "password", string[]>>;
  /** Echo of non-sensitive values so the form can keep them after an error. Never includes the password. */
  values?: { name?: string; email?: string };
};

const text = (value: FormDataEntryValue | null) => (typeof value === "string" ? value : "");

export async function registerAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = {
    name: text(formData.get("name")),
    email: text(formData.get("email")),
    password: text(formData.get("password")),
  };
  const values = { name: raw.name, email: raw.email };

  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  }

  const { name, email, password } = parsed.data;

  // Best-effort process-local registration budget (per trusted client IP, plus a site-wide cap)
  // that counts ONLY successfully created accounts: invalid input returned above, and a duplicate
  // email or failed creation throws before anything is recorded (src/features/auth/register-throttle.ts).
  try {
    const result = await createAccountWithThrottle(trustedClientIp(await headers()), async () => {
      const passwordHash = await hashPassword(password);
      return createUserWithWallet({ name, email, passwordHash });
    });
    if (!result.ok) {
      return {
        error: `Too many new accounts are being created right now. Please wait ${result.retryAfterSeconds} seconds before trying again.`,
        values,
      };
    }
  } catch (error) {
    if (error instanceof EmailAlreadyRegisteredError) {
      return { fieldErrors: { email: [error.message] }, values };
    }
    // Log only the error type: Prisma messages can echo query arguments (e.g. the password hash).
    console.error("[auth] registration failed:", error instanceof Error ? error.name : "unknown error");
    return { error: "We couldn't create your account. Please try again.", values };
  }

  // Account created: sign the user in and send them to the dashboard.
  try {
    await signIn("credentials", { email, password, redirectTo: DEFAULT_LOGIN_REDIRECT });
  } catch (error) {
    if (error instanceof AuthError) redirect(`${ROUTES.login}?registered=1`);
    throw error; // re-throw Next.js redirect signals
  }

  return {};
}

export async function loginAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = {
    email: text(formData.get("email")),
    password: text(formData.get("password")),
  };
  const values = { email: raw.email };

  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    // Keep password errors generic so they don't hint at validation rules for existing accounts.
    return { fieldErrors: { email: fieldErrors.email, password: fieldErrors.password }, values };
  }

  // Per-IP limit only when the IP comes from a trusted proxy. The per-account progressive delay is
  // enforced inside Credentials authorize() (src/features/auth/authorize.ts), so it also covers
  // direct POSTs to /api/auth/callback/credentials that never reach this action.
  const ip = trustedClientIp(await headers());
  if (ip) {
    const ipCheck = authRateLimiter.check(`login:ip:${ip}`, RATE_LIMITS.LOGIN_IP);
    if (!ipCheck.allowed) {
      return {
        error: `Too many sign-in attempts from this network. Please wait ${ipCheck.retryAfterSeconds} seconds before trying again.`,
        values,
      };
    }
  }

  try {
    await signIn("credentials", {
      ...parsed.data,
      redirectTo: safeRedirectPath(formData.get("callbackUrl")),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      const rateLimited = error.type === "CredentialsSignin" && (error as { code?: string }).code === "rate_limited";
      return {
        error: rateLimited
          ? "This account is receiving too many sign-in attempts right now. Please wait a minute and try again."
          : error.type === "CredentialsSignin"
            ? "Invalid email or password."
            : "Something went wrong while signing in. Please try again.",
        values,
      };
    }
    throw error; // re-throw Next.js redirect signals
  }

  return {};
}

export async function logoutAction() {
  await signOut({ redirectTo: ROUTES.home });
}
