"use client";

import { Gauge, Sparkles, type LucideIcon } from "lucide-react";
import { IMAGE_QUALITIES, type ImageQuality } from "@/features/generations/config";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ImageQuality; icon: LucideIcon; hint: string }[] = [
  { value: "fast", icon: Gauge, hint: "Quick drafts and ideas" },
  { value: "detailed", icon: Sparkles, hint: "Richer detail and texture" },
];

const creditsLabel = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;

/**
 * Native radio group styled as cards: arrow keys, Space and screen-reader semantics come
 * from the browser. The visually hidden input carries focus; the card shows the ring.
 */
export function QualitySelector({
  value,
  onChange,
  disabled,
}: {
  value: ImageQuality;
  onChange: (value: ImageQuality) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-foreground/90">Quality</legend>
      <div className="grid grid-cols-2 gap-3">
        {OPTIONS.map(({ value: option, icon: Icon, hint }) => {
          const tier = IMAGE_QUALITIES[option];
          const checked = value === option;
          return (
            <label
              key={option}
              className={cn(
                "relative flex min-h-24 cursor-pointer flex-col gap-1 rounded-2xl border p-3.5 transition-colors sm:p-4",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet",
                "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                checked
                  ? "border-violet/50 bg-gradient-to-br from-violet/15 to-transparent"
                  : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]",
              )}
            >
              <input
                type="radio"
                name="quality"
                value={option}
                checked={checked}
                onChange={() => onChange(option)}
                className="sr-only"
              />
              {/* Narrow cards: name above the cost badge (consistent for both); side by side from sm. */}
              <span className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Icon className={cn("size-4", checked ? "text-violet-200" : "text-muted")} aria-hidden />
                  {tier.label}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap tabular-nums",
                    checked ? "bg-violet/25 text-violet-100" : "bg-white/[0.06] text-muted",
                  )}
                >
                  {creditsLabel(tier.credits)}
                </span>
              </span>
              <span className="text-xs text-muted">{hint}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
