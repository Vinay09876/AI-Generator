import type { Metadata } from "next";
import { ComingSoon } from "@/components/layout/coming-soon";

export const metadata: Metadata = { title: "Log in" };

export default function Page() {
  return (
    <ComingSoon
      title="Log in"
      description="Account sign-in is on the way. Check back soon to access your YourAI workspace."
    />
  );
}
