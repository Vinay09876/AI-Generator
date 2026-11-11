"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";
import { EASE_OUT } from "@/lib/motion";

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE_OUT } },
};

/** Staggers the entrance of its <RevealItem> children once, on mount. Honors prefers-reduced-motion. */
export function RevealGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  const shouldReduceMotion = useReducedMotion();
  const variants: Variants = shouldReduceMotion
    ? { hidden: {}, show: { transition: { duration: 0 } } }
    : container;

  return (
    <motion.div className={className} variants={variants} initial="hidden" animate="show">
      {children}
    </motion.div>
  );
}

export function RevealItem({ children, className }: { children: React.ReactNode; className?: string }) {
  const shouldReduceMotion = useReducedMotion();
  const variants: Variants = shouldReduceMotion
    ? { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0 } } }
    : item;

  return (
    <motion.div className={className} variants={variants}>
      {children}
    </motion.div>
  );
}
