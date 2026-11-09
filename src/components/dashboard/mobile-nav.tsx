"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { EASE_OUT } from "@/lib/motion";
import { CreditPill } from "./credit-pill";
import { LogoutButton } from "./logout-button";
import { SidebarNav } from "./sidebar-nav";
import { UserSummary, type UserSummaryData } from "./user-summary";

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Mobile top bar + slide-in navigation drawer (below lg).
 * Accessible modal: Escape closes, focus is trapped while open and
 * returned to the menu button on close, background scroll is locked.
 */
export function MobileNav({ user, balance }: { user: UserSummaryData; balance: number }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  const close = useCallback(() => setOpen(false), []);

  // Close whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      // Restore focus to the trigger only after the drawer was actually open.
      if (wasOpen.current) triggerRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;

    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };

    const mq = window.matchMedia("(min-width: 1024px)");
    const onResize = () => mq.matches && setOpen(false);

    document.addEventListener("keydown", onKeyDown);
    mq.addEventListener("change", onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      mq.removeEventListener("change", onResize);
    };
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between gap-3 border-b border-white/[0.06] bg-background/75 px-4 backdrop-blur-xl sm:px-6 lg:hidden">
        <Logo />
        <div className="flex items-center gap-2">
          <CreditPill balance={balance} />
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation menu"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls="mobile-nav-drawer"
            className="grid size-10 place-items-center rounded-xl text-foreground transition-colors hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-violet"
          >
            <Menu className="size-5" />
          </button>
        </div>
      </header>

      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={close}
              aria-hidden
            />
            <motion.div
              ref={panelRef}
              id="mobile-nav-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="absolute inset-y-0 left-0 flex w-[min(85vw,320px)] flex-col border-r border-white/[0.08] bg-surface px-4 py-5 shadow-[20px_0_60px_-20px_rgb(0_0_0/0.9)]"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.35, ease: EASE_OUT }}
            >
              <div className="flex items-center justify-between px-2">
                <Logo />
                <button
                  type="button"
                  onClick={close}
                  data-autofocus
                  aria-label="Close navigation menu"
                  className="grid size-10 place-items-center rounded-xl text-muted transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-violet"
                >
                  <X className="size-5" />
                </button>
              </div>

              <div className="mt-8 flex-1 overflow-y-auto">
                <SidebarNav layoutGroup="drawer" onNavigate={close} />
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-2 pt-4">
                <UserSummary user={user} />
                <LogoutButton showLabel={false} className="shrink-0 px-2.5" />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
