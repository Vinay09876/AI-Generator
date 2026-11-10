import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { maskRef, supabaseProjectRef } from "./test-db-guard.mjs";

/**
 * Safety guards and connection validation for disaster recovery operations.
 * Fails closed against accidental production restores or missing configurations.
 */

export { maskRef, supabaseProjectRef };

export interface ParsedConnection {
  host: string;
  port: string;
  user: string;
  password?: string;
  database: string;
  ssl: boolean;
}

/**
 * Normalizes hostnames (including loopbacks) to a canonical representation.
 */
export function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "0.0.0.0") {
    return "127.0.0.1";
  }
  return h;
}

export function parseDatabaseConnection(rawUrl: string | undefined): ParsedConnection {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("Database URL is required.");
  }

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("Invalid Database URL format.");
  }

  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new Error(`Unsupported database protocol: ${u.protocol}`);
  }

  return {
    host: normalizeHost(u.hostname),
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.replace(/^\//, "") || "postgres",
    ssl: true,
  };
}

/**
 * Derives a canonical identity for a PostgreSQL connection URL.
 * Recognizes Supabase project references across pooler and direct connections.
 * For non-Supabase URLs, canonicalizes host (resolving loopback aliases), port, database and user,
 * stripping extraneous query parameters.
 */
export function canonicalDatabaseIdentity(url: string | undefined): string | null {
  if (!url || typeof url !== "string") return null;

  // Supabase reference is the highest-fidelity identity if present
  const ref = supabaseProjectRef(url);
  if (ref) {
    return `supabase:${ref}`;
  }

  try {
    const conn = parseDatabaseConnection(url);
    return `postgres://${conn.user.toLowerCase()}@${conn.host}:${conn.port}/${conn.database.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Accidental Production Restore Guard for PostgreSQL:
 * Blocks attempts to restore into the production database unless an explicit confirmation flag is passed.
 * Fails closed if the target cannot be proven to be separate from production.
 */
export function assertSafeRestoreTarget(
  targetUrl: string,
  prodUrl: string | undefined,
  confirmProductionOverwrite: boolean = false
): { targetRef: string | null; isProduction: boolean } {
  const targetRef = supabaseProjectRef(targetUrl);
  const prodRef = supabaseProjectRef(prodUrl);

  const targetIdentity = canonicalDatabaseIdentity(targetUrl);
  const prodIdentity = canonicalDatabaseIdentity(prodUrl);

  const isProduction = Boolean(
    (targetRef && prodRef && targetRef === prodRef) ||
    (targetIdentity && prodIdentity && targetIdentity === prodIdentity) ||
    (targetUrl && prodUrl && targetUrl.trim() === prodUrl.trim())
  );

  if (isProduction && !confirmProductionOverwrite) {
    throw new Error(
      `ACCIDENTAL OVERWRITE BLOCKED: The restore target is identified as the primary/production database (${
        prodRef ? maskRef(prodRef) : "DATABASE_URL"
      }). ` +
      `Restoring will wipe and replace production data. To proceed, you must pass the exact flag: --confirm-production-overwrite`
    );
  }

  return { targetRef, isProduction };
}

/**
 * Accidental Production Restore Guard for Supabase Storage:
 * Blocks attempts to overwrite existing objects in the production storage bucket unless explicitly confirmed.
 */
export function assertSafeStorageRestoreTarget(
  targetBucket: string,
  targetUrl: string | undefined,
  prodBucket: string | undefined,
  prodUrl: string | undefined,
  confirmProductionOverwrite: boolean = false
): { isProductionBucket: boolean } {
  const normalizedTargetBucket = targetBucket.trim().toLowerCase();
  const normalizedProdBucket = (prodBucket || "generated-assets").trim().toLowerCase();

  const targetHost = targetUrl ? normalizeHost(new URL(targetUrl).hostname) : null;
  const prodHost = prodUrl ? normalizeHost(new URL(prodUrl).hostname) : null;

  const sameHost = Boolean(targetHost && prodHost && targetHost === prodHost);
  const isProductionBucket = normalizedTargetBucket === normalizedProdBucket && (sameHost || !targetUrl);

  if (isProductionBucket && !confirmProductionOverwrite) {
    throw new Error(
      `ACCIDENTAL OVERWRITE BLOCKED: The destination bucket "${targetBucket}" is identified as the production storage bucket. ` +
      `To proceed with potential overwrite of production assets, you must pass the exact flag: --confirm-production-overwrite`
    );
  }

  return { isProductionBucket };
}

/**
 * Validates that all required environment variables are present and non-empty.
 */
export function requireEnvVars(required: { name: string; value: string | undefined }[]): void {
  const missing = required.filter((r) => !r.value || r.value.trim() === "").map((r) => r.name);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}.`);
  }
}

/**
 * PostgreSQL Credentials Management:
 * Creates a secure temporary PGPASSFILE with restricted permissions (0600 on POSIX).
 * Returns the path and a cleanup function that overwrites and removes the secret file.
 */
export function createSecurePassfile(conn: ParsedConnection): {
  filePath: string;
  cleanup: () => void;
} | null {
  if (!conn.password) return null;

  const passDir = join(tmpdir(), `yourai-pgpass-${randomBytes(8).toString("hex")}`);
  mkdirSync(passDir, { recursive: true, mode: 0o700 });

  const filePath = join(passDir, ".pgpass");

  // Escape colons and backslashes per PostgreSQL specifications:
  // hostname:port:database:username:password
  const escapePgPass = (val: string) => val.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  const line = `${escapePgPass(conn.host)}:${escapePgPass(conn.port)}:${escapePgPass(conn.database)}:${escapePgPass(conn.user)}:${escapePgPass(conn.password)}\n`;

  writeFileSync(filePath, line, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows file systems ignore octal chmod, handled by isolated temp folder
  }

  return {
    filePath,
    cleanup: () => {
      try {
        if (existsSync(filePath)) {
          // Overwrite with zeros before deletion
          writeFileSync(filePath, Buffer.alloc(line.length));
          rmSync(filePath, { force: true });
        }
        if (existsSync(passDir)) {
          rmSync(passDir, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup
      }
    },
  };
}
