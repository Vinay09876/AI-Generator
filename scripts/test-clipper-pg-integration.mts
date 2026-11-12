// Stage 9 Batch 7: REAL PostgreSQL integration (concurrency, ledger, JSON-path queries, cross-stage
// one-active-job). Runs ONLY against the throwaway loopback cluster (port 55432, database
// yourai_it); refuses anything else before importing the Prisma client. Storage is in-memory.
// Run (from the isolated copy, with the egress guard preloaded): npm run test:clipper-pg
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "");
  } catch {
    return null;
  }
})();
if (!url || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "55432" || url.pathname !== "/yourai_it") {
  console.error("REFUSING: DATABASE_URL must be postgresql://…@127.0.0.1:55432/yourai_it (throwaway cluster).");
  process.exit(2);
}

const { prisma } = await import("../src/lib/prisma");
const clipperNs = await import("../src/features/clipper/index");
const clipper = ((clipperNs as any).default ?? clipperNs) as typeof clipperNs;
const queries = await import("../src/features/clipper/queries");
const { createPrismaUserLock } = await import("../src/features/clipper/user-lock");
const { createVideoJob } = await import("../src/features/video/lifecycle");
const { createImageJob } = await import("../src/features/generations/lifecycle");
const {
  createClipperJob,
  cancelQueuedClipperJobForUser,
  markClipperJobStarted,
  claimClipperLease,
  completeClipperJobWithAssets,
  failClipperJob,
  reconcileStaleClipperJobs,
  recordClipperCleanupResults,
  createUploadIntent,
  releasePendingUploads,
  discardUpload,
} = clipper;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}:`, err);
  }
}

const INITIAL = 1000;
async function newUser(tag: string) {
  const id = `usr_${tag}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await prisma.user.create({ data: { id, email: `${id}@it.local`, name: tag, wallet: { create: { balance: INITIAL } } } as any });
  return id;
}
const balance = async (userId: string) => (await prisma.creditWallet.findUnique({ where: { userId } }))!.balance;
const ledger = (jobId: string) => prisma.creditTransaction.findMany({ where: { jobId } });
const sourceKey = (u: string, n = 1) => `ephemeral/users/${u}/uploads/upl_${String(n).padStart(32, "0")}.mp4`;
async function clipJob(userId: string, idem = `idem_${randomUUID()}`, clips = 2, key = sourceKey(userId)) {
  return (await createClipperJob({ userId, sourceKey: key, sourceDurationSeconds: 60, requestedClipsCount: clips, idempotencyKey: idem })).job;
}

/** In-memory storage for upload intents, with an async delay to widen race windows. */
function memStorage(delayMs = 15) {
  const objects = new Map<string, { size: number; createdAt: Date }>();
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    objects,
    storage: {
      async listFolder(prefix: string, page: { limit: number; offset: number }) {
        await wait();
        const all = [...objects.entries()].filter(([k]) => k.startsWith(`${prefix}/`)).map(([key, o]) => ({ key, sizeBytes: o.size, createdAt: o.createdAt, updatedAt: o.createdAt }));
        return { objects: all.slice(page.offset, page.offset + page.limit), folders: [] };
      },
      async putPlaceholder(key: string) {
        await wait();
        objects.set(key, { size: 0, createdAt: new Date() });
      },
      async createSignedUploadUrl(key: string) {
        return { signedUrl: `http://127.0.0.1/up/${key}`, key };
      },
      async delete(key: string) {
        objects.delete(key);
      },
    } as any,
  };
}

