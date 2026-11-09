import type { Metadata } from "next";
import { ImageIcon } from "lucide-react";
import { ToolPlaceholder } from "@/components/dashboard/tool-placeholder";

export const metadata: Metadata = { title: "AI Image Generator" };

export default function Page() {
  return (
    <ToolPlaceholder
      icon={ImageIcon}
      title="AI Image Generator"
      description="Turn written prompts into polished visuals. This tool is currently in development."
    />
  );
}
