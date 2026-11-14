import type { Metadata } from "next";
import { AuthCard } from "@/features/auth/components/auth-card";
import { LoginForm } from "@/features/auth/components/login-form";
import { safeRedirectPath } from "@/features/auth/redirect";
import { ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; registered?: string }>;
}) {
  const { callbackUrl, registered } = await searchParams;

  return (
    <AuthCard
      title="Welcome back"
      description="Log in to your Pixora workspace."
      footer={{ text: "New to Pixora?", linkLabel: "Create an account", href: ROUTES.register }}
    >
      <LoginForm
        callbackUrl={callbackUrl ? safeRedirectPath(callbackUrl) : undefined}
        notice={registered ? "Your account was created. Please log in." : undefined}
      />
    </AuthCard>
  );
}
