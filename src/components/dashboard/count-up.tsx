"use client";

import { useLayoutEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";

const format = new Intl.NumberFormat("en");

/**
 * Renders the real value on the server (and without JS); on mount it counts up
 * from 0 before first paint. Skipped entirely for reduced-motion users.
 */
export function CountUp({ value, duration = 1.1 }: { value: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduce || value === 0) return;
    const controls = animate(0, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        el.textContent = format.format(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [value, duration, reduce]);

  return (
    <span ref={ref} className="tabular-nums">
      {format.format(value)}
    </span>
  );
}
