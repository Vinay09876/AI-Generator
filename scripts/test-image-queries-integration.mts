// Stage 6 / B2 integration tests for the read-only image queries used by /ai-image:
// getActiveImageJob, getRecentImageJobs (and getImageJobForUser after its refactor).
//
// SAFETY: runs ONLY against TEST_DATABASE_URL, which must resolve to a different Supabase project
// than DATABASE_URL (fails closed; scripts/lib/test-db-guard.mts). No Cloudflare / Supabase
// Storage access: fixtures are plain database rows (storage keys point at nothing).
// Creates tagged users (and, by cascade, their jobs and assets) and deletes them at the end.
//
// Run: npm run test:queries
import { config as loadEnv } from "dotenv";
import { requireSeparateTestDatabase } from "./lib/test-db-guard.mjs";

loadEnv({ quiet: true });
const { testUrl, maskedRef } = requireSeparateTestDatabase();
process.env.DATABASE_URL = testUrl; // before any app module (and Prisma) is loaded
for (const k of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_STORAGE_BUCKET"]) delete process.env[k];
let fetchAttempts = 0;
globalThis.fetch = (async () => { fetchAttempts++; throw new Error("fetch is forbidden in this suite"); }) as typeof fetch;
console.log(`Using test database project ${maskedRef} (credentials hidden)\n`);

const { prisma } = await import("@/lib/prisma");
const { hashPassword } = await import("@/features/auth/password");
const { createUserWithWallet } = await import("@/features/users/create-user");
const { getActiveImageJob, getRecentImageJobs, getImageJobForUser, RECENT_IMAGES_MAX } = await import("@/features/generations/queries");
const { toJobView } = await import("@/features/generations/job-view");
type Status = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";

const TS = Date.now();
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const section = (s: string) => console.log(`\n# ${s}`);
const users: string[] = [];
const PW = await hashPassword("Stage6-Test-Pass!");
let seq = 0;
async function newUser() {
  const u = await createUserWithWallet({ name: "Stage6 Query Test", email: `e2e-stage6q-${TS}-${seq++}@example.com`, passwordHash: PW });
  users.push(u.id);
  return u.id;
}
const BASE = new Date(Date.now() - 60 * 60_000); // an hour ago, minute-spaced fixtures
const at = (minute: number) => new Date(BASE.getTime() + minute * 60_000);

/** Insert a job (and optionally an asset owned by `assetOwner`). Returns ids. */
async function job(userId: string, opts: { status: Status; minute: number; type?: "IMAGE" | "VIDEO"; asset?: boolean; assetOwner?: string }) {
  const j = await prisma.generationJob.create({
    data: {
      userId,
      type: opts.type ?? "IMAGE",
      status: opts.status,
      prompt: `fixture ${opts.status} ${opts.minute}`,
      settings: { quality: "fast", steps: 4, credits: 1, reservedCentiNeurons: 17_280 },
      estimatedCredits: 1,
      chargedCredits: opts.status === "COMPLETED" ? 1 : 0,
      createdAt: at(opts.minute),
      startedAt: opts.status === "PENDING" ? null : at(opts.minute),
      completedAt: opts.status === "COMPLETED" || opts.status === "FAILED" ? at(opts.minute) : null,
    },
    select: { id: true },
  });
  let assetId: string | null = null;
  if (opts.asset) {
    const owner = opts.assetOwner ?? userId;
    const a = await prisma.generatedAsset.create({
      data: {
        userId: owner, jobId: j.id, type: "IMAGE", storageKey: `users/${owner}/images/${j.id}/fixture-${TS}-${seq++}.webp`,
        width: 1024, height: 1024, mimeType: "image/webp", fileSize: BigInt(165_000), createdAt: at(opts.minute),
      },
      select: { id: true },
    });
    assetId = a.id;
  }
  return { id: j.id, assetId };
}
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

try {
  section("Fixtures");
  const A = await newUser(), B = await newUser(), C = await newUser(), D = await newUser(), E = await newUser();
  const aDone: { id: string; assetId: string | null }[] = [];
  for (let m = 0; m < 10; m++) aDone.push(await job(A, { status: "COMPLETED", minute: m, asset: true }));
  const aNoAsset = await job(A, { status: "COMPLETED", minute: 20 });
  const aFailed = await job(A, { status: "FAILED", minute: 21 });
  const aVideo = await job(A, { status: "COMPLETED", minute: 22, type: "VIDEO", asset: true });
  const aForeignAsset = await job(A, { status: "COMPLETED", minute: 23, asset: true, assetOwner: B });
  const aActive = await job(A, { status: "PROCESSING", minute: 24 });
  const bDone = [await job(B, { status: "COMPLETED", minute: 5, asset: true }), await job(B, { status: "COMPLETED", minute: 6, asset: true })];
  const bActive = await job(B, { status: "PENDING", minute: 30 });
  await job(D, { status: "PROCESSING", minute: 1, type: "VIDEO" });
  for (let m = 0; m < 30; m++) await job(E, { status: "COMPLETED", minute: m, asset: true });
  ok(true, "fixtures created (5 users; completed / no-asset / failed / video / foreign-asset / active jobs)");

  section("getRecentImageJobs");
  {
    const recent = await getRecentImageJobs(A);
    const expected = aDone.slice(2).reverse().map((j) => j.id); // newest 8 of the 10 valid jobs
    ok(recent.length === 8 && json(recent.map((r) => r.id)) === json(expected), "default take = 8, newest first");
    const all = await getRecentImageJobs(A, 24);
    const ids = new Set(all.map((r) => r.id));
    ok(all.length === 10 && aDone.every((j) => ids.has(j.id)), "returns exactly the 10 completed image jobs that have an owned asset");
    ok(!ids.has(aNoAsset.id), "completed job without an asset excluded");
    ok(!ids.has(aFailed.id) && !ids.has(aActive.id), "failed and in-progress jobs excluded (completed only)");
    ok(!ids.has(aVideo.id), "video jobs excluded (image only)");
    ok(!ids.has(aForeignAsset.id), "job whose only asset belongs to another user excluded (asset ownership filter)");
    ok(all.every((r) => r.status === "COMPLETED" && r.assets.length === 1), "every row is COMPLETED with exactly one asset");
    ok(all.every((r) => aDone.find((j) => j.id === r.id)?.assetId === r.assets[0].id), "each returned asset is the job's own asset");
    const assetKeys = json(Object.keys(all[0].assets[0]).sort());
    ok(assetKeys === json(["fileSize", "height", "id", "mimeType", "width"]), `asset fields limited to ${assetKeys}`);
    ok(!json(all).includes("storageKey") && !json(all).includes("users/"), "no storage key anywhere in the result");
    const views = all.map(toJobView);
    ok(views.every((v) => v.asset?.url === `/api/assets/${v.asset?.id}` && v.job.status === "COMPLETED"), "rows map through toJobView (stable asset URLs)");

    const b = await getRecentImageJobs(B, 24);
    ok(b.length === 2 && b.every((r) => bDone.some((j) => j.id === r.id)), "user B sees only B's images (A's job with B's asset is not B's job)");
    ok((await getRecentImageJobs(C)).length === 0, "user with no jobs → empty list");

    ok((await getRecentImageJobs(E)).length === 8, "E: default limit 8");
    ok((await getRecentImageJobs(E, 3)).length === 3, "E: take 3 → 3");
    ok((await getRecentImageJobs(E, 100)).length === RECENT_IMAGES_MAX && RECENT_IMAGES_MAX === 24, "E: take 100 → capped at 24");
    ok((await getRecentImageJobs(E, 0)).length === 1 && (await getRecentImageJobs(E, -5)).length === 1 && (await getRecentImageJobs(E, Number.NaN)).length === 1,
      "E: take ≤ 0 or NaN → clamped to 1");
  }

  section("getActiveImageJob");
  {
    const a = await getActiveImageJob(A);
    ok(a?.id === aActive.id && a.status === "PROCESSING", "A: returns the PROCESSING image job");
    const b = await getActiveImageJob(B);
    ok(b?.id === bActive.id && b.status === "PENDING", "B: returns the PENDING image job (not A's)");
    ok((await getActiveImageJob(C)) === null, "C: no jobs → null");
    ok((await getActiveImageJob(D)) === null, "D: active VIDEO job is not an active image job → null");
    ok((await getActiveImageJob(E)) === null, "E: only completed jobs → null");
    ok(!json(a).includes("storageKey") && toJobView(a!).job.id === aActive.id && toJobView(a!).asset === null, "active job maps through toJobView, no asset, no storage key");
  }

  section("getImageJobForUser (refactored select)");
  {
    const own = await getImageJobForUser(A, aDone[0].id);
    ok(own?.id === aDone[0].id && own.assets[0]?.id === aDone[0].assetId, "owner gets the job with its asset");
    ok((await getImageJobForUser(B, aDone[0].id)) === null, "another user gets null");
    ok((await getImageJobForUser(A, aVideo.id)) === null, "video job is not returned as an image job");
    const foreign = await getImageJobForUser(A, aForeignAsset.id);
    ok(foreign?.id === aForeignAsset.id && foreign.assets.length === 0, "asset owned by another user is never attached");
  }

  ok(fetchAttempts === 0, "no HTTP request attempted");
} catch (e) {
  fail++;
  console.error("UNCAUGHT", e);
} finally {
  // Only this run's users; their jobs and assets cascade. No reservations or budget rows were created.
  const del = await prisma.user.deleteMany({ where: { id: { in: users } } });
  const leftJobs = await prisma.generationJob.count({ where: { userId: { in: users } } });
  const leftAssets = await prisma.generatedAsset.count({ where: { userId: { in: users } } });
  console.log(`\ncleanup: deleted ${del.count} test users; remaining jobs ${leftJobs}, assets ${leftAssets}`);
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