async function run() {
  console.log(`# PostgreSQL: ${(await prisma.$queryRawUnsafe<{ v: string }[]>("select version() as v"))[0].v}`);

  // -------------------------------------------------------------------------
  await test("migrations applied: one-active-job partial unique index exists", async () => {
    const r = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(`select indexdef from pg_indexes where indexname = 'GenerationJob_one_active_per_user'`);
    assert.equal(r.length, 1);
    assert.match(r[0].indexdef, /WHERE.*status.*PENDING.*PROCESSING/);
  });

  // -------------------------------------------------------------------------
  await test("race ×30: user cancel vs worker pickup — exactly one winner, refund iff cancel won, ledger balanced", async () => {
    let cancelWins = 0;
    let workerWins = 0;
    for (let i = 0; i < 30; i++) {
      const u = await newUser("race");
      const job = await clipJob(u);
      // Random 0–3 ms stagger on either side so both orders are exercised.
      const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
      const [cancel, started] = await Promise.all([
        (i % 2 ? jitter() : Promise.resolve()).then(() => cancelQueuedClipperJobForUser({ jobId: job.id, userId: u })),
        (i % 2 ? Promise.resolve() : jitter()).then(() => markClipperJobStarted({ jobId: job.id })),
      ]);
      const lease = await claimClipperLease({ jobId: job.id });
      assert.notEqual(cancel.settled, started, `exactly one winner (iteration ${i})`);
      assert.equal(lease.claimed, started, "lease only for the pickup winner");
      const row = await prisma.generationJob.findUnique({ where: { id: job.id } });
      const tx = await ledger(job.id);
      const refunds = tx.filter((t) => t.type === "REFUND");
      if (cancel.settled) {
        cancelWins++;
        assert.equal(row!.status, "CANCELLED");
        assert.equal(refunds.length, 1);
        assert.equal(await balance(u), INITIAL);
      } else {
        workerWins++;
        assert.equal(row!.status, "PROCESSING");
        assert.equal(refunds.length, 0);
        assert.equal(await balance(u), INITIAL - 10);
      }
    }
    console.log(`      (cancel won ${cancelWins}, worker won ${workerWins})`);
  });

  await test("10 concurrent cancels of one job → one settles, exactly one refund", async () => {
    const u = await newUser("dupc");
    const job = await clipJob(u);
    const results = await Promise.all(Array.from({ length: 10 }, () => cancelQueuedClipperJobForUser({ jobId: job.id, userId: u })));
    assert.equal(results.filter((r) => r.settled).length, 1);
    assert.equal((await ledger(job.id)).filter((t) => t.type === "REFUND").length, 1);
    assert.equal(await balance(u), INITIAL);
  });

  await test("cancel by another user: invisible, no change", async () => {
    const owner = await newUser("own");
    const other = await newUser("oth");
    const job = await clipJob(owner);
    const r = await cancelQueuedClipperJobForUser({ jobId: job.id, userId: other });
    assert.deepEqual(r, { settled: false, currentStatus: null });
    assert.equal((await prisma.generationJob.findUnique({ where: { id: job.id } }))!.status, "PENDING");
  });

  await test("a fenced completion can never land on a cancelled job", async () => {
    const u = await newUser("fence");
    const job = await clipJob(u);
    await cancelQueuedClipperJobForUser({ jobId: job.id, userId: u });
    await assert.rejects(() =>
      completeClipperJobWithAssets({
        jobId: job.id,
        ingestionToken: "forged-token",
        clips: [{ clipId: "c1", userId: u, storageKey: `users/${u}/clips/${job.id}/c1.mp4`, width: 1080, height: 1920, durationSeconds: 30, sizeBytes: 10, aspectRatio: "9:16", title: "x" }],
      }),
    );
    assert.equal((await prisma.generatedAsset.count({ where: { jobId: job.id } })), 0);
  });

  // -------------------------------------------------------------------------
  await test("idempotency: 10 concurrent creates with one key → one job, one debit", async () => {
    const u = await newUser("idem");
    const idem = `idem_${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => clipJob(u, idem)));
    const ids = new Set(results.filter((r) => r.status === "fulfilled").map((r: any) => r.value.id));
    assert.equal(ids.size, 1, `one job id (${results.filter((r) => r.status === "rejected").map((r: any) => r.reason?.code).join(",")})`);
    const jobId = [...ids][0];
    assert.equal((await ledger(jobId)).filter((t) => t.type === "GENERATION_DEBIT").length, 1);
    assert.equal(await balance(u), INITIAL - 10);
  });

  await test("cross-stage one-active-job: clip vs video vs image in parallel → exactly one is created", async () => {
    const u = await newUser("xs");
    const results = await Promise.allSettled([
      clipJob(u),
      createVideoJob({ userId: u, prompt: "a calm lake at dawn, cinematic", aspectRatio: "16:9", idempotencyKey: `v_${randomUUID()}` }, { nodeEnv: "development" } as any),
      createImageJob({ userId: u, prompt: "a red bicycle", quality: "fast", idempotencyKey: `i_${randomUUID()}` }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const codes = results.filter((r) => r.status === "rejected").map((r: any) => r.reason?.code ?? r.reason?.message);
    assert.equal(ok.length, 1, `exactly one created; rejections: ${codes.join(", ")}`);
    for (const c of codes) assert.equal(c, "ACTIVE_JOB_EXISTS");
    const active = await prisma.generationJob.count({ where: { userId: u, status: { in: ["PENDING", "PROCESSING"] } } });
    assert.equal(active, 1);
  });

  await test("cross-stage: an active clip job blocks a later video job (409 path) without any provider call", async () => {
    const u = await newUser("xs2");
    await clipJob(u);
    await assert.rejects(
      () => createVideoJob({ userId: u, prompt: "a calm lake at dawn, cinematic", aspectRatio: "16:9", idempotencyKey: `v_${randomUUID()}` }, { nodeEnv: "development" } as any),
      (e: any) => e.code === "ACTIVE_JOB_EXISTS",
    );
  });

  // -------------------------------------------------------------------------
  await test("real user lock: 8 parallel upload intents → exactly 1 reservation", async () => {
    const u = await newUser("lock");
    const mem = memStorage();
    const deps = { storage: mem.storage, withUserLock: createPrismaUserLock(prisma as any), isSourceKeyReferenced: (uid: string, k: string) => queries.isClipSourceKeyReferenced(uid, k) };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => createUploadIntent(deps, { userId: u, input: { mimeType: "video/mp4", sizeBytes: 1000 } })));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const codes = results.filter((r) => r.status === "rejected").map((r: any) => r.reason?.code);
    assert.equal(ok, 1, `successes=${ok} rejections=${codes.join(",")}`);
    assert.ok(codes.every((c) => c === "UPLOAD_PENDING_EXISTS"));
    assert.equal(mem.objects.size, 1);
  });

  await test("control: WITHOUT the lock the same burst over-reserves (proves the race is real)", async () => {
    const u = await newUser("nolock");
    const mem = memStorage();
    const deps = { storage: mem.storage, withUserLock: async (_u: string, fn: any) => fn({ activeSourceKeys: async () => [] }), isSourceKeyReferenced: async () => false };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => createUploadIntent(deps as any, { userId: u, input: { mimeType: "video/mp4", sizeBytes: 1000 } })));
    assert.ok(results.filter((r) => r.status === "fulfilled").length > 1);
  });

  await test("real user lock: 6 parallel retries with the SAME client id → one object, all succeed (re-grant)", async () => {
    const u = await newUser("regr");
    const mem = memStorage();
    const id = `upl_${randomUUID().replace(/-/g, "")}`;
    const deps = { storage: mem.storage, withUserLock: createPrismaUserLock(prisma as any), isSourceKeyReferenced: (uid: string, k: string) => queries.isClipSourceKeyReferenced(uid, k) };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => createUploadIntent(deps, { userId: u, input: { mimeType: "video/mp4", sizeBytes: 1000, uploadId: id } })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 6);
    assert.equal(results.filter((r: any) => r.status === "fulfilled" && r.value.regranted === false).length, 1, "exactly one fresh reservation");
    assert.equal(mem.objects.size, 1);
    // A different id is still refused.
    await assert.rejects(() => createUploadIntent(deps, { userId: u, input: { mimeType: "video/mp4", sizeBytes: 1000, uploadId: `upl_${"f".repeat(32)}` } }), (e: any) => e.code === "UPLOAD_PENDING_EXISTS");
  });

  await test("real lock: discard/release refuse an upload used by an ACTIVE clip job (JSON-path query)", async () => {
    const u = await newUser("inuse");
    const key = sourceKey(u, 7);
    const mem = memStorage(0);
    mem.objects.set(key, { size: 100, createdAt: new Date() });
    await clipJob(u, undefined, 1, key);
    const deps = { storage: mem.storage, withUserLock: createPrismaUserLock(prisma as any), isSourceKeyReferenced: (uid: string, k: string) => queries.isClipSourceKeyReferenced(uid, k) };
    await assert.rejects(() => discardUpload(deps, { userId: u, uploadKey: key }), (e: any) => e.code === "UPLOAD_IN_USE");
    assert.deepEqual(await releasePendingUploads(deps, { userId: u }), { released: 0, kept: 1 });
    assert.ok(mem.objects.has(key));
  });

  // -------------------------------------------------------------------------
  await test("JSON-path queries against real jsonb: active keys, referenced, pending cleanups, page reads, download lookup", async () => {
    const u = await newUser("q");
    const key = sourceKey(u, 3);
    const job = await clipJob(u, undefined, 1, key);
    assert.deepEqual(await queries.getActiveClipSourceKeys(u), [key]);
    assert.equal(await queries.isClipSourceKeyReferenced(u, key), true);
    assert.equal(await queries.isUploadKeyInActiveClipJob(key), true);
    assert.equal((await queries.getActiveClipJobForUser(u))?.id, job.id);
    assert.ok((await queries.findPendingClipperJobs(20)).some((j) => j.id === job.id));

    assert.equal(await markClipperJobStarted({ jobId: job.id }), true);
    const lease = await claimClipperLease({ jobId: job.id });
    const done = await completeClipperJobWithAssets({
      jobId: job.id,
      ingestionToken: lease.token!,
      clips: [{ clipId: "c1", userId: u, storageKey: `users/${u}/clips/${job.id}/c1.mp4`, width: 1080, height: 1920, durationSeconds: 29.5, sizeBytes: 1234, aspectRatio: "9:16", title: "Clip 1" }],
    });
    assert.equal(done.assetIds.length, 1);
    assert.equal(await queries.isUploadKeyInActiveClipJob(key), false);
    assert.ok((await queries.findClipJobsWithPendingCleanups(50)).includes(job.id), "terminal job with pending source cleanup is found");
    const recent = await queries.getRecentCompletedClipJobsForUser(u, 6);
    assert.equal(recent[0].id, job.id);
    assert.equal(recent[0].assets.length, 1);
    const dl = await queries.getClipAssetForDownload(u, job.id, done.assetIds[0]);
    assert.equal(dl?.storageKey, `users/${u}/clips/${job.id}/c1.mp4`);
    const other = await newUser("q2");
    assert.equal(await queries.getClipAssetForDownload(other, job.id, done.assetIds[0]), null, "other user");
    assert.equal(await queries.getClipAssetForDownload(u, "job_wrongjob0001", done.assetIds[0]), null, "wrong job");
    assert.equal((await ledger(job.id)).filter((t) => t.type === "REFUND").length, 0, "completed: no refund");

    await recordClipperCleanupResults({ jobId: job.id, results: [{ key, success: true }] });
    assert.ok(!(await queries.findClipJobsWithPendingCleanups(50)).includes(job.id), "cleaned job no longer listed");
  });

  await test("stale queue sweep: a 31-minute-old PENDING job fails + refunds once; cancel afterwards is refused", async () => {
    const u = await newUser("stale");
    const job = await clipJob(u);
    await prisma.generationJob.update({ where: { id: job.id }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    const r = await reconcileStaleClipperJobs({ pendingThresholdMs: 30 * 60_000 });
    assert.ok(r.settled >= 1);
    assert.equal((await prisma.generationJob.findUnique({ where: { id: job.id } }))!.status, "FAILED");
    assert.equal(await balance(u), INITIAL);
    const c = await cancelQueuedClipperJobForUser({ jobId: job.id, userId: u });
    assert.deepEqual(c, { settled: false, currentStatus: "FAILED" });
    await failClipperJob(job.id, "again");
    assert.equal((await ledger(job.id)).filter((t) => t.type === "REFUND").length, 1);
  });

  await test("global ledger invariant for all test users: balance = initial − debits + refunds", async () => {
    const users = await prisma.user.findMany({ where: { email: { endsWith: "@it.local" } }, select: { id: true } });
    for (const { id } of users) {
      const tx = await prisma.creditTransaction.findMany({ where: { userId: id } });
      const debits = tx.filter((t) => t.type === "GENERATION_DEBIT").reduce((s, t) => s + Math.abs(t.amount), 0);
      const refunds = tx.filter((t) => t.type === "REFUND").reduce((s, t) => s + Math.abs(t.amount), 0);
      assert.equal(await balance(id), INITIAL - debits + refunds, id);
    }
  });

  console.log(`\n  Tests Passed: ${passed}\n  Tests Failed: ${failed}\n`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

run().catch(async (e) => {
  console.error("Unhandled test error:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
