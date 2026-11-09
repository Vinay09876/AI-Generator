import type { Metadata } from "next";
import { Scissors } from "lucide-react";
import { ToolPlaceholder } from "@/components/dashboard/tool-placeholder";

export const metadata: Metadata = { title: "AI Video Clipper" };

export default function Page() {
  return (
    <ToolPlaceholder
      icon={Scissors}
      title="AI Video Clipper"
      description="Turn long recordings into short, shareable highlights. This tool is currently in development."
    />
  );
}
