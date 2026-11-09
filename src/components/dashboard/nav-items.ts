import { History, ImageIcon, LayoutDashboard, Scissors, Settings, Video, type LucideIcon } from "lucide-react";
import { APP_ROUTES, ROUTES } from "@/lib/constants";

export type NavItem = { href: string; label: string; icon: LucideIcon };

export const NAV_SECTIONS: { title?: string; items: NavItem[] }[] = [
  { items: [{ href: ROUTES.dashboard, label: "Overview", icon: LayoutDashboard }] },
  {
    title: "Create",
    items: [
      { href: ROUTES.aiImage, label: "AI Image", icon: ImageIcon },
      { href: ROUTES.aiVideo, label: "AI Video", icon: Video },
      { href: ROUTES.videoClipper, label: "Video Clipper", icon: Scissors },
    ],
  },
  {
    title: "Workspace",
    items: [
      { href: APP_ROUTES.history, label: "History", icon: History },
      { href: APP_ROUTES.settings, label: "Settings", icon: Settings },
    ],
  },
];

export const isActivePath = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);
