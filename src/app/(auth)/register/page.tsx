import type { Metadata } from "next";
import { ComingSoon } from "@/components/layout/coming-soon";

export const metadata: Metadata = { title: "Create your account" };

export default function Page() {
  return (
    <ComingSoon
      title="Create your account"
      description="Sign-ups are opening soon. Accounts will give you access to every YourAI tool as it launches."
    />
  );
}
