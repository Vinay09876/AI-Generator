import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow dev resources (HMR websocket, etc.) when accessed through a Cloudflare quick tunnel.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
