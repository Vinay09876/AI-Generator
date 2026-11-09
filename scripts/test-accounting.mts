// Accounting test suite: credit ledger, Neuron budget reservations, job lifecycle,
// daily limits, idempotency and concurrency. Makes NO provider (Cloudflare) calls.
//
// SAFETY: runs ONLY against a dedicated test database given by TEST_DATABASE_URL.
// It never falls back to DATABASE_URL and refuses to run if both point to the same
// database. The test database must have all Prisma migrations applied:
//   DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
//
// Run:  npm run test:accounting
// Writes temporary users/jobs/budget rows (tagged with a timestamp) and removes them at the end.
import { config } from "dotenv";

config({ quiet: true });

const testUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testUrl) {
  console.error("Refusing to run: TEST_DATABASE_URL is not set. This suite never uses DATABASE_URL.");
  process.exit(1);
}
if (testUrl === process.env.DATABASE_URL?.trim()) {
  console.error("Refusing to run: TEST_DATABASE_URL is identical to DATABASE_URL. Use a dedicated test database.");
  process.exit(1);
}
// Point the app's Prisma client at the test database BEFORE any app module is loaded.
// App modules are imported dynamically below, so this assignment runs first.
process.env.DATABASE_URL = testUrl;
try {
  const u = new URL(testUrl);
  console.log(`Using test database: ${u.hostname}${u.pathname} (credentials hidden)\n`);
} catch {
  console.log("Using test database from TEST_DATABASE_URL\n");
}

const { prisma } = await import("@/lib/prisma");
const { hashPassword } = await import("@/features/auth/password");
const { createUserWithWallet } = await import("@/features/users/create-user");
const { debitWallet } = await import("@/features/credits/ledger");
const {
  completeJob,
  countDailyImageJobs,
  createImageJob,
  failJobAfterProviderSuccess,
  failJobProviderNotRun,
  markJobStarted,
  markProviderOutcomeUnknown,
  reconcileStaleJobs,
  recordProviderSuccess,
} = await import("@/features/generations/lifecycle");
const { utcDayRange } = await import("@/lib/utc");
type AccountingError = import("@/features/generations/errors").AccountingError;
const TS = Date.now();
const PROVIDER_PREFIX = `test-stage3-${TS}`;
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const key = (s: string) => `k_${TS}_${s}`.slice(0, 100);
let n = 0;
const provider = () => `${PROVIDER_PREFIX}-${++n}`;
const users: string[] = [];
const PW = await hashPassword("Stage3-Test-Pass!");

let userSeq = 0;
async function newUser(balance = 100) {
  const seq = userSeq++; // taken synchronously so parallel calls get unique emails
  const u = await createUserWithWallet({ name: "Stage3 Test", email: `e2e-stage3-${TS}-${seq}@example.com`, passwordHash: PW });
  users.push(u.id);
  if (balance !== 100) await prisma.creditWallet.update({ where: { userId: u.id }, data: { balance } });
  return u.id;
}
// Match by name: the ESM test file and CJS app code load separate copies of the class.
const code = (e: unknown) => ((e as AccountingError)?.name === "AccountingError" ? (e as AccountingError).code : `UNEXPECTED:${(e as Error)?.message?.slice(0, 120)}`);
const tryCreate = (p: Parameters<typeof createImageJob>[0], o: Parameters<typeof createImageJob>[1]) =>
  createImageJob(p, o).then((r) => ({ ok: true as const, ...r }), (e) => ({ ok: false as const, code: code(e) }));
const balance = async (userId: string) => (await prisma.creditWallet.findUniqueOrThrow({ where: { userId } })).balance;
const budget = (p: string) => prisma.providerDailyBudget.findFirst({ where: { provider: p } });
const ledger = (userId: string) => prisma.creditTransaction.findMany({ where: { userId, jobId: { not: null } }, orderBy: { createdAt: "asc" } });

