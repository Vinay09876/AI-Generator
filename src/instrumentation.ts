/**
 * Next.js instrumentation hook: `register` runs once when a server instance starts, before it
 * serves requests (see node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
 *
 * Validates the server environment at startup so a misconfigured deployment fails immediately with
 * the names of the missing variables instead of failing on a user's first request. Skipped during
 * `next build` (no runtime secrets exist at build time) and in the Edge runtime. The Node-only
 * work (including terminating the process in production) lives in ./lib/env-startup.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { enforceStartupEnvOrExit } = await import("./lib/env-startup");
  enforceStartupEnvOrExit();
}
