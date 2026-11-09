"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut } from "@/lib/auth";
import { DEFAULT_LOGIN_REDIRECT, ROUTES } from "@/lib/constants";
import { hashPassword } from "@/features/auth/password";
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

  try {
    const passwordHash = await hashPassword(password);
    await createUserWithWallet({ name, email, passwordHash });
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

  try {
    await signIn("credentials", {
      ...parsed.data,
      redirectTo: safeRedirectPath(formData.get("callbackUrl")),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        error:
          error.type === "CredentialsSignin"
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