try {
  // ---- Validation: nothing debited or reserved ----
  {
    const u = await newUser(); const p = provider();
    for (const [label, req] of [
      ["empty prompt", { prompt: "   ", quality: "fast", idempotencyKey: key("v1") }],
      ["2049-char prompt", { prompt: "x".repeat(2049), quality: "fast", idempotencyKey: key("v2") }],
      ["unknown quality", { prompt: "cat", quality: "ultra", idempotencyKey: key("v3") }],
      ["bad idempotency key", { prompt: "cat", quality: "fast", idempotencyKey: "short" }],
    ] as const) {
      const r = await tryCreate({ userId: u, ...req }, { provider: p });
      ok(!r.ok && r.code === "INVALID_INPUT", `validation: ${label} -> INVALID_INPUT`);
    }
    ok((await balance(u)) === 100 && !(await budget(p)) && (await prisma.generationJob.count({ where: { userId: u } })) === 0,
      "validation failures: no debit, no budget row, no job");
    const max = await tryCreate({ userId: u, prompt: "y".repeat(2048), quality: "fast", idempotencyKey: key("v5") }, { provider: p });
    ok(max.ok, "2048-char prompt accepted (documented maximum)");
    if (max.ok) await failJobProviderNotRun(max.job.id, "cleanup");
  }

  // ---- Successful Fast and Detailed reservations ----
  {
    const u = await newUser(); const p = provider();
    const r = await tryCreate({ userId: u, prompt: "fast cat", quality: "fast", idempotencyKey: key("f1") }, { provider: p });
    ok(r.ok && r.job.status === "PENDING" && r.job.estimatedCredits === 1, "fast: job PENDING, estimatedCredits 1");
    const b = await budget(p);
    const res = r.ok ? await prisma.providerBudgetReservation.findUnique({ where: { jobId: r.job.id } }) : null;
    const l = await ledger(u);
    ok((await balance(u)) === 99 && l.length === 1 && l[0].type === "GENERATION_DEBIT" && l[0].amount === -1 && l[0].balanceAfter === 99,
      "fast: wallet 100 -> 99 with one GENERATION_DEBIT (-1, balanceAfter 99, linked to job)");
    ok(res?.status === "RESERVED" && res.reservedCentiNeurons === 17280 && b?.reservedCentiNeurons === 17280, "fast: 17,280 centi-neurons reserved (172.80)");
    ok(!!r.ok && !!b && r.job.createdAt.toISOString().slice(0, 10) === b.day.toISOString().slice(0, 10), "job UTC day == budget day");
    if (r.ok) await failJobProviderNotRun(r.job.id, "cleanup");

    const d = await tryCreate({ userId: u, prompt: "detailed cat", quality: "detailed", idempotencyKey: key("d1") }, { provider: p });
    const dres = d.ok ? await prisma.providerBudgetReservation.findUnique({ where: { jobId: d.job.id } }) : null;
    ok(d.ok && (await balance(u)) === 98 && dres?.reservedCentiNeurons === 32640, "detailed: costs 2 credits (100 after refund -> 98), reserves 32,640");
    if (d.ok) await failJobProviderNotRun(d.job.id, "cleanup");
  }

  // ---- Insufficient credits ----
  {
    const u = await newUser(1); const p = provider();
    const r = await tryCreate({ userId: u, prompt: "x", quality: "detailed", idempotencyKey: key("ic") }, { provider: p });
    const b = await budget(p);
    ok(!r.ok && r.code === "INSUFFICIENT_CREDITS", "balance 1, detailed (2) -> INSUFFICIENT_CREDITS");
    ok((await balance(u)) === 1 && (await prisma.generationJob.count({ where: { userId: u } })) === 0 && (b?.reservedCentiNeurons ?? 0) === 0,
      "insufficient credits: wallet unchanged, no job, budget reservation rolled back");
    const z = await newUser(0);
    const r0 = await tryCreate({ userId: z, prompt: "x", quality: "fast", idempotencyKey: key("ic0") }, { provider: p });
    ok(!r0.ok && r0.code === "INSUFFICIENT_CREDITS" && (await balance(z)) === 0, "balance 0, fast -> INSUFFICIENT_CREDITS, stays 0");
  }

  // ---- Insufficient Neuron budget ----
  {
    const p = provider(); const a = await newUser(); const c = await newUser();
    const r1 = await tryCreate({ userId: a, prompt: "x", quality: "fast", idempotencyKey: key("b1") }, { provider: p, dailyNeuronLimit: 20_000 });
    const r2 = await tryCreate({ userId: c, prompt: "x", quality: "fast", idempotencyKey: key("b2") }, { provider: p, dailyNeuronLimit: 20_000 });
    ok(r1.ok && !r2.ok && r2.code === "CAPACITY_EXHAUSTED", "limit 200 Neurons: first fast fits, second -> CAPACITY_EXHAUSTED");
    ok((await balance(c)) === 100 && (await prisma.generationJob.count({ where: { userId: c } })) === 0 && (await budget(p))?.reservedCentiNeurons === 17280,
      "capacity exhausted: second user not debited, no job, budget unchanged");
    if (r1.ok) await failJobProviderNotRun(r1.job.id, "cleanup");
  }

  // ---- Concurrent budget reservations never exceed the cap ----
  {
    const p = provider(); const us = await Promise.all(Array.from({ length: 8 }, () => newUser()));
    const rs = await Promise.all(us.map((u, i) => tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key(`cb${i}`) }, { provider: p, dailyNeuronLimit: 51_840 })));
    const okCount = rs.filter((r) => r.ok).length;
    const b = await budget(p);
    ok(okCount === 3 && rs.filter((r) => !r.ok).every((r) => !r.ok && r.code === "CAPACITY_EXHAUSTED"), `8 concurrent users, cap fits 3: ${okCount} succeeded, rest CAPACITY_EXHAUSTED`);
    ok(b?.reservedCentiNeurons === 51_840, `budget reserved exactly 51,840 (got ${b?.reservedCentiNeurons})`);
    for (const r of rs) if (r.ok) await failJobProviderNotRun(r.job.id, "cleanup");
  }

  // ---- Idempotency: sequential + concurrent + conflict ----
  {
    const u = await newUser(); const p = provider();
    const a = await tryCreate({ userId: u, prompt: "same", quality: "fast", idempotencyKey: key("i1") }, { provider: p });
    const b = await tryCreate({ userId: u, prompt: "same", quality: "fast", idempotencyKey: key("i1") }, { provider: p });
    ok(a.ok && b.ok && a.job.id === b.job.id && !a.replayed && b.replayed, "same key twice -> same job, second is a replay");
    const conflict = await tryCreate({ userId: u, prompt: "different", quality: "fast", idempotencyKey: key("i1") }, { provider: p });
    ok(!conflict.ok && conflict.code === "IDEMPOTENCY_CONFLICT", "same key, different prompt -> IDEMPOTENCY_CONFLICT");
    if (a.ok) await failJobProviderNotRun(a.job.id, "cleanup");

    const u2 = await newUser(); const p2 = provider();
    const rs = await Promise.all(Array.from({ length: 6 }, () => tryCreate({ userId: u2, prompt: "burst", quality: "fast", idempotencyKey: key("i2") }, { provider: p2 })));
    const ids = new Set(rs.map((r) => (r.ok ? r.job.id : r.code)));
    const debits = (await ledger(u2)).filter((t) => t.type === "GENERATION_DEBIT").length;
    const reservations = await prisma.providerBudgetReservation.count({ where: { job: { userId: u2 } } });
    ok(rs.every((r) => r.ok) && ids.size === 1, `6 concurrent requests, same key -> all return one job (${[...ids].join(",")})`);
    ok(debits === 1 && reservations === 1 && (await balance(u2)) === 99 && (await budget(p2))?.reservedCentiNeurons === 17280,
      "concurrent same key: exactly 1 debit, 1 reservation, balance 99, budget 17,280");
    for (const r of rs) if (r.ok) { await failJobProviderNotRun(r.job.id, "cleanup"); break; }
  }

  // ---- Daily limit: 9 -> 11 impossible under concurrency ----
  {
    const now = new Date();
    const seed9 = async (u: string) =>
      prisma.generationJob.createMany({ data: Array.from({ length: 9 }, (_, i) => ({ userId: u, type: "IMAGE" as const, status: "COMPLETED" as const, prompt: `seed ${i}`, createdAt: new Date(now.getTime() - 60_000 - i) })) });
    const count = (u: string) => prisma.generationJob.count({ where: { userId: u, status: { in: ["PENDING", "PROCESSING", "COMPLETED"] } } });

    const u = await newUser(); const p = provider(); await seed9(u);
    const two = await Promise.all([0, 1].map((i) => tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key(`dl${i}`) }, { provider: p, now })));
    ok(two.filter((r) => r.ok).length === 1 && two.some((r) => !r.ok && r.code === "DAILY_LIMIT_REACHED"),
      `user at 9: 2 concurrent requests -> exactly 1 created, other DAILY_LIMIT_REACHED (${two.map((r) => (r.ok ? "ok" : r.code)).join(", ")})`);
    ok((await count(u)) === 10, "user ends at exactly 10 counted jobs (not 11)");
    for (const r of two) if (r.ok) { await markJobStarted(r.job.id); await recordProviderSuccess(r.job.id, 17280); await completeJob(r.job.id); }

    const u2 = await newUser(); const p2 = provider(); await seed9(u2);
    const ten = await Promise.all(Array.from({ length: 10 }, (_, i) => tryCreate({ userId: u2, prompt: "x", quality: "fast", idempotencyKey: key(`dm${i}`) }, { provider: p2, now })));
    ok(ten.filter((r) => r.ok).length === 1 && ten.filter((r) => !r.ok).every((r) => !r.ok && r.code === "DAILY_LIMIT_REACHED"),
      "user at 9: 10 concurrent requests -> exactly 1 created, 9 DAILY_LIMIT_REACHED (serialized by user-row lock)");
    ok((await count(u2)) === 10 && (await balance(u2)) === 99, "still exactly 10 jobs, exactly 1 credit debited");
    const after = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("dl-after") }, { provider: p, now });
    ok(!after.ok && after.code === "DAILY_LIMIT_REACHED", "11th request on the same UTC day -> DAILY_LIMIT_REACHED");
    for (const r of ten) if (r.ok) await failJobProviderNotRun(r.job.id, "cleanup");
    const retry = await tryCreate({ userId: u2, prompt: "x", quality: "fast", idempotencyKey: key("dm-retry") }, { provider: p2, now });
    ok(retry.ok, "failed + refunded job does not count toward the daily limit (user can retry)");
    if (retry.ok) await failJobProviderNotRun(retry.job.id, "cleanup");
  }

  // ---- UTC day boundary ----
  {
    const u = await newUser(); const p = provider();
    const d = new Date(); const lastMs = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
    const nextDay = new Date(lastMs.getTime() + 1);
    await prisma.generationJob.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ userId: u, type: "IMAGE" as const, status: "COMPLETED" as const, prompt: `b${i}`, createdAt: new Date(lastMs.getTime() - 1000 - i) })) });
    const before = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("ub1") }, { provider: p, now: lastMs });
    const afterMidnight = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("ub2") }, { provider: p, now: nextDay });
    const rows = await prisma.providerDailyBudget.findMany({ where: { provider: p }, orderBy: { day: "asc" } });
    ok(!before.ok && before.code === "DAILY_LIMIT_REACHED", "23:59:59.999 UTC with 10 jobs -> DAILY_LIMIT_REACHED");
    ok(afterMidnight.ok && afterMidnight.job.createdAt.toISOString() === nextDay.toISOString(), "00:00:00.000 UTC next day -> allowed (limit reset)");
    const midRes = afterMidnight.ok ? await prisma.providerBudgetReservation.findUnique({ where: { jobId: afterMidnight.job.id }, include: { budget: true } }) : null;
    ok(midRes?.budget.day.toISOString().slice(0, 10) === nextDay.toISOString().slice(0, 10) && rows.length === 2 && rows[0].reservedCentiNeurons === 0, `midnight job reserved on the next day's budget row; previous day's row untouched (reserved ${rows[0]?.reservedCentiNeurons})`);
    if (afterMidnight.ok) await failJobProviderNotRun(afterMidnight.job.id, "cleanup");
  }

  // ---- Exactly-once refund + reservation release under concurrency ----
  {
    const u = await newUser(); const p = provider();
    const r = await tryCreate({ userId: u, prompt: "x", quality: "detailed", idempotencyKey: key("eo") }, { provider: p });
    if (!r.ok) throw new Error("setup failed");
    await markJobStarted(r.job.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => failJobProviderNotRun(r.job.id, "Provider rejected request (4xx)")));
    const refunds = (await ledger(u)).filter((t) => t.type === "REFUND");
    const res = await prisma.providerBudgetReservation.findUnique({ where: { jobId: r.job.id } });
    ok(results.filter((x) => x.settled).length === 1, "6 concurrent fail calls -> exactly 1 settles");
    ok(refunds.length === 1 && refunds[0].amount === 2 && (await balance(u)) === 100, "exactly one REFUND (+2), wallet back to 100");
    ok(res?.status === "RELEASED" && res.actualCentiNeurons === null && (await budget(p))?.reservedCentiNeurons === 0, "reservation RELEASED once, budget reserved back to 0");
  }

  // ---- Ambiguous provider outcome ----
  {
    const u = await newUser(); const p = provider();
    const r = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("amb") }, { provider: p });
    if (!r.ok) throw new Error("setup failed");
    await markJobStarted(r.job.id);
    await markProviderOutcomeUnknown(r.job.id, "timeout after 60s");
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: r.job.id } });
    const res0 = await prisma.providerBudgetReservation.findUnique({ where: { jobId: r.job.id } });
    ok(job.status === "PROCESSING" && res0?.status === "RESERVED" && (await balance(u)) === 99, "unknown outcome: job PROCESSING, reservation RESERVED, NO refund");
    const early = await reconcileStaleJobs({ now: new Date(job.startedAt!.getTime() + 60_000), userId: u });
    ok(early.settled === 0 && (await balance(u)) === 99, "reconcile 1 min after start: not settled (request could still be running)");
    const late = new Date(job.startedAt!.getTime() + 6 * 60_000);
    const rec = await Promise.all([0, 1, 2].map(() => reconcileStaleJobs({ now: late, userId: u })));
    const res = await prisma.providerBudgetReservation.findUnique({ where: { jobId: r.job.id } });
    const b = await budget(p);
    ok(rec.reduce((s, x) => s + x.settled, 0) === 1, "3 concurrent reconcilers after 6 min -> settled exactly once");
    ok(res?.status === "CONSUMED" && res.actualCentiNeurons === 17280 && b?.consumedCentiNeurons === 17280 && b.reservedCentiNeurons === 0,
      "unknown usage charged conservatively at reserved amount (consumed 17,280)");
    ok((await balance(u)) === 100 && (await ledger(u)).filter((t) => t.type === "REFUND").length === 1, "user refunded exactly once");
    const lateSuccess = await recordProviderSuccess(r.job.id, 17280);
    ok(lateSuccess === false && (await budget(p))?.consumedCentiNeurons === 17280, "late provider success after reconciliation is ignored (no double count)");
  }

  // ---- Provider success, later stage fails ----
  {
    const u = await newUser(); const p = provider();
    const r = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("ps") }, { provider: p });
    if (!r.ok) throw new Error("setup failed");
    await markJobStarted(r.job.id);
    const first = await recordProviderSuccess(r.job.id, 17280);
    const second = await recordProviderSuccess(r.job.id, 17280);
    ok(first && !second, "provider success recorded exactly once");
    const results = await Promise.all([0, 1, 2].map(() => failJobAfterProviderSuccess(r.job.id, "Storage upload failed")));
    const b = await budget(p);
    const res = await prisma.providerBudgetReservation.findUnique({ where: { jobId: r.job.id } });
    ok(results.filter((x) => x.settled).length === 1 && (await balance(u)) === 100 && (await ledger(u)).filter((t) => t.type === "REFUND").length === 1,
      "storage failure after provider success: settled once, refunded once");
    ok(res?.status === "CONSUMED" && b?.consumedCentiNeurons === 17280 && b.reservedCentiNeurons === 0, "provider usage kept as consumed (not released, not doubled)");
  }

  // ---- Successful completion ----
  {
    const u = await newUser(); const p = provider();
    const r = await tryCreate({ userId: u, prompt: "x", quality: "detailed", idempotencyKey: key("ok") }, { provider: p });
    if (!r.ok) throw new Error("setup failed");
    ok((await completeJob(r.job.id)) === false, "completeJob before provider success -> refused");
    ok((await markJobStarted(r.job.id)) && !(await markJobStarted(r.job.id)), "markJobStarted is one-time");
    await recordProviderSuccess(r.job.id, 32640);
    const done = await Promise.all([0, 1, 2].map(() => completeJob(r.job.id)));
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: r.job.id } });
    ok(done.filter(Boolean).length === 1 && job.status === "COMPLETED" && job.chargedCredits === 2, "3 concurrent completes -> once; COMPLETED, chargedCredits 2");
    const lateFail = await failJobProviderNotRun(r.job.id, "should not apply");
    ok(!lateFail.settled && (await balance(u)) === 98 && (await ledger(u)).filter((t) => t.type === "REFUND").length === 0, "fail after completion -> no-op, no refund");
  }

  // ---- Actual usage exceeds reservation ----
  {
    const p = provider(); const a = await newUser(); const c = await newUser();
    const r = await tryCreate({ userId: a, prompt: "x", quality: "fast", idempotencyKey: key("ov") }, { provider: p, dailyNeuronLimit: 40_000 });
    if (!r.ok) throw new Error("setup failed");
    await markJobStarted(r.job.id);
    await recordProviderSuccess(r.job.id, 30_000); // 300 Neurons actual vs 172.80 reserved
    await completeJob(r.job.id);
    const res = await prisma.providerBudgetReservation.findUnique({ where: { jobId: r.job.id } });
    const b = await budget(p);
    ok(res?.reservedCentiNeurons === 17280 && res.actualCentiNeurons === 30_000 && b?.consumedCentiNeurons === 30_000 && b.reservedCentiNeurons === 0,
      "actual (30,000) recorded separately from reserved (17,280); budget consumed = actual");
    const next = await tryCreate({ userId: c, prompt: "x", quality: "fast", idempotencyKey: key("ov2") }, { provider: p, dailyNeuronLimit: 40_000 });
    ok(!next.ok && next.code === "CAPACITY_EXHAUSTED", "next reservation blocked: 30,000 consumed + 17,280 > 40,000 cap");
  }

  // ---- Stale PENDING job (never started) ----
  {
    const u = await newUser(); const p = provider();
    const past = new Date(Date.now() - 3 * 60_000);
    const r = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("sp") }, { provider: p, now: past });
    if (!r.ok) throw new Error("setup failed");
    const rec = await reconcileStaleJobs({ userId: u });
    const res = await prisma.providerBudgetReservation.findUnique({ where: { jobId: r.job.id } });
    ok(rec.settled === 1 && res?.status === "RELEASED" && (await balance(u)) === 100, "stale PENDING (never started): released + refunded");
    ok((await markJobStarted(r.job.id)) === false, "markJobStarted after reconciliation -> false (provider must not be called)");
  }

  // ---- Wallet can never go negative under concurrent debits ----
  {
    const u = await newUser(2);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      prisma.$transaction((tx) => debitWallet(tx, { userId: u, amount: 1, idempotencyKey: key(`neg${i}`) })).then(() => "ok", (e) => code(e))));
    ok(rs.filter((x) => x === "ok").length === 2 && rs.filter((x) => x === "INSUFFICIENT_CREDITS").length === 4 && (await balance(u)) === 0,
      `balance 2, 6 concurrent 1-credit debits -> 2 succeed, 4 INSUFFICIENT_CREDITS, balance 0`);
  }

  // ---- Deletion safety (trigger) ----
  {
    const u = await newUser(); const p = provider();
    const r = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("del") }, { provider: p });
    if (!r.ok) throw new Error("setup failed");
    const del1 = await prisma.user.delete({ where: { id: u } }).then(() => "deleted", (e) => String(e?.message ?? e));
    ok(del1 !== "deleted" && (await prisma.user.count({ where: { id: u } })) === 1 && (await prisma.providerBudgetReservation.count({ where: { jobId: r.job.id, status: "RESERVED" } })) === 1, "deleting a user with a RESERVED reservation is blocked (user + reservation still present)");
    const delRes = await prisma.providerBudgetReservation.delete({ where: { jobId: r.job.id } }).then(() => "deleted", () => "blocked");
    ok(delRes === "blocked", "deleting the RESERVED reservation directly is blocked");
    await failJobProviderNotRun(r.job.id, "settle before delete");
    const del2 = await prisma.user.delete({ where: { id: u } }).then(() => "deleted", (e) => String(e?.message ?? e));
    ok(del2 === "deleted" && (await budget(p))?.reservedCentiNeurons === 0, "after settlement the user can be deleted; budget reserved stays consistent (0)");
    users.splice(users.indexOf(u), 1);
  }

  // ---- Daily-limit accounting follows the provider reservation (correction) ----
  {
    const daily = (u: string) => countDailyImageJobs(prisma, u, utcDayRange(new Date()));

    // 1. Provider succeeds, storage fails, user refunded → still counts.
    {
      const u = await newUser(); const p = provider();
      const r = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("dc1") }, { provider: p });
      if (!r.ok) throw new Error("setup failed");
      const c0 = await daily(u);
      await markJobStarted(r.job.id);
      await recordProviderSuccess(r.job.id, 17280);
      await failJobAfterProviderSuccess(r.job.id, "Storage upload failed");
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: r.job.id } });
      ok(job.status === "FAILED" && (await balance(u)) === 100 && c0 === 1 && (await daily(u)) === 1,
        "provider ran + storage failed: job FAILED, user refunded (100), daily count stays 1");
    }

    // 2. Provider definitely never ran, user refunded → does not count (retryable).
    {
      const u = await newUser(); const p = provider();
      const r = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("dc2") }, { provider: p });
      if (!r.ok) throw new Error("setup failed");
      const whilePending = await daily(u);
      await markJobStarted(r.job.id);
      await failJobProviderNotRun(r.job.id, "Provider rejected request (4xx)");
      ok(whilePending === 1 && (await daily(u)) === 0 && (await balance(u)) === 100,
        "provider never ran: counted while in flight (1), 0 after release, user refunded");
      const pendingNeverStarted = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("dc2b") }, { provider: p });
      if (pendingNeverStarted.ok) await failJobProviderNotRun(pendingNeverStarted.job.id, "Failed before provider call");
      ok(pendingNeverStarted.ok && (await daily(u)) === 0, "failure before provider execution (PENDING) is retryable: count 0");
    }

    // 3. Ambiguous outcome counts exactly once, before and after reconciliation.
    {
      const u = await newUser(); const p = provider();
      const r = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key("dc3") }, { provider: p });
      if (!r.ok) throw new Error("setup failed");
      await markJobStarted(r.job.id);
      await markProviderOutcomeUnknown(r.job.id, "timeout");
      const beforeRec = await daily(u);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: r.job.id } });
      await Promise.all([0, 1, 2].map(() => reconcileStaleJobs({ now: new Date(job.startedAt!.getTime() + 6 * 60_000), userId: u })));
      const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: r.job.id }, include: { budgetReservation: true } });
      ok(beforeRec === 1 && after.status === "FAILED" && after.budgetReservation?.status === "CONSUMED" && (await daily(u)) === 1 && (await balance(u)) === 100,
        "ambiguous outcome: counts 1 while unknown, still exactly 1 after 3 concurrent reconciliations (refunded once)");
    }

    // 4. Concurrent requests cannot bypass the limit via failed jobs that consumed Neurons.
    {
      const u = await newUser(); const p = provider();
      // 5 legacy completed jobs + 4 real jobs that ran on the provider then failed in storage = 9 counted.
      await prisma.generationJob.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ userId: u, type: "IMAGE" as const, status: "COMPLETED" as const, prompt: `seed ${i}`, createdAt: new Date(Date.now() - 60_000 - i) })) });
      for (let i = 0; i < 4; i++) {
        const r = await tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key(`dc4s${i}`) }, { provider: p });
        if (!r.ok) throw new Error(`setup failed: ${r.code}`);
        await markJobStarted(r.job.id);
        await recordProviderSuccess(r.job.id, 17280);
        await failJobAfterProviderSuccess(r.job.id, "Storage upload failed");
      }
      const at9 = await daily(u);
      const refundedFailed = await prisma.generationJob.count({ where: { userId: u, status: "FAILED" } });
      const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key(`dc4b${i}`) }, { provider: p })));
      const created = burst.filter((r) => r.ok);
      ok(at9 === 9 && refundedFailed === 4, "setup: 9 counted (5 completed + 4 provider-ran-then-failed & refunded)");
      ok(created.length === 1 && burst.filter((r) => !r.ok).every((r) => !r.ok && r.code === "DAILY_LIMIT_REACHED") && (await daily(u)) === 10,
        "6 concurrent requests at 9 → exactly 1 created, 5 DAILY_LIMIT_REACHED, count 10");
      for (const r of created) if (r.ok) { await markJobStarted(r.job.id); await recordProviderSuccess(r.job.id, 17280); await failJobAfterProviderSuccess(r.job.id, "Storage upload failed"); }
      const again = await Promise.all(Array.from({ length: 4 }, (_, i) => tryCreate({ userId: u, prompt: "x", quality: "fast", idempotencyKey: key(`dc4c${i}`) }, { provider: p })));
      ok(again.every((r) => !r.ok && r.code === "DAILY_LIMIT_REACHED") && (await daily(u)) === 10 && (await balance(u)) === 100,
        "after the 10th also fails post-provider (refunded), 4 more concurrent requests → all DAILY_LIMIT_REACHED; count stays 10");
    }
  }

  // ---- Global invariants across all test data ----
  {
    const bad: any[] = await prisma.$queryRaw`
      SELECT b."provider", b."reservedCentiNeurons", b."consumedCentiNeurons",
             COALESCE(SUM(r."reservedCentiNeurons") FILTER (WHERE r."status" = 'RESERVED'), 0)::int AS sum_reserved,
             COALESCE(SUM(r."actualCentiNeurons") FILTER (WHERE r."status" = 'CONSUMED'), 0)::int AS sum_consumed
      FROM "ProviderDailyBudget" b LEFT JOIN "ProviderBudgetReservation" r ON r."budgetId" = b."id"
      WHERE b."provider" LIKE ${PROVIDER_PREFIX + "%"}
      GROUP BY b."id"
      HAVING b."reservedCentiNeurons" <> COALESCE(SUM(r."reservedCentiNeurons") FILTER (WHERE r."status" = 'RESERVED'), 0)
          OR b."consumedCentiNeurons" <> COALESCE(SUM(r."actualCentiNeurons") FILTER (WHERE r."status" = 'CONSUMED'), 0)`;
    ok(bad.length === 0, `every test budget row: reserved = Σ RESERVED, consumed = Σ CONSUMED actual ${bad.length ? JSON.stringify(bad) : ""}`);
    const negative = await prisma.creditWallet.count({ where: { userId: { in: users }, balance: { lt: 0 } } });
    ok(negative === 0, "no wallet negative");
    const dupRefunds: any[] = await prisma.$queryRaw`SELECT "jobId", count(*)::int AS n FROM "CreditTransaction" WHERE "type" = 'REFUND' AND "jobId" IS NOT NULL AND "userId" = ANY(${users}) GROUP BY "jobId" HAVING count(*) > 1`;
    const dupDebits: any[] = await prisma.$queryRaw`SELECT "jobId", count(*)::int AS n FROM "CreditTransaction" WHERE "type" = 'GENERATION_DEBIT' AND "jobId" IS NOT NULL AND "userId" = ANY(${users}) GROUP BY "jobId" HAVING count(*) > 1`;
    ok(dupRefunds.length === 0 && dupDebits.length === 0, "no job has more than one debit or more than one refund");
  }
} catch (e) {
  fail++;
  console.error("TEST ERROR", (e as Error)?.message?.slice(0, 400));
} finally {
  // ---- Cleanup: settle anything still RESERVED, delete test users, then test budget rows ----
  const open = await prisma.generationJob.findMany({ where: { userId: { in: users }, status: { in: ["PENDING", "PROCESSING"] } }, select: { id: true } });
  for (const j of open) await failJobProviderNotRun(j.id, "test cleanup");
  const stillReserved = await prisma.providerBudgetReservation.findMany({ where: { job: { userId: { in: users } }, status: "RESERVED" }, select: { jobId: true } });
  for (const r of stillReserved) await failJobAfterProviderSuccess(r.jobId, "test cleanup");
  const del = await prisma.user.deleteMany({ where: { id: { in: users } } });
  const delBudgets = await prisma.providerDailyBudget.deleteMany({ where: { provider: { startsWith: PROVIDER_PREFIX } } });
  const left: any = await prisma.$queryRaw`SELECT (SELECT count(*) FROM "User")::int AS users, (SELECT count(*) FROM "GenerationJob")::int AS jobs,
    (SELECT count(*) FROM "ProviderDailyBudget")::int AS budgets, (SELECT count(*) FROM "ProviderBudgetReservation")::int AS reservations,
    (SELECT count(*) FROM "CreditTransaction")::int AS txns, (SELECT coalesce(sum(balance),0)::int FROM "CreditWallet") AS balance_sum`;
  console.log(`\ncleanup: deleted ${del.count} test users, ${delBudgets.count} test budget rows; remaining ${JSON.stringify(left[0])}`);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
  await prisma.$disconnect();
}
