import type { NextConfig } from "next";

/**
 * Returns security headers configured for the specified environment.
 * Development allows Fast Refresh eval and websocket tunnels.
 * Production enforces strict script sources (no unsafe-eval) and HSTS (no includeSubDomains).
 */
export function getSecurityHeaders(isDev = process.env.NODE_ENV !== "production") {
  const contentSecurityPolicy = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://*.supabase.co",
    "media-src 'self' blob: data: https://*.supabase.co",
    isDev
      ? "connect-src 'self' ws: wss: https://*.supabase.co https://*.trycloudflare.com wss://*.trycloudflare.com"
      : "connect-src 'self' https://*.supabase.co",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");

  const baseSecurityHeaders = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  ];

  // Strict-Transport-Security is applied only in production HTTPS contexts, without includeSubDomains
  return isDev
    ? baseSecurityHeaders
    : [...baseSecurityHeaders, { key: "Strict-Transport-Security", value: "max-age=31536000" }];
}

const nextConfig: NextConfig = {
  // Produce a standalone folder (.next/standalone) containing only necessary production files.
  output: "standalone",
  // Allow dev resources (HMR websocket, etc.) when accessed through a Cloudflare quick tunnel.
  allowedDevOrigins: ["*.trycloudflare.com"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: getSecurityHeaders(),
      },
    ];
  },
};

export default nextConfig;
