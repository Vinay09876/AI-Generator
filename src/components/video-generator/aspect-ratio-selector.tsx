"use client";

import { motion, useReducedMotion } from "motion/react";
import type { VideoAspectRatio } from "@/features/video/config";
import { cn } from "@/lib/utils";

interface AspectRatioOption {
  value: VideoAspectRatio;
  label: string;
  name: string;
  resolution: string;
  useCase: string;
  wireframeClass: string;
}

const OPTIONS: AspectRatioOption[] = [
  {
    value: "16:9",
    label: "16:9",
    name: "Landscape",
    resolution: "1280 × 720",
    useCase: "Cinema • YouTube • Desktop",
    wireframeClass: "w-7 h-4 rounded-sm",
  },
  {
    value: "9:16",
    label: "9:16",
    name: "Portrait",
    resolution: "720 × 1280",
    useCase: "Reels • TikTok • Shorts",
    wireframeClass: "w-4 h-7 rounded-sm",
  },
  {
    value: "1:1",
    label: "1:1",
    name: "Square",
    resolution: "960 × 960",
    useCase: "Feed • Instagram • Social",
    wireframeClass: "w-5 h-5 rounded-sm",
  },
];

interface AspectRatioSelectorProps {
  value: VideoAspectRatio;
  onChange: (value: VideoAspectRatio) => void;
  disabled?: boolean;
}

export function AspectRatioSelector({ value, onChange, disabled }: AspectRatioSelectorProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium tracking-wider text-muted/80 uppercase">
          Aspect Ratio
        </label>
        <span className="font-mono text-xs text-muted/60">
          {OPTIONS.find((o) => o.value === value)?.resolution}
        </span>
      </div>

      <div
        role="radiogroup"
        aria-label="Aspect ratio"
        className="grid grid-cols-3 gap-2.5"
      >
        {OPTIONS.map((opt) => {
          const isSelected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              className={cn(
                "group relative flex flex-col items-center justify-center gap-2 rounded-2xl border p-3 text-center transition-all",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
                "disabled:cursor-not-allowed disabled:opacity-50",
                isSelected
                  ? "border-violet/40 bg-violet/10 text-foreground shadow-[0_0_20px_-4px_rgb(139_92_246/0.3)]"
                  : "border-white/[0.08] bg-white/[0.02] text-muted hover:border-white/15 hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              {isSelected && (
                <motion.span
                  layoutId="video-ar-active-pill"
                  className="absolute inset-0 rounded-2xl border border-violet/50 bg-gradient-to-b from-violet/20 via-transparent to-transparent"
                  transition={
                    shouldReduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 400, damping: 30 }
                  }
                  aria-hidden="true"
                />
              )}

              {/* Wireframe Proportion Box */}
              <div className="relative flex h-8 items-center justify-center">
                <span
                  className={cn(
                    "border-2 transition-all duration-200",
                    opt.wireframeClass,
                    isSelected
                      ? "border-violet-400 bg-violet-400/20 shadow-[0_0_10px_rgb(139_92_246/0.5)]"
                      : "border-white/20 bg-white/5 group-hover:border-white/40",
                  )}
                  aria-hidden="true"
                />
              </div>

              {/* Text Meta */}
              <div className="relative space-y-0.5">
                <p className="font-semibold text-xs tracking-tight">{opt.label}</p>
                <p className="text-[11px] text-muted/70">{opt.name}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

