"use client";

import { MotionConfig } from "motion/react";

/** Respects the user's OS-level "reduce motion" preference for all Motion animations. */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
