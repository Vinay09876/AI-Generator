import type { Metadata } from "next";
import { ComingSoon } from "@/components/layout/coming-soon";

export const metadata: Metadata = { title: "AI Image Generator" };

export default function Page() {
  return (
    <ComingSoon
      title="AI Image Generator"
      description="Turn written prompts into polished visuals. This tool is currently in development."
    />
  );
}
