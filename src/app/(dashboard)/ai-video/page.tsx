import type { Metadata } from "next";
import { Video } from "lucide-react";
import { ToolPlaceholder } from "@/components/dashboard/tool-placeholder";

export const metadata: Metadata = { title: "AI Video Generator" };

export default function Page() {
  return (
    <ToolPlaceholder
      icon={Video}
      title="AI Video Generator"
      description="Generate short videos from a prompt. This tool is currently in development."
    />
  );
}
