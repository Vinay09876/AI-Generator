"use client";

import { useActionState } from "react";
import Link from "next/link";
import { registerAction, type AuthFormState } from "@/features/auth/actions";
import { ROUTES } from "@/lib/constants";
import { FormAlert, FormField, SubmitButton } from "./form-controls";

const initialState: AuthFormState = {};

export function RegisterForm() {
  const [state, formAction] = useActionState(registerAction, initialState);

  return (
    <form action={formAction} noValidate className="space-y-5">
      <FormAlert message={state.error} />
      <FormField
        label="Name"
        name="name"
        autoComplete="name"
        placeholder="Your name"
        required
        maxLength={80}
        defaultValue={state.values?.name}
        errors={state.fieldErrors?.name}
      />
      <FormField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        required
        defaultValue={state.values?.email}
        errors={state.fieldErrors?.email}
      />
      <FormField
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
        required
        minLength={8}
        hint="Use at least 8 characters."
        errors={state.fieldErrors?.password}
      />
      <p className="text-xs leading-relaxed text-muted">
        By creating an account, you agree to our{" "}
        <Link
          href={ROUTES.terms}
          className="text-foreground/90 underline decoration-white/20 underline-offset-4 hover:text-foreground"
        >
          Terms of Service
        </Link>
        ,{" "}
        <Link
          href={ROUTES.privacy}
          className="text-foreground/90 underline decoration-white/20 underline-offset-4 hover:text-foreground"
        >
          Privacy Policy
        </Link>
        , and{" "}
        <Link
          href={ROUTES.acceptableUse}
          className="text-foreground/90 underline decoration-white/20 underline-offset-4 hover:text-foreground"
        >
          Acceptable Use Policy
        </Link>
        .
      </p>
      <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
    </form>
  );
}
