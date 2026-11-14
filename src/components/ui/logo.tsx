import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ROUTES, SITE } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * Brand mark. Inside the signed-in app pass `href={ROUTES.dashboard}`: the marketing home page is
 * for visitors, and linking signed-in users there looked like being logged out.
 */
export function Logo({ className, href = ROUTES.home }: { className?: string; href?: string }) {
  return (
    <Link
      href={href}
      aria-label={href === ROUTES.home ? `${SITE.name} home` : `${SITE.name} dashboard`}
      className={cn("group inline-flex min-h-11 items-center gap-2.5", className)}
    >
      <span className="relative grid size-8 place-items-center rounded-lg bg-gradient-to-br from-violet via-fuchsia to-cyan shadow-[0_0_24px_-4px_rgb(168_85_247/0.8)] transition-transform duration-500 group-hover:rotate-[8deg]">
        <Sparkles className="size-4 text-white" strokeWidth={2.25} />
      </span>
      <span className="font-display text-lg font-semibold tracking-tight">{SITE.name}</span>
    </Link>
  );
}
