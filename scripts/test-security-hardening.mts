// Milestone 4 / Work Item 3: rate limiting and client-IP trust (no database, no network).
//   npm run test:security
// Covers: trusted-IP extraction (no shared fallback bucket), per-account progressive sign-in delay inside
// authorize() (covers every Auth.js sign-in path; no hard lockout), registration budget counting only
// created accounts, per-user generation throttle, anonymous abuse-report limits and body validation.
import assert from "node:assert/strict";
import { CredentialsSignin } from "next-auth";

import { InMemoryRateLimiter, RATE_LIMITS, trustedClientIp } from "../src/lib/rate-limit";
import {
  authorizeCredentials, failureDelayMs, LOGIN_DELAY_CAP_MS, LOGIN_FREE_FAILURES, LOGIN_MAX_WAIT_MS,
  LoginAttemptScheduler, loginFailureKey, recentFailures, SignInRateLimited,
} from "../src/features/auth/authorize";
import { createAccountWithThrottle } from "../src/features/auth/register-throttle";
import { createGenerationHandlers, type GenerationHttpDeps } from "../src/features/generations/http";
import { handleAbuseReportRequest } from "../src/features/moderation/api/report-handler";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

console.log("\n[1] Client IP trust boundary");
const forged = { "x-forwarded-for": "198.51.100.7", "x-real-ip": "198.51.100.8", "cf-connecting-ip": "198.51.100.9", "true-client-ip": "198.51.100.9", "cf-ray": "8f00-NRT" };
await test("default (no TRUST_PROXY): forged forwarding headers yield NO IP (no shared fallback bucket)", () => {
  assert.equal(trustedClientIp(forged, { trustModel: "none" }), null);
  assert.equal(trustedClientIp({}, { trustModel: "none" }), null);
});
await test("TRUST_PROXY unset in this process -> null", () => {
  const prev = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  try { assert.equal(trustedClientIp(forged), null); } finally { if (prev !== undefined) process.env.TRUST_PROXY = prev; }
});
await test("cloudflare model: only CF-Connecting-IP with CF-Ray and a single valid IP; never X-Forwarded-For", () => {
  assert.equal(trustedClientIp(forged, { trustModel: "cloudflare" }), "198.51.100.9");
  assert.equal(trustedClientIp({ "x-forwarded-for": "198.51.100.7" }, { trustModel: "cloudflare" }), null);
  assert.equal(trustedClientIp({ "cf-connecting-ip": "198.51.100.9" }, { trustModel: "cloudflare" }), null);
  assert.equal(trustedClientIp({ "cf-connecting-ip": "1.1.1.1, 2.2.2.2", "cf-ray": "x" }, { trustModel: "cloudflare" }), null);
});
await test("limiter.peek() reports without recording a hit", () => {
  const l = new InMemoryRateLimiter();
  const cfg = { max: 2, windowMs: 60_000 };
  for (let i = 0; i < 5; i++) assert.equal(l.peek("k", cfg).allowed, true);
  l.check("k", cfg); l.check("k", cfg);
  assert.equal(l.peek("k", cfg).allowed, false);
  assert.equal(l.peek("other", cfg).allowed, true);
});

console.log("\n[2] Sign-in: progressive per-account delay inside authorize() (no hard lockout)");
const user = { id: "usr_a", name: "A", email: "a@example.com", image: null, passwordHash: "hash", isDeleted: false, isSuspended: false };
const GOOD = "Correct-Horse-1";
/** Fake clock: sleep() advances time, so tests never really wait. */
function authDeps(over: Partial<{ row: typeof user | null }> = {}) {
  let verifyCalls = 0;
  let t = 1_000_000;
  const sleeps: number[] = [];
  const limiter = new InMemoryRateLimiter();
  const scheduler = new LoginAttemptScheduler();
  return {
    limiter, sleeps,
    get verifyCalls() { return verifyCalls; },
    advance: (ms: number) => { t += ms; },
    deps: {
      limiter, scheduler,
      now: () => t,
      sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
      findUserByEmail: async (email: string) => (email === user.email ? ("row" in over ? over.row! : user) : null),
      verifyPassword: async (pw: string, hash: string | null | undefined) => { verifyCalls++; return Boolean(hash) && pw === GOOD; },
    },
  };
}
const failures = (ctx: ReturnType<typeof authDeps>, email = "a@example.com") =>
  recentFailures(ctx.limiter, loginFailureKey(email), ctx.deps.now());

