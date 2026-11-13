// Which database URL the Prisma CLI (migrate/status/db) uses. Imported by prisma.config.ts.
//
// The runtime client (src/lib/prisma.ts -> @prisma/adapter-pg -> node-postgres) and the Prisma CLI's
// schema engine accept different TLS URL parameters: node-postgres uses `sslmode=verify-full` +
// `sslrootcert=<CA path>`, while Prisma documents `sslmode=require` + `sslcert=<CA path>` +
// `sslaccept=strict` for the schema engine. So the CLI uses MIGRATE_DATABASE_URL when it is set and
// the application keeps using DATABASE_URL. (Schema-engine TLS against the Supabase pooler was verified
// in S4.3: strict TLS succeeded with the Supabase root CA, and failed closed (P1011) both with an
// unrelated CA and with a hostname not covered by the server certificate.)
//
// Rules:
//   - MIGRATE_DATABASE_URL set  -> used, but only if DATABASE_URL is unset or names the SAME database
//     (user@host/db). Different databases = refuse: e.g. a shell override such as
//     `DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy` while .env holds MIGRATE_DATABASE_URL
//     must never silently migrate the .env database.
//   - only DATABASE_URL set     -> used.
//   - neither set               -> undefined. `prisma generate` (e.g. in the Docker build, which has no
//     secrets) works; commands that need a database fail with Prisma's own "datasource.url" error.
// Errors name variables only, never their values.

type RawEnv = Record<string, string | undefined>;

function databaseIdentity(name: string, raw: string): string {
  try {
    const u = new URL(raw);
    return `${decodeURIComponent(u.username)}@${u.hostname.toLowerCase()}${u.pathname}`;
  } catch {
    throw new Error(`${name} is not a valid connection URL.`);
  }
}

export function resolvePrismaCliDatabaseUrl(env: RawEnv): string | undefined {
  const migrateUrl = env.MIGRATE_DATABASE_URL?.trim() || undefined;
  const runtimeUrl = env.DATABASE_URL?.trim() || undefined;
  if (!migrateUrl) return runtimeUrl;

  if (runtimeUrl && databaseIdentity("DATABASE_URL", runtimeUrl) !== databaseIdentity("MIGRATE_DATABASE_URL", migrateUrl)) {
    throw new Error(
      "MIGRATE_DATABASE_URL and DATABASE_URL identify different databases. Refusing to run the Prisma CLI " +
        "against an ambiguous target; set both to the same database or unset MIGRATE_DATABASE_URL.",
    );
  }
  return migrateUrl;
}
