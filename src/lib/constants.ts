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

export const APP_ROUTES = {
  history: "/history",
  settings: "/settings",
} as const;

/** Credits granted to every new account at registration. */
export const INITIAL_CREDITS = 100;

/** Route prefixes that require a signed-in user. */
export const PROTECTED_ROUTE_PREFIXES = [
  ROUTES.dashboard,
  ROUTES.aiImage,
  ROUTES.aiVideo,
  ROUTES.videoClipper,
  APP_ROUTES.history,
  APP_ROUTES.settings,
] as const;

/** Pages that signed-in users should be redirected away from. */
export const AUTH_ROUTES = [ROUTES.login, ROUTES.register] as const;

export const DEFAULT_LOGIN_REDIRECT = ROUTES.dashboard;
