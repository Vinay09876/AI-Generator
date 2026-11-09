"use client";

import { useId, useState } from "react";
import { useFormStatus } from "react-dom";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type FieldProps = React.ComponentProps<"input"> & {
  label: string;
  errors?: string[];
  hint?: string;
};

export function FormField({ label, errors, hint, type = "text", className, ...props }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const [visible, setVisible] = useState(false);
  const isPassword = type === "password";
  const hasError = Boolean(errors?.length);

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-foreground/90">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={isPassword && visible ? "text" : type}
          aria-invalid={hasError || undefined}
          aria-describedby={cn(hasError && errorId, hint && hintId) || undefined}
          className={cn(
            "h-11 w-full rounded-xl border bg-white/[0.03] px-4 text-[15px] text-foreground placeholder:text-muted/60",
            "transition-[border-color,box-shadow,background-color] duration-200 outline-none",
            "focus:border-violet/60 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgb(139_92_246/0.15)]",
            hasError ? "border-rose-400/60" : "border-white/10 hover:border-white/20",
            isPassword && "pr-11",
          )}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted transition-colors hover:text-foreground"
          >
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        )}
      </div>
      {hint && !hasError && (
        <p id={hintId} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      )}
      {hasError && (
        <p id={errorId} className="mt-1.5 text-xs text-rose-300">
          {errors![0]}
        </p>
      )}
    </div>
  );
}

export function SubmitButton({ children, pendingLabel }: { children: React.ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "relative inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-white text-sm font-medium text-zinc-950",
        "shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_30px_-6px_rgb(139_92_246/0.55)] transition-[box-shadow,transform,opacity] duration-300",
        "hover:shadow-[0_0_0_1px_rgb(255_255_255/0.2),0_10px_40px_-4px_rgb(217_70_239/0.6)] active:scale-[0.98]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-not-allowed disabled:opacity-70",
      )}
    >
      {pending && <Loader2 className="size-4 animate-spin" />}
      {pending ? pendingLabel : children}
    </button>
  );
}

export function FormAlert({ message, tone = "error" }: { message?: string; tone?: "error" | "success" }) {
  if (!message) return null;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-xl border px-4 py-3 text-sm",
        tone === "error"
          ? "border-rose-400/30 bg-rose-500/10 text-rose-200"
          : "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
      )}
    >
      {message}
    </p>
  );
}
