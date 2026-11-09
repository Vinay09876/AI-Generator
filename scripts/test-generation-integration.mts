// Stage 5 integration tests: the orchestrator against the REAL Stage 3 lifecycle and a REAL
// (dedicated test) database, with a fake provider and in-memory storage.
// Makes NO Cloudflare calls and NO Supabase Storage calls.
//
// SAFETY: runs ONLY against TEST_DATABASE_URL. Refuses to run unless TEST_DATABASE_URL and
// DATABASE_URL resolve to DIFFERENT Supabase project references (fails closed if either cannot be
// identified; see scripts/lib/test-db-guard.mts). The test database must
// have all migrations applied (separately approved):  DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
//
// Run: npm run test:integration
// Creates tagged users/jobs/budget rows and removes them at the end (same pattern as test:accounting).
import { config as loadEnv } from "dotenv";
import sharp from "sharp";
import { requireSeparateTestDatabase } from "./lib/test-db-guard.mjs";

loadEnv({ quiet: true });

const { testUrl, maskedRef } = requireSeparateTestDatabase();
process.env.DATABASE_URL = testUrl; // before any app module (and Prisma) is loaded
for (const k of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_STORAGE_BUCKET"]) delete process.env[k];
// Only the database driver may use the network; fetch (Cloudflare / Supabase HTTP) is blocked.
let fetchAttempts = 0;
globalThis.fetch = (async () => { fetchAttempts++; throw new Error("fetch is forbidden in integration tests"); }) as typeof fetch;
console.log(`Using test database project ${maskedRef} (credentials hidden)\n`);

const { prisma } = await import("@/lib/prisma");
const { hashPassword } = await import("@/features/auth/password");
const { createUserWithWallet } = await import("@/features/users/create-user");
const lifecycle = await import("@/features/generations/lifecycle");
const { runImageGeneration } = await import("@/features/generations/generate-image");
const { getImageJobForUser } = await import("@/features/generations/queries");
const { convertProviderImageToWebp } = await import("@/features/generations/image-processing");
const { ProviderError } = await import("@/features/generations/providers/types");
const { StorageError } = await import("@/features/generations/storage/types");
const { IMAGE_MODEL } = await import("@/features/generations/config");
type GenerationDeps = import("@/features/generations/generate-image").GenerationDeps;
type ProviderResult = import("@/features/generations/providers/types").ProviderResult;

const keepAlive = setInterval(() => {}, 1_000);
const TS = Date.now();
const PROVIDER_PREFIX = `test-stage5-${TS}`;
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const section = (s: string) => console.log(`\n# ${s}`);
let keySeq = 0;
const key = () => `k5_${TS}_${++keySeq}`;
const users: string[] = [];
const PW = await hashPassword("Stage5-Test-Pass!");
let userSeq = 0;
async function newUser() {
  const u = await createUserWithWallet({ name: "Stage5 Test", email: `e2e-stage5-${TS}-${userSeq++}@example.com`, passwordHash: PW });
  users.push(u.id);
  return u.id;
}
const future = (ms: number) => new Date(Date.now() + ms);

const jpeg = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#2a4b8d" } }).jpeg({ quality: 90 }).toBuffer();
const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } }).png().toBuffer();
type Behaviour = () => Promise<ProviderResult>;
const success = (centi: number | null = 17_280, bytes = jpeg): Behaviour => async () => ({
  bytes, usage: centi === null ? { centiNeurons: null, source: "missing" } : { centiNeurons: centi, source: "header" },
  provider: "fake", model: IMAGE_MODEL, providerRequestId: null, latencyMs: 1,
});

