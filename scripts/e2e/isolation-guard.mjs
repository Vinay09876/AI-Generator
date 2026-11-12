// Startup guard for the isolated E2E run. Must be run (with the egress guard preloaded) BEFORE the
// app, the worker or migrations start. Exits 1 on ANY failed check; callers must stop.
//   NODE_OPTIONS="--import file:///.../deny-egress.mjs" node isolation-guard.mjs
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const failures = [];
const passes = [];
const check = (ok, msg) => (ok ? passes : failures).push(msg);
const env = process.env;
const LOOP = new Set(["127.0.0.1", "localhost", "::1"]);
const SENTINEL = "e2e-blocked-not-a-real-key";

// 1. Working directory: the isolated copy, never the repository; no env files.
const cwd = process.cwd();
const repo = env.E2E_REPO_DIR ? path.resolve(env.E2E_REPO_DIR) : null;
check(Boolean(env.E2E_ROOT) && cwd.startsWith(path.resolve(env.E2E_ROOT)), `cwd is inside E2E_ROOT (${cwd})`);
check(repo && !cwd.startsWith(repo), "cwd is not the repository");
check(!fs.existsSync(path.join(cwd, ".git")), "no .git in the copy");
const envFiles = fs.readdirSync(cwd).filter((n) => /^\.env/i.test(n) && n !== ".env.example");
check(envFiles.length === 0, `no .env files in the copy (${envFiles.join(",") || "none"})`);

// 2. Configuration points only at loopback services and carries no real credentials.
const parseUrl = (v) => {
  try {
    return new URL(v);
  } catch {
    return null;
  }
};
const db = parseUrl(env.DATABASE_URL);
check(db && LOOP.has(db.hostname) && db.port === "55432", `DATABASE_URL is the throwaway cluster (${db?.hostname}:${db?.port})`);
check(db && /\/yourai_e2e$|\/yourai_it$/.test(db.pathname), `DATABASE_URL database is a test database (${db?.pathname})`);
const sb = parseUrl(env.SUPABASE_URL);
check(sb && LOOP.has(sb.hostname) && sb.protocol === "http:", `SUPABASE_URL is the local stand-in (${sb?.origin})`);
check(!/supabase\.co/i.test(`${env.SUPABASE_URL}${env.DATABASE_URL}`), "no supabase.co host anywhere");
for (const k of ["CLOUDFLARE_AI_API_TOKEN", "FAL_KEY"]) check(env[k] === SENTINEL, `${k} is the blocked sentinel`);
check(env.SUPABASE_SECRET_KEY === "e2e-local-standin-key", "SUPABASE_SECRET_KEY is the stand-in key");
check(!env.TEST_DATABASE_URL, "TEST_DATABASE_URL is unset");
check(env.NEXT_TELEMETRY_DISABLED === "1", "Next telemetry disabled");

// 3. Egress guard is loaded and effective; loopback still works.
check(globalThis.__E2E_EGRESS_GUARD__ === true, "egress guard preloaded in this process");
check(/deny-egress\.mjs/.test(env.NODE_OPTIONS ?? ""), "NODE_OPTIONS preloads the egress guard for child processes");
async function probe() {
  try {
    await fetch("https://example.com/", { signal: AbortSignal.timeout(5000) });
    check(false, "fetch to example.com is blocked");
  } catch (e) {
    check(String(e?.cause?.code ?? e?.code ?? e?.cause?.message ?? e).includes("E2E_EGRESS_BLOCKED") || /egress-blocked/.test(String(e?.cause?.message ?? e?.message)), "fetch to example.com is blocked");
  }
  await new Promise((resolve) => {
    const s = net.connect({ host: "1.1.1.1", port: 443 });
    s.on("error", (e) => {
      check(e.code === "E2E_EGRESS_BLOCKED", "raw TCP to 1.1.1.1:443 is blocked");
      resolve();
    });
    s.on("connect", () => {
      check(false, "raw TCP to 1.1.1.1:443 is blocked");
      s.destroy();
      resolve();
    });
  });
  try {
    const r = await fetch(`${env.SUPABASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    check(r.ok, "loopback stand-in reachable");
  } catch {
    check(false, "loopback stand-in reachable");
  }
}

// 4. The database is the throwaway cluster (data directory inside E2E_ROOT), not the installed service.
async function dbCheck() {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    const r = await client.query("select current_setting('data_directory') as d, current_setting('port') as p");
    await client.end();
    const d = path.resolve(r.rows[0].d);
    check(d.toLowerCase().startsWith(path.resolve(env.E2E_ROOT).toLowerCase()) || d.toLowerCase().includes("e2e"), `database data_directory is the scratch cluster (${d})`);
    check(r.rows[0].p === "55432", "database port 55432");
  } catch (e) {
    check(false, `database reachable (${e?.message})`);
  }
}

await probe();
// Never open a connection to a database that already failed the address checks above.
if (failures.some((f) => f.startsWith("DATABASE_URL"))) check(false, "database check skipped: DATABASE_URL rejected");
else await dbCheck();
for (const p of passes) console.log(`GUARD OK    ${p}`);
for (const f of failures) console.error(`GUARD FAIL  ${f}`);
if (failures.length) {
  console.error(`\nISOLATION CHECK FAILED (${failures.length}). Do not start the application.`);
  process.exit(1);
}
console.log(`\nIsolation verified (${passes.length} checks).`);
