import type { Metadata } from "next";
import { ComingSoon } from "@/components/layout/coming-soon";

export const metadata: Metadata = { title: "AI Video Generator" };

export default function Page() {
  return (
    <ComingSoon
      title="AI Video Generator"
      description="Generate short videos from a prompt. This tool is currently in development."
    />
  );
}
