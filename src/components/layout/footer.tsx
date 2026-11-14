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
  {
    title: "Legal",
    links: [
      { label: "Terms of Service", href: ROUTES.terms },
      { label: "Privacy Policy", href: ROUTES.privacy },
      { label: "Acceptable Use", href: ROUTES.acceptableUse },
    ],
  },
] as const;

/** Signed-in visitors only see the Dashboard link: "Log in" would just bounce them to it. */
const SIGNED_IN_ACCOUNT_LINKS = [{ label: "Dashboard", href: ROUTES.dashboard }] as const;

export function Footer({ signedIn = false }: { signedIn?: boolean }) {
  const columns = COLUMNS.map((col) =>
    col.title === "Account" && signedIn ? { ...col, links: SIGNED_IN_ACCOUNT_LINKS } : col,
  );

  return (
    <footer className="relative border-t border-white/[0.06]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet/50 to-transparent" />
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 md:grid-cols-[1.3fr_repeat(4,1fr)]">
        <div className="max-w-xs md:pr-4">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-muted">{SITE.description}</p>
        </div>
        {columns.map((col) => (
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
          <div className="flex flex-wrap items-center gap-4">
            <Link href={ROUTES.terms} className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <Link href={ROUTES.privacy} className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href={ROUTES.acceptableUse} className="transition-colors hover:text-foreground">
              Acceptable Use
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
