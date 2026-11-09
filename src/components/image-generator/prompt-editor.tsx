"use client";

import { useId, useRef } from "react";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Remaining-character counts at which screen readers get a (polite) announcement. */
const ANNOUNCE_AT = [200, 100, 50, 0];

/**
 * Prompt textarea with a live character counter. The browser enforces the hard limit
 * (maxLength); Ctrl/⌘ + Enter submits the surrounding form.
 */
export function PromptEditor({
  value,
  onChange,
  maxLength,
  error,
  disabled,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  error?: string | null;
  disabled?: boolean;
  /** Locked while a generation runs; unlike disabled, the field keeps keyboard focus. */
  readOnly?: boolean;
}) {
  const id = useId();
  const counterId = `${id}-counter`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const ref = useRef<HTMLTextAreaElement>(null);

  const remaining = maxLength - value.length;
  const nearLimit = remaining <= 150;
  const announcement = ANNOUNCE_AT.includes(remaining)
    ? remaining === 0
      ? "Character limit reached."
      : `${remaining} characters remaining.`
    : "";

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-foreground/90">
          Prompt
        </label>
        <span
          id={counterId}
          className={cn(
            "text-xs tabular-nums transition-colors",
            remaining === 0 ? "text-rose-300" : nearLimit ? "text-amber-200" : "text-muted",
          )}
        >
          {formatNumber(value.length)} / {formatNumber(maxLength)}
        </span>
      </div>

      <textarea
        ref={ref}
        id={id}
        name="prompt"
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        readOnly={readOnly}
        rows={6}
        spellCheck
        placeholder="A lighthouse on a cliff at dawn, soft golden light, mist over the sea, cinematic"
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(counterId, error ? errorId : hintId)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            ref.current?.form?.requestSubmit();
          }
        }}
        className={cn(
          "block min-h-40 w-full resize-y rounded-2xl border bg-white/[0.03] px-4 py-3 text-[15px] leading-relaxed text-foreground placeholder:text-muted/50",
          "transition-[border-color,box-shadow,background-color] duration-200 outline-none",
          "focus:border-violet/60 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgb(139_92_246/0.15)]",
          "disabled:cursor-not-allowed disabled:opacity-60 read-only:cursor-default read-only:opacity-70",
          error ? "border-rose-400/60" : "border-white/10 hover:border-white/20",
        )}
      />

      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-xs text-rose-300">
          {error}
        </p>
      ) : (
        <p id={hintId} className="mt-2 text-xs text-muted">
          Describe the subject, style, lighting and mood.
          {/* Keyboard shortcut: own line, never split mid-shortcut; hidden on touch-first widths. */}
          <span className="mt-1 hidden whitespace-nowrap sm:block">
            <kbd className="rounded border border-white/15 bg-white/[0.04] px-1 font-sans text-[11px]">Ctrl</kbd> /{" "}
            <kbd className="rounded border border-white/15 bg-white/[0.04] px-1 font-sans text-[11px]">⌘</kbd> +{" "}
            <kbd className="rounded border border-white/15 bg-white/[0.04] px-1 font-sans text-[11px]">Enter</kbd> to generate
          </span>
        </p>
      )}

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
