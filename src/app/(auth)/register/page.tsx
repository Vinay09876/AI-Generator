import type { Metadata } from "next";
import { AuthCard } from "@/features/auth/components/auth-card";
import { RegisterForm } from "@/features/auth/components/register-form";
import { INITIAL_CREDITS, ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "Create your account" };

export default function RegisterPage() {
  return (
    <AuthCard
      title="Create your account"
      description={`Every new account starts with ${INITIAL_CREDITS} credits to explore Pixora.`}
      footer={{ text: "Already have an account?", linkLabel: "Log in", href: ROUTES.login }}
    >
      <RegisterForm />
    </AuthCard>
  );
}
