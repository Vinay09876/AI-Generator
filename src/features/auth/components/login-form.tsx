"use client";

import { useActionState } from "react";
import { loginAction, type AuthFormState } from "@/features/auth/actions";
import { FormAlert, FormField, SubmitButton } from "./form-controls";

const initialState: AuthFormState = {};

export function LoginForm({ callbackUrl, notice }: { callbackUrl?: string; notice?: string }) {
  const [state, formAction] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} noValidate className="space-y-5">
      {state.error ? <FormAlert message={state.error} /> : <FormAlert message={notice} tone="success" />}
      {callbackUrl && <input type="hidden" name="callbackUrl" value={callbackUrl} />}
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
        autoComplete="current-password"
        placeholder="Your password"
        required
        errors={state.fieldErrors?.password}
      />
      <SubmitButton pendingLabel="Signing in…">Log in</SubmitButton>
    </form>
  );
}
