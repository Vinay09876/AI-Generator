// Shared safety guard for database test suites (test:accounting, test:integration).
//
// Fails CLOSED: the suite runs only if BOTH TEST_DATABASE_URL and DATABASE_URL can be tied to a
// Supabase project reference and those references differ. Comparing connection strings alone is
// not enough (the same project can be reached through different hosts, ports or users).
// Never prints credentials or connection strings — only a masked project reference.

const REF = "[a-z0-9]{20}";

/**
 * Supabase project reference of a Postgres connection string, or null if it cannot be
 * identified reliably. Recognised forms:
 *  - pooler (Supavisor):  user "postgres.<ref>" @ *.pooler.supabase.com
 *  - direct connection:   host "db.<ref>.supabase.co"
 * If both forms are present they must agree; anything else (non-Supabase host, plain
 * "postgres" user on the pooler, malformed URL) returns null.
 */
export function supabaseProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") return null;
  const host = u.hostname.toLowerCase();
  let user: string;
  try {
    user = decodeURIComponent(u.username);
  } catch {
    return null;
  }
  const fromUser = new RegExp(`^postgres\\.(${REF})$`).exec(user)?.[1] ?? null;
  const fromHost = new RegExp(`^db\\.(${REF})\\.supabase\\.co$`).exec(host)?.[1] ?? null;

  if (fromUser && fromHost) return fromUser === fromHost ? fromUser : null;
  if (fromHost) return fromHost;
  if (fromUser && /\.pooler\.supabase\.com$/.test(host)) return fromUser;
  return null;
}

export const maskRef = (ref: string) => `${ref.slice(0, 4)}…${ref.slice(-2)}`;

/**
 * Verify the test database is a different Supabase project from the main database, then
 * return the test URL. Exits the process (code 1) on any doubt. Call BEFORE importing any
 * app module, then assign the returned URL to process.env.DATABASE_URL.
 */
export function requireSeparateTestDatabase(env: NodeJS.ProcessEnv = process.env): { testUrl: string; maskedRef: string } {
  const refuse = (reason: string): never => {
    console.error(`Refusing to run: ${reason}`);
    process.exit(1);
  };
  const testUrl = env.TEST_DATABASE_URL?.trim();
  const mainUrl = env.DATABASE_URL?.trim();
  if (!testUrl) return refuse("TEST_DATABASE_URL is not set. Database suites never use DATABASE_URL.");
  if (!mainUrl) return refuse("DATABASE_URL is not set, so the test database cannot be proven separate from it.");
  if (testUrl === mainUrl) return refuse("TEST_DATABASE_URL is identical to DATABASE_URL.");

  const testRef = supabaseProjectRef(testUrl);
  const mainRef = supabaseProjectRef(mainUrl);
  if (!testRef) return refuse("the Supabase project reference of TEST_DATABASE_URL cannot be identified.");
  if (!mainRef) return refuse("the Supabase project reference of DATABASE_URL cannot be identified.");
  if (testRef === mainRef) return refuse("TEST_DATABASE_URL points at the same Supabase project as DATABASE_URL.");

  return { testUrl, maskedRef: maskRef(testRef) };
}