await test("delay schedule: free for 5 failures, then 1s, 2s, 4s ... capped at 30s", () => {
  assert.deepEqual([0, 4, 5, 6, 7, 9, 10, 50].map(failureDelayMs), [0, 0, 1000, 2000, 4000, 16000, 30000, 30000]);
});
await test("after 5 attacker failures the legitimate correct password STILL signs in (only delayed)", async () => {
  const ctx = authDeps();
  for (let i = 0; i < LOGIN_FREE_FAILURES; i++) {
    assert.equal(await authorizeCredentials({ email: "A@Example.com ", password: "wrong-pass" }, ctx.deps), null);
  }
  assert.equal(failures(ctx), 5);
  const ok = await authorizeCredentials({ email: "a@example.com", password: GOOD }, ctx.deps);
  assert.deepEqual(ok, { id: "usr_a", name: "A", email: "a@example.com", image: null }, "no password hash in the session payload");
  assert.equal(failures(ctx), 0, "success resets the account");
  assert.ok(Math.max(...ctx.sleeps) <= 1000, `waited ${Math.max(...ctx.sleeps)} ms`);
});
await test("after MANY failures a correct password still signs in, waiting at most the delay cap", async () => {
  const ctx = authDeps();
  for (let i = 0; i < 20; i++) await authorizeCredentials({ email: "a@example.com", password: `wrong-${i}-x` }, ctx.deps);
  assert.equal(failures(ctx), 20);
  const before = ctx.sleeps.length;
  assert.ok(await authorizeCredentials({ email: "a@example.com", password: GOOD }, ctx.deps));
  assert.ok(ctx.sleeps[before] <= LOGIN_DELAY_CAP_MS);
});
await test("sequential guessing is spaced: each throttled guess waits for the growing delay", async () => {
  const ctx = authDeps();
  for (let i = 0; i < 9; i++) await authorizeCredentials({ email: "a@example.com", password: `wrong-${i}-x` }, ctx.deps);
  // 5 free attempts, then evaluations spaced by 1s, 2s, 4s, 8s
  assert.deepEqual(ctx.sleeps.filter((ms) => ms > 0), [1000, 2000, 4000, 8000]);
});
await test("a burst of parallel guesses is staggered; beyond the 45s queue they are refused without bcrypt", async () => {
  const ctx = authDeps();
  for (let i = 0; i < 10; i++) await authorizeCredentials({ email: "a@example.com", password: `wrong-${i}-x` }, ctx.deps); // delay now 30s
  const now = ctx.deps.now();
  const waits = [0, 1, 2, 3].map(() => ctx.deps.scheduler.reserve(loginFailureKey("a@example.com"), failures(ctx), now)?.waitMs ?? null);
  // At the 30s cap, one more guess fits inside the 45s queue (delayed, not refused); the next is refused.
  assert.equal(waits[0], LOGIN_DELAY_CAP_MS, "first queued guess is delayed, not refused");
  assert.deepEqual(waits.slice(1), [null, null, null], "a deep queue refuses further guesses");
  const before = ctx.verifyCalls;
  await assert.rejects(() => authorizeCredentials({ email: "a@example.com", password: GOOD }, ctx.deps), (e: unknown) => {
    const err = e as { type?: string; code?: string };
    assert.ok(e instanceof SignInRateLimited);
    // Auth.js routes it as a credentials failure via its static `type`; `instanceof CredentialsSignin`
    // is not asserted because tsx loads src/ as CommonJS and this .mts test as ESM (two copies of the
    // class). In the Next.js bundle there is a single copy (the documented Auth.js v5 pattern).
    assert.equal(err.type, CredentialsSignin.type);
    assert.equal(err.code, "rate_limited");
    return true;
  });
  assert.equal(ctx.verifyCalls, before, "refused attempts never run bcrypt or count as failures");
  // The refusal is temporary: once the queue drains, the owner gets in.
  ctx.advance(2 * LOGIN_MAX_WAIT_MS);
  assert.ok(await authorizeCredentials({ email: "a@example.com", password: GOOD }, ctx.deps));
});
await test("~50 SIMULTANEOUS attempts on a fresh account: 10 reach bcrypt on the escalating schedule, 40 are refused", async () => {
  const ctx = authDeps();
  const frozen = ctx.deps.now(); // all requests arrive at the same instant
  const deps = { ...ctx.deps, now: () => frozen, sleep: async (ms: number) => { ctx.sleeps.push(ms); } };
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) => authorizeCredentials({ email: "a@example.com", password: `wrong-${i}-x` }, deps)),
  );
  const refused = results.filter((r) => r.status === "rejected");
  assert.equal(ctx.verifyCalls, 10, `bcrypt ran ${ctx.verifyCalls} times`);
  assert.equal(refused.length, 40);
  assert.ok(refused.every((r) => (r as PromiseRejectedResult).reason instanceof SignInRateLimited));
  // 5 free immediate checks, then slots 1s, 3s, 7s, 15s, 31s after arrival (61s would exceed the 45s queue)
  assert.deepEqual(ctx.sleeps, [0, 0, 0, 0, 0, 1000, 3000, 7000, 15000, 31000]);
  assert.equal(failures(ctx), 10, "only evaluated attempts count as failures");
  assert.equal(deps.scheduler.pendingFor(loginFailureKey("a@example.com")), 0, "every reservation was released");
});
await test("successful sign-in while other attempts are pending: stale finally blocks cannot corrupt the reset state", async () => {
  const ctx = authDeps();
  const key = loginFailureKey("a@example.com");
  const gates: (() => void)[] = [];
  const deps = { ...ctx.deps, sleep: () => new Promise<void>((resolve) => { gates.push(resolve); }) };
  const attackers = [1, 2, 3].map((i) => authorizeCredentials({ email: "a@example.com", password: `wrong-${i}-x` }, deps));
  const owner = authorizeCredentials({ email: "a@example.com", password: GOOD }, deps);
  assert.equal(deps.scheduler.pendingFor(key), 4);

  gates[3](); // the owner's turn comes first
  assert.ok(await owner, "owner signs in while attacker attempts are still pending");
  assert.equal(deps.scheduler.pendingFor(key), 0, "success resets the queue");

  const fresh = authorizeCredentials({ email: "a@example.com", password: "wrong-new-x" }, deps); // new generation
  assert.equal(deps.scheduler.pendingFor(key), 1);
  gates[0](); gates[1](); gates[2]();
  assert.deepEqual(await Promise.all(attackers), [null, null, null]);
  assert.equal(deps.scheduler.pendingFor(key), 1, "old tickets must not decrement the new queue");
  gates[4]();
  assert.equal(await fresh, null);
  assert.equal(deps.scheduler.pendingFor(key), 0);
  assert.equal(failures(ctx), 4, "post-reset failures are counted normally");
});
await test("pending state is released on error paths (database / bcrypt failure) and is not counted as a failure", async () => {
  const ctx = authDeps();
  const key = loginFailureKey("a@example.com");
  const deps = { ...ctx.deps, findUserByEmail: async () => { throw new Error("db down"); } };
  await assert.rejects(() => authorizeCredentials({ email: "a@example.com", password: GOOD }, deps), /db down/);
  const deps2 = { ...ctx.deps, verifyPassword: async () => { throw new Error("bcrypt failed"); } };
  await assert.rejects(() => authorizeCredentials({ email: "a@example.com", password: GOOD }, deps2), /bcrypt failed/);
  assert.equal(ctx.deps.scheduler.pendingFor(key), 0);
  assert.equal(failures(ctx), 0);
});
await test("queue memory is bounded: idle queues are evicted first, evicted tickets release safely", () => {
  const s = new LoginAttemptScheduler(3);
  const held = s.reserve("busy", 0, 0)!; // pending, would otherwise be kept
  s.release(s.reserve("idle1", 0, 0)!);
  for (let i = 0; i < 20; i++) { const r = s.reserve(`k${i}`, 0, 100_000 + i)!; s.release(r); }
  assert.ok(s.size <= 3, `size ${s.size}`);
  s.release(held); // its queue may have been evicted; must not throw or go negative
  assert.ok(s.pendingFor("busy") >= 0);
});
await test("unknown email: bcrypt still runs (timing) and the failure is counted for that email only", async () => {
  const ctx = authDeps();
  assert.equal(await authorizeCredentials({ email: "ghost@example.com", password: "whatever1" }, ctx.deps), null);
  assert.equal(ctx.verifyCalls, 1);
  assert.equal(failures(ctx, "ghost@example.com"), 1);
  assert.equal(failures(ctx), 0);
});
await test("suspended or deleted accounts are refused even with the right password", async () => {
  for (const row of [{ ...user, isSuspended: true }, { ...user, isDeleted: true }]) {
    const ctx = authDeps({ row });
    assert.equal(await authorizeCredentials({ email: "a@example.com", password: GOOD }, ctx.deps), null);
  }
});

