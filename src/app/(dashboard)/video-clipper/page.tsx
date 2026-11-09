import type { Metadata } from "next";
import { ComingSoon } from "@/components/layout/coming-soon";

export const metadata: Metadata = { title: "AI Video Clipper" };

export default function Page() {
  return (
    <ComingSoon
      title="AI Video Clipper"
      description="Turn long recordings into short, shareable highlights. This tool is currently in development."
    />
  );
}
