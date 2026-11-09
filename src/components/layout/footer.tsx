import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { ROUTES, SITE } from "@/lib/constants";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "AI Image Generator", href: ROUTES.aiImage },
      { label: "AI Video Generator", href: ROUTES.aiVideo },
      { label: "AI Video Clipper", href: ROUTES.videoClipper },
      { label: "Pricing", href: "/#pricing" },
    ],
  },
  {
    title: "Explore",
    links: [
      { label: "Features", href: "/#features" },
      { label: "How it works", href: "/#how-it-works" },
      { label: "Benefits", href: "/#benefits" },
    ],
  },
  {
    title: "Account",
    links: [
      { label: "Log in", href: ROUTES.login },
      { label: "Create account", href: ROUTES.register },
      { label: "Dashboard", href: ROUTES.dashboard },
    ],
  },
] as const;

export function Footer() {
  return (
    <footer className="relative border-t border-white/[0.06]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet/50 to-transparent" />
      <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="max-w-xs">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-muted">{SITE.description}</p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="text-sm font-medium text-foreground">{col.title}</h3>
            <ul className="mt-4 space-y-3">
              {col.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-xs text-muted sm:flex-row sm:px-6">
          <p>
            © {new Date().getFullYear()} {SITE.name}. All rights reserved.
          </p>
          <p>Crafted for creators, marketers and storytellers.</p>
        </div>
      </div>
    </footer>
  );
}