console.log("\n[2b] Registration budget counts only successfully created accounts");
await test("successful registrations consume the budget; the 101st in an hour is refused", async () => {
  const limiter = new InMemoryRateLimiter();
  let created = 0;
  for (let i = 0; i < RATE_LIMITS.REGISTER_GLOBAL.max; i++) {
    const r = await createAccountWithThrottle(null, async () => ++created, limiter);
    assert.equal(r.ok, true);
  }
  const blocked = await createAccountWithThrottle(null, async () => ++created, limiter);
  assert.equal(blocked.ok, false);
  assert.equal(created, RATE_LIMITS.REGISTER_GLOBAL.max, "create must not run once the budget is spent");
});
await test("duplicate emails and failed creations never consume the budget", async () => {
  const limiter = new InMemoryRateLimiter();
  class EmailAlreadyRegistered extends Error {}
  for (let i = 0; i < 500; i++) {
    await assert.rejects(() => createAccountWithThrottle(null, async () => { throw new EmailAlreadyRegistered("dup"); }, limiter));
  }
  assert.equal(limiter.peek("register:global", RATE_LIMITS.REGISTER_GLOBAL).remaining, RATE_LIMITS.REGISTER_GLOBAL.max);
  assert.equal((await createAccountWithThrottle(null, async () => "ok", limiter)).ok, true);
});
await test("per-IP registration bucket applies only with a trusted IP, and also counts successes only", async () => {
  const limiter = new InMemoryRateLimiter();
  for (let i = 0; i < RATE_LIMITS.REGISTER_IP.max; i++) assert.equal((await createAccountWithThrottle("203.0.113.5", async () => i, limiter)).ok, true);
  assert.equal((await createAccountWithThrottle("203.0.113.5", async () => 0, limiter)).ok, false);
  assert.equal((await createAccountWithThrottle("203.0.113.6", async () => 0, limiter)).ok, true, "another trusted IP is unaffected");
  assert.equal((await createAccountWithThrottle(null, async () => 0, limiter)).ok, true, "no trusted IP -> global cap only");
});

