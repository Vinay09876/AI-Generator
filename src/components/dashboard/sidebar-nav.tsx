"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { LinkPendingIndicator } from "./link-pending-indicator";
import { isActivePath, NAV_SECTIONS } from "./nav-items";

/**
 * Shared navigation list for the desktop sidebar and the mobile drawer.
 * `layoutGroup` keeps the two animated indicators independent.
 */
export function SidebarNav({ layoutGroup, onNavigate }: { layoutGroup: string; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Dashboard" className="space-y-6">
      {NAV_SECTIONS.map((section, i) => (
        <div key={section.title ?? i}>
          {section.title && (
            <p className="mb-2 px-3 text-[11px] font-medium tracking-wider text-muted/70 uppercase">{section.title}</p>
          )}
          <ul className="space-y-1">
            {section.items.map(({ href, label, icon: Icon }) => {
              const active = isActivePath(pathname, href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex h-11 items-center gap-3 rounded-xl px-3 text-sm transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
                      active ? "text-foreground" : "text-muted hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId={`${layoutGroup}-active`}
                        className="absolute inset-0 rounded-xl border border-white/10 bg-gradient-to-r from-violet/20 via-fuchsia/10 to-transparent"
                        transition={{ type: "spring", stiffness: 420, damping: 36 }}
                      />
                    )}
                    {active && (
                      <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-gradient-to-b from-violet to-cyan" />
                    )}
                    <Icon
                      className={cn(
                        "relative size-[18px] transition-transform duration-300 group-hover:scale-110",
                        active ? "text-violet-200" : "",
                      )}
                    />
                    <span className="relative">{label}</span>
                    <LinkPendingIndicator className="relative ml-auto" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