let providerN = 0;
function harness(behaviour: Behaviour = success()) {
  const budgetProvider = `${PROVIDER_PREFIX}-${++providerN}`;
  const objects = new Map<string, Buffer>();
  const storage = {
    objects, failPut: false, onPut: null as null | (() => Promise<void>),
    async put(k: string, b: Buffer) { if (storage.failPut) throw new StorageError("UPLOAD_FAILED", "fake"); objects.set(k, b); if (storage.onPut) await storage.onPut(); },
    async createSignedUrl(k: string) { return `https://storage.invalid/${k}`; },
    async delete(k: string) { objects.delete(k); },
  };
  const calls = { provider: 0 };
  const h: { behaviour: Behaviour; storage: typeof storage; calls: typeof calls; deps: GenerationDeps } = {
    behaviour, storage, calls,
    deps: {
      // Isolate budget rows per scenario (cleanup by prefix); everything else is the real lifecycle.
      lifecycle: { ...lifecycle, createImageJob: (input) => lifecycle.createImageJob(input, { provider: budgetProvider }) },
      getProvider: () => ({ id: "fake", model: IMAGE_MODEL, generate: async (): Promise<ProviderResult> => { calls.provider++; return h.behaviour(); } }),
      getStorage: () => storage,
      convertImage: (b) => convertProviderImageToWebp(b),
      log: { info: () => {}, error: () => {} },
    },
  };
  return h;
}
const run = (h: ReturnType<typeof harness>, userId: string, k = key(), quality = "fast", prompt = "integration lighthouse") =>
  runImageGeneration({ userId, prompt, quality, idempotencyKey: k }, h.deps);
const state = async (jobId: string) => {
  const [job, reservation, refunds, debits, assets] = await Promise.all([
    prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } }),
    prisma.providerBudgetReservation.findUnique({ where: { jobId } }),
    prisma.creditTransaction.count({ where: { jobId, type: "REFUND" } }),
    prisma.creditTransaction.count({ where: { jobId, type: "GENERATION_DEBIT" } }),
    prisma.generatedAsset.findMany({ where: { jobId } }),
  ]);
  return { job, reservation, refunds, debits, assets };
};
const balance = async (userId: string) => (await prisma.creditWallet.findUniqueOrThrow({ where: { userId } })).balance;

