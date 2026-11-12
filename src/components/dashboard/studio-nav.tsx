"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ImageIcon, Video, Scissors, Sparkles } from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface StudioToolItem {
  id: "image" | "video" | "clipper";
  href: string;
  label: string;
  description: string;
  badge: string;
  costLabel: string;
  icon: typeof ImageIcon;
}

export const STUDIO_TOOLS: readonly StudioToolItem[] = [
  {
    id: "image",
    href: ROUTES.aiImage,
    label: "AI Image",
    description: "Fast photorealistic text-to-image",
    badge: "FLUX.1 Schnell",
    costLabel: "1 cr",
    icon: ImageIcon,
  },
  {
    id: "video",
    href: ROUTES.aiVideo,
    label: "AI Video",
    description: "Cinematic 720p 16 FPS video",
    badge: "Wan 2.1",
    costLabel: "10 cr",
    icon: Video,
  },
  {
    id: "clipper",
    href: ROUTES.videoClipper,
    label: "Video Clipper",
    description: "Multi-format scene reframing",
    badge: "Smart Cut",
    costLabel: "5 cr/clip",
    icon: Scissors,
  },
] as const;

export function StudioNav({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Creative Studio Navigation"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.08] bg-surface/60 p-1.5 backdrop-blur-xl sm:gap-3 sm:p-2",
        className,
      )}
    >
      <div className="hidden items-center gap-2 px-3 text-xs font-medium text-muted lg:flex">
        <Sparkles className="size-3.5 text-violet-300" aria-hidden />
        <span className="uppercase tracking-wider text-[11px]">Studio</span>
      </div>

      <ul className="flex flex-1 flex-wrap items-center gap-1.5 sm:gap-2">
        {STUDIO_TOOLS.map((tool) => {
          const Icon = tool.icon;
          const isActive = pathname === tool.href || pathname.startsWith(`${tool.href}/`);

          return (
            <li key={tool.id} className="flex-1 min-w-[130px] sm:min-w-[170px]">
              <Link
                href={tool.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group relative flex items-center justify-between gap-2.5 rounded-xl px-3 py-2 text-xs transition-all sm:text-sm",
                  "focus-visible:outline-2 focus-visible:outline-violet",
                  isActive
                    ? "bg-gradient-to-r from-violet/25 via-fuchsia/15 to-cyan/15 text-foreground shadow-sm ring-1 ring-white/20 font-medium"
                    : "text-muted hover:bg-white/[0.04] hover:text-foreground ring-1 ring-transparent",
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Icon
                    className={cn(
                      "size-4 shrink-0 transition-transform group-hover:scale-110",
                      isActive ? "text-violet-300" : "text-muted/80",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-xs sm:text-sm">{tool.label}</span>
                    <span className="hidden text-[10px] text-muted/70 sm:block">{tool.badge}</span>
                  </div>
                </div>

                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                    isActive
                      ? "bg-violet/30 text-violet-100 ring-1 ring-violet/40"
                      : "bg-white/[0.06] text-muted/80",
                  )}
                >
                  {tool.costLabel}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
