import { z } from "zod";

/**
 * Build-time environment schema (safe to evaluate during static builds / next build).
 */
export const buildEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

/**
 * Full server runtime environment schema (evaluated lazily at runtime boundaries).
 * Never evaluated top-level at module load time to preserve static Next.js builds.
 */
export const serverRuntimeEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      "DATABASE_URL must be a valid PostgreSQL connection string",
    ),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  AUTH_URL: z.string().url("AUTH_URL must be a valid URL").optional().or(z.literal("")),
  AUTH_TRUST_HOST: z.string().optional(),
  APP_ORIGIN: z.string().min(1, "APP_ORIGIN is required in production").optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  CLOUDFLARE_AI_API_TOKEN: z.string().min(1, "CLOUDFLARE_AI_API_TOKEN is required"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SECRET_KEY: z.string().min(1, "SUPABASE_SECRET_KEY is required"),
  SUPABASE_STORAGE_BUCKET: z.string().min(1, "SUPABASE_STORAGE_BUCKET is required").default("generated-assets"),
});

export type ServerRuntimeEnv = z.infer<typeof serverRuntimeEnvSchema>;

export type EnvValidationResult =
  | { ok: true; data: ServerRuntimeEnv }
  | { ok: false; missing: string[]; invalid: string[]; errors: Record<string, string[]> };

/**
 * Validates server runtime environment variables lazily.
 * Guarantees that secret values are NEVER exposed in errors or diagnostics.
 */
export function validateRuntimeEnv(rawEnv: Record<string, string | undefined> = process.env): EnvValidationResult {
  const result = serverRuntimeEnvSchema.safeParse(rawEnv);
  if (result.success) {
    // In production, APP_ORIGIN is required
    if (result.data.NODE_ENV === "production" && (!rawEnv.APP_ORIGIN || rawEnv.APP_ORIGIN.trim() === "")) {
      return {
        ok: false,
        missing: ["APP_ORIGIN"],
        invalid: [],
        errors: { APP_ORIGIN: ["APP_ORIGIN is required in production"] },
      };
    }
    return { ok: true, data: result.data };
  }

  const flattened = z.flattenError(result.error);
  const fieldErrors = flattened.fieldErrors;
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const [key] of Object.entries(fieldErrors)) {
    const val = rawEnv[key];
    if (val === undefined || (typeof val === "string" && val.trim() === "")) {
      missing.push(key);
    } else {
      invalid.push(key);
    }
  }

  if (
    rawEnv.NODE_ENV === "production" &&
    (!rawEnv.APP_ORIGIN || rawEnv.APP_ORIGIN.trim() === "") &&
    !missing.includes("APP_ORIGIN")
  ) {
    missing.push("APP_ORIGIN");
  }

  return {
    ok: false,
    missing,
    invalid,
    errors: fieldErrors as Record<string, string[]>,
  };
}

/**
 * Asserts that server runtime environment variables are valid.
 * Throws a sanitized Error naming only keys, never values.
 */
export function assertRuntimeEnv(rawEnv: Record<string, string | undefined> = process.env): ServerRuntimeEnv {
  const res = validateRuntimeEnv(rawEnv);
  if (res.ok) {
    return res.data;
  }

  const details: string[] = [];
  if (res.missing.length > 0) details.push(`missing: [${res.missing.join(", ")}]`);
  if (res.invalid.length > 0) details.push(`invalid: [${res.invalid.join(", ")}]`);

  throw new Error(`[env] Invalid server configuration (${details.join("; ")}). All secret values are redacted.`);
}

/**
 * Non-sensitive environment status summary for operational health diagnostics.
 * Contains only boolean presence flags and sanitized variable names.
 */
export function getSanitizedEnvStatus(rawEnv: Record<string, string | undefined> = process.env) {
  const validation = validateRuntimeEnv(rawEnv);
  return {
    valid: validation.ok,
    missing: validation.ok ? [] : validation.missing,
    invalid: validation.ok ? [] : validation.invalid,
    configured: {
      hasDatabaseUrl: Boolean(rawEnv.DATABASE_URL?.trim()),
      hasAuthSecret: Boolean(rawEnv.AUTH_SECRET?.trim()),
      hasAppOrigin: Boolean(rawEnv.APP_ORIGIN?.trim()),
      hasCloudflareCredentials: Boolean(rawEnv.CLOUDFLARE_ACCOUNT_ID?.trim() && rawEnv.CLOUDFLARE_AI_API_TOKEN?.trim()),
      hasSupabaseStorage: Boolean(rawEnv.SUPABASE_URL?.trim() && rawEnv.SUPABASE_SECRET_KEY?.trim()),
    },
  };
}
