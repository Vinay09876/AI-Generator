"use client";

import { useActionState } from "react";
import { registerAction, type AuthFormState } from "@/features/auth/actions";
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
      <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
    </form>
  );
}