console.log("\n[3] Image generation burst limit is per user, not per (shared) IP");
await test("POST /api/generations/image keys the throttle by user id and returns 429 when exceeded", async () => {
  const keys: string[] = [];
  const unreachable = () => { throw new Error("must not be reached when throttled"); };
  const deps = {
    trustedOrigins: () => ["https://pixora.test"],
    getUserId: async () => "usr_gen",
    checkRateLimit: (key: string) => { keys.push(key); return { allowed: false, retryAfterSeconds: 42 }; },
    generate: unreachable, loadJob: unreachable, loadBalance: unreachable, reconcileForUser: unreachable,
    scheduleBackground: unreachable, reconcileGlobal: unreachable, signAssetUrl: unreachable,
  } as unknown as GenerationHttpDeps;
  const res = await createGenerationHandlers(deps).postImage(new Request("https://pixora.test/api/generations/image", {
    method: "POST", headers: { origin: "https://pixora.test", "x-forwarded-for": "198.51.100.1", "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "42");
  assert.deepEqual(keys, ["gen:user:usr_gen"]);
});

console.log("\n[4] Abuse reports: no single shared anonymous bucket; bounded input");
const failingDb = { $transaction: async () => { throw new Error("no database in tests"); } };
let seq = 0;
const report = (body: unknown, opts: { userId?: string | null; raw?: string; headers?: Record<string, string> } = {}) =>
  handleAbuseReportRequest(
    new Request("https://pixora.test/api/moderation/reports", {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: opts.raw ?? JSON.stringify(body),
    }),
    { getUserId: async () => opts.userId ?? null, trustedOrigins: () => ["https://pixora.test"], dbClient: failingDb },
  );
const valid = (targetId: string) => ({ targetType: "ASSET", targetId, category: "spam_or_abuse", details: "spam content here" });
await test("anonymous: per-target limit trips, but a DIFFERENT target and a signed-in user are unaffected", async () => {
  const t = `ast_target_${++seq}`;
  for (let i = 0; i < RATE_LIMITS.REPORT_ANON_TARGET.max; i++) assert.notEqual((await report(valid(t))).status, 429);
  assert.equal((await report(valid(t))).status, 429);
  assert.notEqual((await report(valid(`ast_other_${++seq}`))).status, 429, "other targets must still be reportable");
  assert.notEqual((await report(valid(t), { userId: "usr_reporter" })).status, 429, "signed-in reporters have their own limit");
});
await test("forged X-Forwarded-For does not create separate anonymous buckets (header ignored)", async () => {
  const t = `ast_xff_${++seq}`;
  for (let i = 0; i < RATE_LIMITS.REPORT_ANON_TARGET.max; i++) await report(valid(t), { headers: { "x-forwarded-for": `198.51.100.${i}` } });
  assert.equal((await report(valid(t), { headers: { "x-forwarded-for": "203.0.113.200" } })).status, 429);
});
await test("oversized body -> 413; malformed targetId / reporterEmail -> 400 (before any database work)", async () => {
  assert.equal((await report(null, { raw: JSON.stringify({ ...valid("ast_big"), details: "x".repeat(20_000) }) })).status, 413);
  assert.equal((await report(valid("../../etc/passwd"))).status, 400);
  assert.equal((await report({ ...valid("ast_mail"), reporterEmail: "a".repeat(300) })).status, 400);
  assert.equal((await report(null, { raw: "[1,2,3]" })).status, 400);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
