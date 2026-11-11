// Stage 8 security fix: GET /api/cron/video-webhooks must FAIL CLOSED in production
// when CRON_SECRET is missing, and require a matching bearer token when it is set.
//
// Fully offline: no database, no storage, no provider calls. The route handler is
// exercised with a recording db stub so we can prove unauthorized requests never
// reach reconciliation, and authorized ones do.
//
// Run: npm run test:video-cron-auth

for (const k of ["DATABASE_URL", "TEST_DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "FAL_KEY"]) {
  delete process.env[k];
}

const { isVideoCronRequestAuthorized } = await import("@/features/video/cron-auth");
const { handleVideoCronRequest } = await import("@/app/api/cron/video-webhooks/route");

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) {
    pass++;
    console.log(`PASS  ${m}`);
  } else {
    fail++;
    console.error(`FAIL  ${m}`);
  }
};

const SECRET = "cron-secret-0123456789abcdef";
const URL_ = "https://yourai.test/api/cron/video-webhooks";
const req = (auth?: string) => new Request(URL_, { method: "GET", headers: auth ? { authorization: auth } : {} });

const env = process.env as Record<string, string | undefined>;
function setEnv(nodeEnv: string | undefined, secret: string | undefined) {
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  if (secret === undefined) delete env.CRON_SECRET;
  else env.CRON_SECRET = secret;
}

class ReachedReconciliation extends Error {
  constructor() {
    super("REACHED_RECONCILIATION");
  }
}
/** A db stub that records any access and throws a sentinel, proving the handler got past auth. */
function sentinelDb() {
  const state = { touched: false };
  const db = new Proxy(
    {},
    {
      get() {
        state.touched = true;
        throw new ReachedReconciliation();
      },
    },
  );
  return { db, state };
}

async function callHandler(auth?: string) {
  const { db, state } = sentinelDb();
  const res = await handleVideoCronRequest(req(auth), { db, storage: {} });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, touched: state.touched };
}

const originalNodeEnv = env.NODE_ENV;
const originalSecret = env.CRON_SECRET;
const errorLog = console.error;

try {
  // ---------------- Pure helper ----------------
  console.log("\n== isVideoCronRequestAuthorized ==");
  const prod = (secret?: string) => ({ NODE_ENV: "production", CRON_SECRET: secret });
  ok(isVideoCronRequestAuthorized(req(), prod(undefined)) === false, "prod, no secret, no header → rejected");
  ok(isVideoCronRequestAuthorized(req("Bearer anything"), prod(undefined)) === false, "prod, no secret, any bearer → rejected");
  ok(isVideoCronRequestAuthorized(req("Bearer "), prod("")) === false, "prod, empty secret + empty bearer → rejected");
  ok(isVideoCronRequestAuthorized(req("Bearer    "), prod("   ")) === false, "prod, whitespace-only secret → treated as missing");
  ok(isVideoCronRequestAuthorized(req(), prod(SECRET)) === false, "prod, secret set, no header → rejected");
  ok(isVideoCronRequestAuthorized(req("Bearer wrong"), prod(SECRET)) === false, "prod, wrong bearer → rejected");
  ok(isVideoCronRequestAuthorized(req(`Bearer ${SECRET}x`), prod(SECRET)) === false, "prod, bearer with extra char → rejected");
  ok(isVideoCronRequestAuthorized(req(`Bearer ${SECRET.slice(0, -1)}`), prod(SECRET)) === false, "prod, truncated bearer → rejected");
  ok(isVideoCronRequestAuthorized(req(SECRET), prod(SECRET)) === false, "prod, secret without Bearer scheme → rejected");
  ok(isVideoCronRequestAuthorized(req(`Basic ${SECRET}`), prod(SECRET)) === false, "prod, Basic scheme → rejected");
  ok(isVideoCronRequestAuthorized(req(`Bearer ${SECRET}`), prod(SECRET)) === true, "prod, correct bearer → accepted");
  ok(isVideoCronRequestAuthorized(req(), { NODE_ENV: "development" }) === true, "development, no secret → open (unchanged)");
  ok(isVideoCronRequestAuthorized(req("Bearer wrong"), { NODE_ENV: "development", CRON_SECRET: SECRET }) === true, "development, secret set + wrong bearer → still open (unchanged)");
  ok(isVideoCronRequestAuthorized(req(), {}) === true, "NODE_ENV unset (local scripts) → open (unchanged)");
  ok(isVideoCronRequestAuthorized(req(), { NODE_ENV: "test" }) === true, "NODE_ENV=test → open (unchanged)");

  // ---------------- Route handler (reads process.env) ----------------
  console.error = () => {}; // silence the handler's expected reconciliation error log
  console.log("\n== handleVideoCronRequest: production ==");

  setEnv("production", undefined);
  let r = await callHandler();
  ok(r.status === 401 && r.body.error === "Unauthorized", "prod, CRON_SECRET missing, no header → 401");
  ok(r.touched === false, "prod, CRON_SECRET missing → reconciliation never reached");
  r = await callHandler("Bearer guessed-secret");
  ok(r.status === 401 && r.touched === false, "prod, CRON_SECRET missing, arbitrary bearer → 401, nothing reached");
  r = await callHandler("Bearer undefined");
  ok(r.status === 401 && r.touched === false, "prod, CRON_SECRET missing, 'Bearer undefined' → 401");

  setEnv("production", "");
  r = await callHandler("Bearer ");
  ok(r.status === 401 && r.touched === false, "prod, CRON_SECRET empty string → 401");

  setEnv("production", SECRET);
  r = await callHandler("Bearer wrong-token");
  ok(r.status === 401 && r.touched === false, "prod, incorrect bearer → 401, nothing reached");
  r = await callHandler();
  ok(r.status === 401 && r.touched === false, "prod, missing Authorization header → 401");
  r = await callHandler(SECRET);
  ok(r.status === 401 && r.touched === false, "prod, raw secret without Bearer → 401");

  r = await callHandler(`Bearer ${SECRET}`);
  ok(r.status !== 401, "prod, correct bearer → passes authorization");
  ok(r.touched === true, "prod, correct bearer → reconciliation reached");
  ok(r.status === 500 && r.body.message === "REACHED_RECONCILIATION", "prod, correct bearer → handler proceeds to reconciliation (sentinel surfaced)");

  console.log("\n== handleVideoCronRequest: development ==");
  setEnv("development", undefined);
  r = await callHandler();
  ok(r.status !== 401 && r.touched === true, "development, no CRON_SECRET → open, reconciliation reached (unchanged)");
  setEnv("development", SECRET);
  r = await callHandler("Bearer wrong-token");
  ok(r.status !== 401 && r.touched === true, "development, secret set + wrong bearer → still open (unchanged)");
  setEnv(undefined, undefined);
  r = await callHandler();
  ok(r.status !== 401 && r.touched === true, "NODE_ENV unset → open (unchanged)");
} finally {
  console.error = errorLog;
  setEnv(originalNodeEnv, originalSecret);
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
