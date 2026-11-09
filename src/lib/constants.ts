export const SITE = {
  name: "YourAI",
  title: "YourAI — AI Image, Video & Clip Studio",
  description:
    "Generate images, create videos and clip long-form content into shareable highlights — all from one AI-powered workspace.",
} as const;

export const NAV_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Benefits", href: "/#benefits" },
  { label: "Pricing", href: "/#pricing" },
] as const;

export const ROUTES = {
  home: "/",
  login: "/login",
  register: "/register",
  dashboard: "/dashboard",
  aiImage: "/ai-image",
  aiVideo: "/ai-video",
  videoClipper: "/video-clipper",
} as const;
