"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { ImageIcon, LayoutDashboard, Scissors, Video } from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: ROUTES.dashboard, label: "Overview", icon: LayoutDashboard },
  { href: ROUTES.aiImage, label: "Image", icon: ImageIcon },
  { href: ROUTES.aiVideo, label: "Video", icon: Video },
  { href: ROUTES.videoClipper, label: "Clipper", icon: Scissors },
] as const;

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="mx-auto max-w-6xl overflow-x-auto px-4 sm:px-6" aria-label="Dashboard">
      <ul className="flex gap-1">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="relative">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-2 px-3 py-3 text-sm whitespace-nowrap transition-colors",
                  active ? "text-foreground" : "text-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
              {active && (
                <motion.span
                  layoutId="dashboard-nav-indicator"
                  className="absolute inset-x-2 -bottom-px h-px bg-gradient-to-r from-violet via-fuchsia to-cyan"
                  transition={{ type: "spring", stiffness: 400, damping: 34 }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
