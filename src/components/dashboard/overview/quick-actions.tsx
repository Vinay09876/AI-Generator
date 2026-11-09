import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { GenerationType } from "@/generated/prisma/client";
import { GENERATION_TYPE_META } from "@/features/generations/meta";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const ACTIONS: { type: GenerationType; title: string; description: string; glow: string }[] = [
  {
    type: "IMAGE",
    title: "Generate an image",
    description: "Turn a prompt into polished visuals.",
    glow: "from-violet/25",
  },
  {
    type: "VIDEO",
    title: "Create a video",
    description: "Describe a scene and render a short clip.",
    glow: "from-fuchsia/25",
  },
  {
    type: "VIDEO_CLIP",
    title: "Clip a video",
    description: "Find highlights in long recordings.",
    glow: "from-cyan/20",
  },
];

export function QuickActions({ counts }: { counts: Record<GenerationType, number> }) {
  return (
    <section aria-labelledby="quick-actions-heading">
      <h2 id="quick-actions-heading" className="font-display text-lg font-semibold tracking-tight">
        Start creating
      </h2>
      <ul className="mt-4 grid gap-4 sm:grid-cols-3">
        {ACTIONS.map(({ type, title, description, glow }) => {
          const meta = GENERATION_TYPE_META[type];
          const Icon = meta.icon;
          return (
            <li key={type}>
              <Link
                href={meta.href}
                className={cn(
                  "group relative flex h-full flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-surface p-5",
                  "transition-[border-color,transform] duration-300 hover:-translate-y-1 hover:border-white/15",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute -top-16 -right-16 size-40 rounded-full bg-gradient-to-br to-transparent opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100",
                    glow,
                  )}
                />
                <div className="relative flex items-start justify-between">
                  <span
                    className={cn(
                      "grid size-11 place-items-center rounded-2xl transition-transform duration-500 group-hover:-rotate-6 group-hover:scale-105",
                      meta.iconClass,
                    )}
                  >
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <ArrowUpRight
                    className="size-4 text-muted transition-[transform,color] duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
                    aria-hidden
                  />
                </div>
                <h3 className="relative mt-5 font-medium">{title}</h3>
                <p className="relative mt-1 text-sm text-muted">{description}</p>
                <p className="relative mt-4 text-xs text-muted">
                  {counts[type] > 0 ? `${formatNumber(counts[type])} created` : "Nothing created yet"}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
