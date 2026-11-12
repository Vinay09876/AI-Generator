"use client";

import { useId, useState } from "react";
import { UploadCloud } from "lucide-react";
import { formatBytes, formatClock } from "@/features/clipper/client";
import { cn } from "@/lib/utils";

export function UploadDropzone({
  onFile,
  disabled,
  maxUploadBytes,
  minSourceSeconds,
  maxSourceSeconds,
  maxLongEdge,
  maxShortEdge,
  accept,
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
  maxUploadBytes: number;
  minSourceSeconds: number;
  maxSourceSeconds: number;
  maxLongEdge: number;
  maxShortEdge: number;
  accept: string;
}) {
  const id = useId();
  const [dragging, setDragging] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file && !disabled) onFile(file);
      }}
    >
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        className="peer sr-only"
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow choosing the same file again
          if (file) onFile(file);
        }}
      />
      <label
        htmlFor={id}
        className={cn(
          "flex min-h-64 cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed px-6 py-12 text-center transition-colors",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-violet",
          "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
          dragging ? "border-violet/60 bg-violet/10" : "border-white/15 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.04]",
        )}
      >
        <span className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-violet/25 to-cyan/15 text-violet-200" aria-hidden="true">
          <UploadCloud className="size-6" />
        </span>
        <span className="mt-5 font-display text-lg font-semibold text-foreground">Choose a video or drop it here</span>
        <span id={`${id}-hint`} className="mt-2 max-w-sm text-sm text-muted">
          MP4, MOV or WebM · up to {formatBytes(maxUploadBytes)} · {formatClock(minSourceSeconds)}–{formatClock(maxSourceSeconds)} long ·
          up to {maxLongEdge}×{maxShortEdge} · vertical, square or landscape
        </span>
      </label>
    </div>
  );
}
