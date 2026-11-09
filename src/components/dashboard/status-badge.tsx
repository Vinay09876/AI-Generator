import type { GenerationStatus } from "@/generated/prisma/client";
import { GENERATION_STATUS_META } from "@/features/generations/meta";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: GenerationStatus }) {
  const meta = GENERATION_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        meta.className,
      )}
    >
      <Icon className={cn("size-3", meta.spin && "animate-spin motion-reduce:animate-none")} aria-hidden />
      {meta.label}
    </span>
  );
}
