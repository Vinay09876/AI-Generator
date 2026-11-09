import type { Metadata } from "next";
import { ComingSoon } from "@/components/layout/coming-soon";

export const metadata: Metadata = { title: "Dashboard" };

export default function Page() {
  return (
    <ComingSoon
      title="Dashboard"
      description="Your workspace, credits and recent generations will live here."
    />
  );
}