try {
  section("Success");
  {
    const h = harness(success(17_000)); const u = await newUser();
    const r = await run(h, u);
    const s = await state(r.jobId);
    ok(r.outcome === "completed" && s.job.status === "COMPLETED" && s.job.chargedCredits === 1, "job COMPLETED, 1 credit charged");
    ok(s.reservation?.status === "CONSUMED" && s.reservation.actualCentiNeurons === 17_000, "actual usage recorded on the reservation");
    ok(s.assets.length === 1 && s.assets[0].userId === u && s.assets[0].mimeType === "image/webp" && h.storage.objects.has(s.assets[0].storageKey), "asset row + stored object");
    ok(s.debits === 1 && s.refunds === 0 && (await balance(u)) === 99, "one debit, no refund, balance 99");
    const view = await getImageJobForUser(u, r.jobId);
    ok(view?.assets[0]?.id === s.assets[0].id && (await getImageJobForUser(await newUser(), r.jobId)) === null, "getImageJobForUser: owner sees job + asset, other user gets null");
  }
  {
    const h = harness(success(null)); const u = await newUser();
    const r = await run(h, u, key(), "detailed");
    const s = await state(r.jobId);
    ok(s.job.status === "COMPLETED" && s.reservation?.actualCentiNeurons === 32_640, "missing usage → reserved 32,640 consumed");
  }

  section("Provider failures");
  {
    const h = harness(async () => { throw new ProviderError({ code: "QUOTA_EXHAUSTED", outcome: "not_run", message: "429", httpStatus: 429 }); });
    const u = await newUser();
    const s = await state((await run(h, u)).jobId);
    ok(s.job.status === "FAILED" && s.reservation?.status === "RELEASED" && s.refunds === 1 && (await balance(u)) === 100, "not_run → RELEASED + refunded once");
  }
  {
    const h = harness(async () => { throw new ProviderError({ code: "MALFORMED_RESPONSE", outcome: "ran", message: "x", httpStatus: 200 }); });
    const u = await newUser();
    const s = await state((await run(h, u)).jobId);
    ok(s.job.status === "FAILED" && s.reservation?.status === "CONSUMED" && s.reservation.actualCentiNeurons === 17_280 && s.refunds === 1, "ran → CONSUMED (reserved) + refunded once");
  }
  {
    const h = harness(async () => { throw new ProviderError({ code: "TIMEOUT", outcome: "unknown", message: "t" }); });
    const u = await newUser();
    const r = await run(h, u);
    let s = await state(r.jobId);
    ok(r.outcome === "pending" && s.job.status === "PROCESSING" && s.reservation?.status === "RESERVED" && s.refunds === 0, "unknown → PROCESSING, RESERVED, no refund");
    await lifecycle.reconcileStaleJobs({ userId: u, now: future(4 * 60_000) });
    ok((await state(r.jobId)).job.status === "PROCESSING", "not reconciled before 5 minutes");
    await Promise.all([lifecycle.reconcileStaleJobs({ userId: u, now: future(6 * 60_000) }), lifecycle.reconcileStaleJobs({ userId: u, now: future(6 * 60_000) })]);
    s = await state(r.jobId);
    ok(s.job.status === "FAILED" && s.reservation?.status === "CONSUMED" && s.refunds === 1, "after 5 min (concurrent reconcilers): settled exactly once");
  }

  section("Failures after provider success");
  {
    const h = harness(success(17_280, png)); const u = await newUser();
    const s = await state((await run(h, u)).jobId);
    ok(s.job.status === "FAILED" && s.reservation?.status === "CONSUMED" && s.refunds === 1 && h.storage.objects.size === 0, "invalid image → FAILED, usage kept, refunded, nothing stored");
  }
  {
    const h = harness(); h.storage.failPut = true; const u = await newUser();
    const s = await state((await run(h, u)).jobId);
    ok(s.job.status === "FAILED" && s.refunds === 1 && s.assets.length === 0, "upload failure → FAILED, refunded, no asset row");
  }

  section("Races with reconciliation");
  {
    const h = harness(); const u = await newUser();
    h.storage.onPut = async () => { await lifecycle.reconcileStaleJobs({ userId: u, now: future(6 * 60_000) }); };
    const r = await run(h, u);
    const s = await state(r.jobId);
    ok(r.outcome === "superseded" && s.job.status === "FAILED" && s.assets.length === 0 && h.storage.objects.size === 0, "reconcile wins during upload → FAILED, object deleted, no asset row");
    ok(s.refunds === 1 && s.reservation?.status === "CONSUMED" && s.reservation.actualCentiNeurons === 17_280, "single refund, recorded usage kept");
  }
  {
    const u = await newUser();
    const h = harness(async () => { await lifecycle.reconcileStaleJobs({ userId: u, now: future(6 * 60_000) }); return success()(); });
    const r = await run(h, u);
    const s = await state(r.jobId);
    ok(r.outcome === "superseded" && s.job.status === "FAILED" && h.storage.objects.size === 0 && s.refunds === 1, "late provider response discarded; one settlement");
  }

  section("completeImageJobWithAsset guards");
  {
    const h = harness(async () => { throw new ProviderError({ code: "TIMEOUT", outcome: "unknown", message: "t" }); });
    const u = await newUser();
    const r = await run(h, u); // PROCESSING, RESERVED (usage not recorded)
    const asset = { userId: u, assetId: `a${TS}x1`, storageKey: `users/${u}/images/${r.jobId}/a${TS}x1.webp`, mimeType: "image/webp", width: 1, height: 1, sizeBytes: 1 };
    const e1 = await lifecycle.completeImageJobWithAsset(r.jobId, asset).then(() => null, (e: Error) => e.name);
    ok(e1 === "JobNotCompletableError" && (await state(r.jobId)).job.status === "PROCESSING", "refuses completion while usage is not settled");
    await lifecycle.recordProviderSuccess(r.jobId, 17_280);
    const other = await newUser();
    const e2 = await lifecycle.completeImageJobWithAsset(r.jobId, { ...asset, userId: other }).then(() => null, (e: Error) => e.name);
    const s2 = await state(r.jobId);
    ok(e2 === "JobNotCompletableError" && s2.job.status === "PROCESSING" && s2.assets.length === 0, "owner mismatch → rolled back (still PROCESSING, no asset row)");
    await lifecycle.completeImageJobWithAsset(r.jobId, asset);
    const e3 = await lifecycle.completeImageJobWithAsset(r.jobId, { ...asset, assetId: `a${TS}x2` }).then(() => null, (e: Error) => e.name);
    const s3 = await state(r.jobId);
    ok(s3.job.status === "COMPLETED" && s3.assets.length === 1 && e3 === "JobNotCompletableError", "completes once; a second completion is refused");
    ok(await lifecycle.imageAssetExists(r.jobId, asset.assetId), "imageAssetExists finds the committed row");
  }

  section("Idempotency and concurrency");
  {
    const h = harness(); const u = await newUser(); const k = key();
    const first = await run(h, u, k);
    const again = await run(h, u, k);
    ok(again.replayed && again.jobId === first.jobId && h.calls.provider === 1 && (await state(first.jobId)).debits === 1, "replay: same job, no provider call, no second debit");
  }
  {
    const h = harness(); const u = await newUser(); const k = key();
    const rs = await Promise.allSettled([run(h, u, k), run(h, u, k), run(h, u, k)]);
    const okRs = rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>).value);
    ok(okRs.length === 3 && okRs.filter((r) => !r.replayed).length === 1 && h.calls.provider === 1, "3 concurrent same-key requests → 1 job, 1 provider call");
    ok((await prisma.creditTransaction.count({ where: { userId: u, type: "GENERATION_DEBIT" } })) === 1, "exactly one debit");
  }
  {
    const h = harness(); const u = await newUser();
    const rs = await Promise.allSettled([run(h, u), run(h, u)]);
    ok(rs.filter((r) => r.status === "fulfilled").length === 1 &&
      rs.some((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "ACTIVE_JOB_EXISTS"), "concurrent different keys → one ACTIVE_JOB_EXISTS");
  }

  section("Invariants");
  {
    const wallets = await prisma.creditWallet.findMany({ where: { userId: { in: users } }, select: { userId: true, balance: true } });
    let consistent = true;
    for (const w of wallets) {
      const sum = await prisma.creditTransaction.aggregate({ where: { userId: w.userId }, _sum: { amount: true } });
      if ((sum._sum.amount ?? 0) !== w.balance) consistent = false;
    }
    ok(consistent, "every wallet balance equals the sum of its ledger");
    const dupRefunds = await prisma.creditTransaction.groupBy({ by: ["jobId"], where: { userId: { in: users }, type: "REFUND" }, _count: { _all: true }, having: { jobId: { _count: { gt: 1 } } } });
    ok(dupRefunds.length === 0, "no job refunded more than once");
    const badCompleted = await prisma.generationJob.count({ where: { userId: { in: users }, status: "COMPLETED", OR: [{ assets: { none: {} } }, { budgetReservation: { isNot: { status: "CONSUMED" } } }] } });
    ok(badCompleted === 0, "every COMPLETED job has an asset row and a CONSUMED reservation");
    ok(fetchAttempts === 0, "no HTTP (Cloudflare / Supabase) request attempted");
  }
} catch (e) {
  fail++;
  console.error("UNCAUGHT", e);
} finally {
  // Settle anything left open, then delete only this run's tagged rows.
  const open = await prisma.generationJob.findMany({ where: { userId: { in: users }, status: { in: ["PENDING", "PROCESSING"] } }, select: { id: true } });
  for (const j of open) await lifecycle.failJobProviderNotRun(j.id, "test cleanup");
  const del = await prisma.user.deleteMany({ where: { id: { in: users } } });
  const delBudgets = await prisma.providerDailyBudget.deleteMany({ where: { provider: { startsWith: PROVIDER_PREFIX } } });
  console.log(`\ncleanup: deleted ${del.count} test users, ${delBudgets.count} test budget rows`);
  await prisma.$disconnect();
  clearInterval(keepAlive);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
