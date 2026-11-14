/**
 * Production database TLS policy (Work Item 2).
 *
 * The application reaches PostgreSQL through @prisma/adapter-pg -> node-postgres, which takes its TLS
 * settings from the DATABASE_URL query string (pg-connection-string):
 *   - no sslmode                -> NO TLS at all
 *   - sslmode=no-verify         -> TLS without certificate verification
 *   - uselibpqcompat=true&sslmode=require|prefer -> TLS without hostname/CA verification
 *   - sslmode=verify-full + sslrootcert=<CA file> -> chain verified against that CA AND hostname checked
 * Only the last form is accepted for a non-loopback database in production. The Docker images ship the
 * Supabase root CA at SUPABASE_ROOT_CA_PATH (fingerprint pinned at build time in the Dockerfile).
 *
 * Reasons never contain the URL, credentials or file contents.
 */
import { existsSync } from "node:fs";

/** Where the Docker images place the public Supabase Root 2021 CA (see Dockerfile). */
export const SUPABASE_ROOT_CA_PATH = "/app/certs/supabase-root-2021.crt";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type DatabaseTlsCheck = { ok: true } | { ok: false; reason: string };

export function checkDatabaseTls(
  rawUrl: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): DatabaseTlsCheck {
  if (!rawUrl?.trim()) return { ok: false, reason: "is not set" };
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "is not a valid connection URL" };
  }

  const params = url.searchParams;
  // pg-connection-string copies query parameters in order, so the LAST occurrence wins, and a `host`
  // query parameter replaces the URL's host. Refuse ambiguous URLs so this check always evaluates
  // exactly what the driver will use.
  for (const name of ["sslmode", "sslrootcert", "host", "ssl", "uselibpqcompat"]) {
    if (params.getAll(name).length > 1) return { ok: false, reason: `repeats the ${name} parameter` };
  }
  const effectiveHost = (params.get("host") ?? url.hostname).toLowerCase();

  // A database on the same host is never reached over a network that could be intercepted.
  if (LOOPBACK_HOSTS.has(effectiveHost)) return { ok: true };

  const sslmode = params.get("sslmode");
  if (sslmode !== "verify-full") {
    return { ok: false, reason: "must use sslmode=verify-full (certificate and hostname verification) in production" };
  }
  const rootCert = params.get("sslrootcert");
  if (!rootCert) {
    return { ok: false, reason: `must set sslrootcert to the Supabase root CA file (images ship it at ${SUPABASE_ROOT_CA_PATH})` };
  }
  if (!fileExists(rootCert)) {
    return { ok: false, reason: "names an sslrootcert file that does not exist in this runtime" };
  }
  return { ok: true };
}
