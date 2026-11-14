/**
 * Startup environment validation (post-S8 remediation).
 *
 * Called once per server instance from src/instrumentation.ts (Node.js runtime only) and from the
 * clipper worker entrypoint. In production a missing or invalid required variable stops startup
 * with an error that names the variables and never their values; outside production the same
 * findings are only logged as warnings so local development keeps working.
 *
 * Feature-specific variables are required only when their feature is switched on:
 *   - Video (Fal.ai):   enabled when STAGE_8_QA_ALLOWLIST is non-empty  -> FAL_KEY required
 *   - Clipper uploads:  CLIPPER_SUBMISSIONS_ENABLED=true                -> (uses the shared Storage vars)
 *   - Payments:         disabled in production (features/billing/availability) -> nothing required
 */

import { validateRuntimeEnv } from "@/lib/env";
import { checkDatabaseTls } from "@/lib/database-tls";

type RawEnv = Record<string, string | undefined>;

export interface StartupEnvReport {
  ok: boolean;
  /** Variable names that are required but absent/empty. */
  missing: string[];
  /** Variable names that are present but unusable, with a value-free reason. */
  invalid: { name: string; reason: string }[];
}

const isSet = (env: RawEnv, name: string) => Boolean(env[name]?.trim());

/** Names that must never be exposed to the browser bundle via the NEXT_PUBLIC_ prefix. */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|DATABASE_URL|SERVICE_ROLE|FAL_KEY)/;

export function validateStartupEnv(env: RawEnv = process.env): StartupEnvReport {
  const missing = new Set<string>();
  const invalid: { name: string; reason: string }[] = [];

  const base = validateRuntimeEnv(env);
  if (!base.ok) {
    base.missing.forEach((n) => missing.add(n));
    base.invalid.forEach((n) => invalid.push({ name: n, reason: "fails format validation" }));
  }

  const production = env.NODE_ENV === "production";
  if (production) {
    // Image storage has no default bucket; it must be configured explicitly in production.
    if (!isSet(env, "SUPABASE_STORAGE_BUCKET")) missing.add("SUPABASE_STORAGE_BUCKET");
    // All three cron endpoints fail closed without it, and stale-job/refund recovery depends on them.
    if (!isSet(env, "CRON_SECRET")) missing.add("CRON_SECRET");
    // Auth.js rejects requests from an untrusted host unless one of these is configured.
    if (env.AUTH_TRUST_HOST?.trim() !== "true" && !isSet(env, "AUTH_URL")) missing.add("AUTH_TRUST_HOST (or AUTH_URL)");
    invalid.push(...productionTlsProblems(env));
  }

  // Video: the allowlist is the production on-switch; a key-less provider would fail every job.
  if (isSet(env, "STAGE_8_QA_ALLOWLIST") && !isSet(env, "FAL_KEY")) missing.add("FAL_KEY");

  // The documented-but-unread legacy name would silently leave video disabled.
  if (isSet(env, "STAGE_8_QA_USER_EMAILS") && !isSet(env, "STAGE_8_QA_ALLOWLIST")) {
    invalid.push({ name: "STAGE_8_QA_USER_EMAILS", reason: "is not read by the app; rename it to STAGE_8_QA_ALLOWLIST" });
  }

  if (env.CLIPPER_SUBMISSIONS_ENABLED !== undefined && !["true", "false", ""].includes(env.CLIPPER_SUBMISSIONS_ENABLED.trim())) {
    invalid.push({ name: "CLIPPER_SUBMISSIONS_ENABLED", reason: 'must be "true" or "false"' });
  }

  for (const name of Object.keys(env)) {
    if (name.startsWith("NEXT_PUBLIC_") && SECRET_NAME.test(name.slice("NEXT_PUBLIC_".length))) {
      invalid.push({ name, reason: "looks like a secret but would be exposed to browsers (NEXT_PUBLIC_ prefix)" });
    }
  }

  return { ok: missing.size === 0 && invalid.length === 0, missing: [...missing], invalid };
}

/** Value-free, single-line description of a failed report. */
export function describeStartupEnvReport(report: StartupEnvReport): string {
  const parts: string[] = [];
  if (report.missing.length) parts.push(`missing: ${report.missing.join(", ")}`);
  if (report.invalid.length) parts.push(`invalid: ${report.invalid.map((i) => `${i.name} (${i.reason})`).join("; ")}`);
  return `[env] Server configuration is incomplete — ${parts.join(" | ")}. Values are never logged.`;
}

/**
 * Production: throws (startup aborts). Elsewhere: logs a warning and continues.
 * Returns the report so callers/tests can inspect it.
 */
export function enforceStartupEnv(
  env: RawEnv = process.env,
  log: Pick<Console, "warn"> = console,
): StartupEnvReport {
  const report = validateStartupEnv(env);
  if (report.ok) return report;
  const message = describeStartupEnvReport(report);
  if (env.NODE_ENV === "production") throw new Error(message);
  log.warn(`${message} (not enforced outside production)`);
  return report;
}

/**
 * Server startup entry (called from src/instrumentation.ts, Node.js runtime only). Next.js only logs
 * an error thrown from register() and keeps serving, so in production the process is terminated
 * explicitly (exit code 1) to make the orchestrator see a failed start. The logged message lists
 * variable names only, never values.
 */
export function enforceStartupEnvOrExit(env: RawEnv = process.env): void {
  try {
    enforceStartupEnv(env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

/**
 * Production TLS requirements shared by the web server and the clipper worker: the database
 * connection must verify the server certificate and hostname, and Node's global TLS verification
 * must not be switched off. Value-free reasons only.
 */
function productionTlsProblems(env: RawEnv): { name: string; reason: string }[] {
  const problems: { name: string; reason: string }[] = [];
  if (isSet(env, "DATABASE_URL")) {
    const tls = checkDatabaseTls(env.DATABASE_URL);
    if (!tls.ok) problems.push({ name: "DATABASE_URL", reason: tls.reason });
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === "0") {
    problems.push({ name: "NODE_TLS_REJECT_UNAUTHORIZED", reason: "disables TLS certificate verification; remove it" });
  }
  return problems;
}

/** Variables the standalone clipper worker process needs (it does not run instrumentation.ts). */
export function validateClipperWorkerEnv(env: RawEnv = process.env): StartupEnvReport {
  const missing = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_STORAGE_BUCKET"].filter(
    (n) => !isSet(env, n),
  );
  const invalid = env.NODE_ENV === "production" ? productionTlsProblems(env) : [];
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}
