// Stage 9 Batch 6 (backend): submission switch, queued-job cancellation, download redirect,
// download-signing adapter option, worker race loser. Fully offline: no database, no storage,
// no provider calls. Run: npm run test:clipper-b6
import assert from "node:assert/strict";
import * as clipperNs from "../src/features/clipper/index";
const clipper = ((clipperNs as any).default ?? clipperNs) as typeof clipperNs;
const { SupabaseClipperStorage } = await import("../src/features/clipper/storage/supabase-clipper");

const {
  resolveClipperSubmissionsSwitch,
  createClipperHandlers,
  cancelQueuedClipJob,
  toClipJobView,
  processClipperJob,
  isEphemeralUploadKeyOwnedBy,
  CLIPPER_DOWNLOAD_URL_EXPIRY_SECONDS,
  CLIPPER_CLIP_DURATION_INFO,
} = clipper;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}:`, err);
  }
}

const ORIGIN = "https://app.yourai.test";
const USER = "usr_owner00001";
const JOB = "job_queued00001";
const ASSET = "ast_clip0000001";
const UPLOAD_KEY = `ephemeral/users/${USER}/uploads/upl_src0000001.mp4`;
const NOW = new Date("2026-11-11T10:00:00.000Z");

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
const get = (url: string) => new Request(`${ORIGIN}${url}`, { method: "GET" });

const record = (status: string, extra: Partial<clipperNs.ClipJobRecord> = {}): clipperNs.ClipJobRecord => ({
  id: JOB,
  status,
  createdAt: NOW,
  startedAt: null,
  completedAt: status === "CANCELLED" ? NOW : null,
  errorMessage: status === "CANCELLED" ? "Cancelled by the user before processing started (USER_CANCELLED)" : null,
  estimatedCredits: 10,
  chargedCredits: 0,
  settings: { sourceKey: UPLOAD_KEY, sourceType: "upload", targetAspectRatio: "9:16", targetFraming: "pillarbox_blur", requestedClipsCount: 2 },
  assets: [],
  ...extra,
});

/** Builds handlers whose upload/job dependencies throw if touched (proves "nothing reserved"). */
function handlers(over: Partial<clipperNs.ClipperHttpDeps> = {}) {
  const calls = { storage: 0, lock: 0, createJob: 0, findKey: 0, cancel: 0, sign: 0 };
  const forbidden = (what: keyof typeof calls) => () => {
    calls[what]++;
    throw new Error(`${what} must not be called`);
  };
  const storage = new Proxy({}, { get: () => forbidden("storage") }) as unknown as clipperNs.ClipperStorage;
  const uploads: clipperNs.ClipperUploadDeps = {
    storage,
    withUserLock: async () => forbidden("lock")(),
    isSourceKeyReferenced: async () => false,
  };
  const h = createClipperHandlers({
    getUserId: async () => USER,
    trustedOrigins: () => [ORIGIN],
    uploads,
    jobs: {
      uploads,
      loadPlatformVideoAsset: async () => null,
      findJobByIdempotencyKey: async () => (calls.findKey++, null),
      createJob: (async () => forbidden("createJob")()) as any,
    },
    loadJob: async () => record("PENDING"),
    loadBalance: async () => 90,
    signAsset: async () => "https://proj.supabase.co/sign/x?token=z",
    submissionsEnabled: () => false,
    cancelJob: async () => (calls.cancel++, { outcome: "not_found" as const }),
    signDownload: async () => (calls.sign++, null),
    log: { error: () => {} },
    ...over,
  });
  return { h, calls };
}

async function run() {
  // -------------------------------------------------------------------------
  // 1. CLIPPER_SUBMISSIONS_ENABLED resolution (fail closed in production)
  // -------------------------------------------------------------------------
  await test("switch: production defaults OFF when missing or blank", () => {
    assert.deepEqual(resolveClipperSubmissionsSwitch({ NODE_ENV: "production" }), { enabled: false, source: "default" });
    assert.deepEqual(resolveClipperSubmissionsSwitch({ NODE_ENV: "production", CLIPPER_SUBMISSIONS_ENABLED: "   " }), { enabled: false, source: "default" });
  });
  await test("switch: production is ON only for 'true' (trimmed, case-insensitive)", () => {
    assert.equal(resolveClipperSubmissionsSwitch({ NODE_ENV: "production", CLIPPER_SUBMISSIONS_ENABLED: "true" }).enabled, true);
    assert.equal(resolveClipperSubmissionsSwitch({ NODE_ENV: "production", CLIPPER_SUBMISSIONS_ENABLED: " TRUE " }).enabled, true);
  });
  await test("switch: production treats ambiguous values as OFF (1, yes, on, enabled, false)", () => {
    for (const v of ["1", "yes", "on", "enabled", "ture", "true;", "false", "0"]) {
      assert.equal(resolveClipperSubmissionsSwitch({ NODE_ENV: "production", CLIPPER_SUBMISSIONS_ENABLED: v }).enabled, false, v);
    }
    assert.equal(resolveClipperSubmissionsSwitch({ NODE_ENV: "production", CLIPPER_SUBMISSIONS_ENABLED: "yes" }).source, "invalid");
  });
  await test("switch: development defaults ON; 'false' turns it OFF; invalid is OFF", () => {
    assert.deepEqual(resolveClipperSubmissionsSwitch({ NODE_ENV: "development" }), { enabled: true, source: "default" });
    assert.deepEqual(resolveClipperSubmissionsSwitch({}), { enabled: true, source: "default" });
    assert.equal(resolveClipperSubmissionsSwitch({ NODE_ENV: "development", CLIPPER_SUBMISSIONS_ENABLED: "false" }).enabled, false);
    assert.equal(resolveClipperSubmissionsSwitch({ NODE_ENV: "development", CLIPPER_SUBMISSIONS_ENABLED: "maybe" }).enabled, false);
    assert.equal(resolveClipperSubmissionsSwitch({ NODE_ENV: "test", CLIPPER_SUBMISSIONS_ENABLED: "true" }).enabled, true);
  });

  // -------------------------------------------------------------------------
  // 2. HTTP gate: OFF refuses before any reservation or debit
  // -------------------------------------------------------------------------
  await test("gate OFF: upload intent → 503 CLIPPER_UNAVAILABLE, storage and user lock untouched", async () => {
    const { h, calls } = handlers();
    const res = await h.postUploadIntent(post("/api/clipper/uploads", { mimeType: "video/mp4", sizeBytes: 1000 }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "CLIPPER_UNAVAILABLE");
    assert.equal(calls.storage + calls.lock, 0);
  });
  await test("gate OFF: new clip job → 503, createJob never called (no debit)", async () => {
    const { h, calls } = handlers();
    const res = await h.postClipJob(post("/api/generations/clip", { source: { type: "upload", uploadKey: UPLOAD_KEY } }, { "idempotency-key": "clip-abcdefgh1234" }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "CLIPPER_UNAVAILABLE");
    assert.equal(calls.createJob, 0);
    assert.equal(calls.findKey, 1, "replay lookup happens first");
  });
  await test("gate OFF: replay of an existing Idempotency-Key still returns the job (recovery)", async () => {
    const { h, calls } = handlers({
      jobs: {
        uploads: { storage: {} as any, isSourceKeyReferenced: async () => false },
        loadPlatformVideoAsset: async () => null,
        findJobByIdempotencyKey: async () => ({ id: JOB }),
        createJob: (async () => {
          throw new Error("must not create");
        }) as any,
      },
    });
    const res = await h.postClipJob(post("/api/generations/clip", {}, { "idempotency-key": "clip-abcdefgh1234" }));
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.replayed, true);
    assert.equal(body.job.id, JOB);
    assert.equal(calls.createJob, 0);
  });
  await test("gate OFF: status reads still work", async () => {
    const { h } = handlers();
    const res = await h.getClipJob(get(`/api/generations/clip/${JOB}`), JOB);
    assert.equal(res.status, 200);
  });
  await test("gate OFF: upload discard is still allowed (reservations can always be released)", async () => {
    let deleted = "";
    const { h } = handlers({
      uploads: {
        storage: { delete: async (k: string) => void (deleted = k) } as any,
        withUserLock: async (_u, fn) => fn({ activeSourceKeys: async () => [] }),
        isSourceKeyReferenced: async () => false,
      },
    });
    const res = await h.postUploadDiscard(post("/api/clipper/uploads/discard", { uploadKey: UPLOAD_KEY }));
    assert.equal(res.status, 200);
    assert.equal(deleted, UPLOAD_KEY);
  });
  await test("gate ON: upload intent proceeds past the gate", async () => {
    const { h, calls } = handlers({ submissionsEnabled: () => true });
    await h.postUploadIntent(post("/api/clipper/uploads", { mimeType: "video/mp4", sizeBytes: 1000 }));
    assert.ok(calls.lock + calls.storage > 0, "reservation path was entered");
  });

  // -------------------------------------------------------------------------
  // 3. Cancel route
  // -------------------------------------------------------------------------
  await test("cancel: foreign origin 403, anonymous 401, cancelJob untouched", async () => {
    const { h, calls } = handlers();
    assert.equal((await h.postCancelClipJob(post(`/api/generations/clip/${JOB}/cancel`, {}, { origin: "https://evil.example" }), JOB)).status, 403);
    const anon = handlers({ getUserId: async () => null });
    assert.equal((await anon.h.postCancelClipJob(post(`/api/generations/clip/${JOB}/cancel`, {}), JOB)).status, 401);
    assert.equal(calls.cancel + anon.calls.cancel, 0);
  });
  await test("cancel: malformed job id → 404 without touching the database", async () => {
    const { h, calls } = handlers();
    const res = await h.postCancelClipJob(post("/api/generations/clip/x/cancel", {}), "../../x");
    assert.equal(res.status, 404);
    assert.equal(calls.cancel, 0);
  });
  await test("cancel: not found (or another user's job) → 404", async () => {
    const { h } = handlers();
    assert.equal((await h.postCancelClipJob(post(`/api/generations/clip/${JOB}/cancel`, {}), JOB)).status, 404);
  });
  await test("cancel: worker already started → 409 JOB_ALREADY_STARTED", async () => {
    const { h } = handlers({ cancelJob: async () => ({ outcome: "not_cancellable", status: "PROCESSING" }) });
    const res = await h.postCancelClipJob(post(`/api/generations/clip/${JOB}/cancel`, {}), JOB);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "JOB_ALREADY_STARTED");
  });
  await test("cancel: finished job → 409 JOB_ALREADY_FINISHED", async () => {
    const { h } = handlers({ cancelJob: async () => ({ outcome: "not_cancellable", status: "COMPLETED" }) });
    const res = await h.postCancelClipJob(post(`/api/generations/clip/${JOB}/cancel`, {}), JOB);
    assert.equal((await res.json()).error.code, "JOB_ALREADY_FINISHED");
  });
  await test("cancel: success → 200 with CANCELLED job view, refund message, no storage keys", async () => {
    const { h } = handlers({
      cancelJob: async () => ({ outcome: "cancelled", refunded: true, sourceCleanup: "deleted" }),
      loadJob: async () => record("CANCELLED"),
    });
    const res = await h.postCancelClipJob(post(`/api/generations/clip/${JOB}/cancel`, {}), JOB);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("ephemeral/"), "no storage key leaks");
    const body = JSON.parse(text);
    assert.equal(body.job.status, "CANCELLED");
    assert.equal(body.job.error.code, "USER_CANCELLED");
    assert.match(body.job.error.message, /refunded/);
  });
  await test("cancel: works while submissions are switched OFF (refunds are never blocked)", async () => {
    const { h } = handlers({
      submissionsEnabled: () => false,
      cancelJob: async () => ({ outcome: "cancelled", refunded: true, sourceCleanup: "deleted" }),
      loadJob: async () => record("CANCELLED"),
    });
    assert.equal((await h.postCancelClipJob(post(`/api/generations/clip/${JOB}/cancel`, {}), JOB)).status, 200);
  });

  // -------------------------------------------------------------------------
  // 4. cancelQueuedClipJob orchestration (source deletion only by the winner)
  // -------------------------------------------------------------------------
  const settledResult = (settings: unknown = { sourceType: "upload", sourceKey: UPLOAD_KEY }) => ({
    settled: true as const,
    refund: { refunded: true, amount: 10 } as any,
    settings,
  });
  await test("orchestration: winner deletes its own upload and records the cleanup", async () => {
    const deleted: string[] = [];
    const recorded: any[] = [];
    const out = await cancelQueuedClipJob(
      {
        cancelInDb: async () => settledResult(),
        storage: { delete: async (k) => void deleted.push(k) },
        recordCleanup: async (p) => void recorded.push(p),
      },
      { userId: USER, jobId: JOB },
    );
    assert.deepEqual(out, { outcome: "cancelled", refunded: true, sourceCleanup: "deleted" });
    assert.deepEqual(deleted, [UPLOAD_KEY]);
    assert.deepEqual(recorded[0], { jobId: JOB, results: [{ key: UPLOAD_KEY, success: true }] });
  });
  await test("orchestration: loser of the race (worker started) deletes nothing", async () => {
    let deletes = 0;
    const out = await cancelQueuedClipJob(
      {
        cancelInDb: async () => ({ settled: false, currentStatus: "PROCESSING" }),
        storage: { delete: async () => void deletes++ },
        recordCleanup: async () => undefined,
      },
      { userId: USER, jobId: JOB },
    );
    assert.deepEqual(out, { outcome: "not_cancellable", status: "PROCESSING" });
    assert.equal(deletes, 0);
  });
  await test("orchestration: missing job → not_found; malformed id never reaches the database", async () => {
    let dbCalls = 0;
    const deps = {
      cancelInDb: async () => (dbCalls++, { settled: false as const, currentStatus: null }),
      storage: { delete: async () => undefined },
      recordCleanup: async () => undefined,
    };
    assert.deepEqual(await cancelQueuedClipJob(deps, { userId: USER, jobId: JOB }), { outcome: "not_found" });
    assert.deepEqual(await cancelQueuedClipJob(deps, { userId: USER, jobId: "bad/id" }), { outcome: "not_found" });
    assert.equal(dbCalls, 1);
  });
  await test("orchestration: failed delete stays pending for the cron retry (still cancelled + refunded)", async () => {
    const recorded: any[] = [];
    const out = await cancelQueuedClipJob(
      {
        cancelInDb: async () => settledResult(),
        storage: {
          delete: async () => {
            throw Object.assign(new Error("down"), { name: "StorageDown" });
          },
        },
        recordCleanup: async (p) => void recorded.push(p),
      },
      { userId: USER, jobId: JOB },
    );
    assert.equal(out.outcome, "cancelled");
    assert.equal((out as any).sourceCleanup, "pending_retry");
    assert.deepEqual(recorded[0].results, [{ key: UPLOAD_KEY, success: false, error: "StorageDown" }]);
  });
  await test("orchestration: a cleanup-recording failure never undoes the cancellation", async () => {
    const out = await cancelQueuedClipJob(
      {
        cancelInDb: async () => settledResult(),
        storage: { delete: async () => undefined },
        recordCleanup: async () => {
          throw new Error("db down");
        },
        log: { error: () => {} },
      },
      { userId: USER, jobId: JOB },
    );
    assert.equal(out.outcome, "cancelled");
  });
  await test("orchestration: platform-asset and foreign keys are never deleted", async () => {
    let deletes = 0;
    const deps = (settings: unknown) => ({
      cancelInDb: async () => settledResult(settings),
      storage: { delete: async () => void deletes++ },
      recordCleanup: async () => undefined,
    });
    const a = await cancelQueuedClipJob(deps({ sourceType: "platform_asset", sourceKey: `users/${USER}/videos/v.mp4` }), { userId: USER, jobId: JOB });
    const b = await cancelQueuedClipJob(deps({ sourceType: "upload", sourceKey: `ephemeral/users/usr_other00001/uploads/upl_src0000001.mp4` }), { userId: USER, jobId: JOB });
    assert.equal((a as any).sourceCleanup, "not_applicable");
    assert.equal((b as any).sourceCleanup, "not_applicable");
    assert.equal(deletes, 0);
    assert.equal(isEphemeralUploadKeyOwnedBy(UPLOAD_KEY, USER), true, "fixture key is a real owned upload key");
  });

  // -------------------------------------------------------------------------
  // 5. Worker race loser (cancel won): processClipperJob does nothing at all
  // -------------------------------------------------------------------------
  await test("worker after a winning cancel: not_claimed, no materialize, no storage, no settlement", async () => {
    const touched: string[] = [];
    const lifecycle = {
      markStarted: async () => false,
      claimLease: async () => ({ claimed: false, reason: "already_claimed_or_not_processing" }),
    } as Record<string, unknown>;
    const guard = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, prop) => {
            if (prop === "then") return undefined;
            if (name === "engine" && prop === "name") return "ffmpeg-clipper-engine";
            touched.push(`${name}.${String(prop)}`);
            return () => {
              throw new Error(`${name}.${String(prop)} must not be used`);
            };
          },
        },
      );
    const out = await processClipperJob(
      {
        job: { id: JOB, userId: USER, settings: { sourceType: "upload", sourceKey: UPLOAD_KEY } as any },
        source: guard("source") as any,
      },
      {
        lifecycle: new Proxy(lifecycle, {
          get: (t, prop) => (prop in t ? t[prop as string] : (touched.push(`lifecycle.${String(prop)}`), undefined)),
        }) as any,
        storage: guard("storage") as any,
        engine: guard("engine") as any,
      } as any,
    );
    assert.equal(out.status, "not_claimed");
    assert.deepEqual(touched, []);
  });

  // -------------------------------------------------------------------------
  // 6. Download redirect route
  // -------------------------------------------------------------------------
  const dl = `/api/generations/clip/${JOB}/clips/${ASSET}/download`;
  await test("download: anonymous → 401 without signing", async () => {
    const { h, calls } = handlers({ getUserId: async () => null });
    assert.equal((await h.getClipDownload(get(dl), JOB, ASSET)).status, 401);
    assert.equal(calls.sign, 0);
  });
  await test("download: malformed ids → 404 without signing", async () => {
    const { h, calls } = handlers();
    assert.equal((await h.getClipDownload(get(dl), "../x", ASSET)).status, 404);
    assert.equal((await h.getClipDownload(get(dl), JOB, "a b")).status, 404);
    assert.equal(calls.sign, 0);
  });
  await test("download: asset not owned / not in a completed job → 404", async () => {
    const { h, calls } = handlers();
    assert.equal((await h.getClipDownload(get(dl), JOB, ASSET)).status, 404);
    assert.equal(calls.sign, 1);
  });
  await test("download: owned asset → 302 to the signed URL, no-store, no-referrer, empty body", async () => {
    const signedArgs: string[][] = [];
    const { h } = handlers({
      signDownload: async (u, j, a) => (signedArgs.push([u, j, a]), "https://proj.supabase.co/storage/v1/object/sign/b/k.mp4?token=t&download=yourai-clip.mp4"),
    });
    const res = await h.getClipDownload(get(dl), JOB, ASSET);
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /download=/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(await res.text(), "");
    assert.deepEqual(signedArgs, [[USER, JOB, ASSET]], "signing is scoped to the session user");
  });
  await test("download: signing failure → 503, no URL leaked", async () => {
    const { h } = handlers({
      signDownload: async () => {
        throw new Error("users/secret/key.mp4");
      },
    });
    const res = await h.getClipDownload(get(dl), JOB, ASSET);
    assert.equal(res.status, 503);
    assert.ok(!(await res.text()).includes("secret"));
  });
  await test("download: rate limited → 429", async () => {
    const { h } = handlers({ checkRateLimit: () => ({ allowed: false, retryAfterSeconds: 7 }) });
    const res = await h.getClipDownload(get(dl), JOB, ASSET);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7");
  });

  // -------------------------------------------------------------------------
  // 7. Supabase adapter: download option + origin pinning
  // -------------------------------------------------------------------------
  await test("adapter: download filename is forwarded to createSignedUrl; plain signing unchanged", async () => {
    const seen: unknown[][] = [];
    const client = {
      storage: {
        from: () => ({
          createSignedUrl: async (...args: unknown[]) => (seen.push(args), { data: { signedUrl: "https://proj.supabase.co/storage/v1/object/sign/b/k?token=t" }, error: null }),
        }),
      },
    };
    const s = new SupabaseClipperStorage(client as any, "b", "https://proj.supabase.co");
    await s.createSignedUrl("k", CLIPPER_DOWNLOAD_URL_EXPIRY_SECONDS, { download: "yourai-clip-1.mp4" });
    await s.createSignedUrl("k", 600);
    assert.deepEqual(seen[0], ["k", 60, { download: "yourai-clip-1.mp4" }]);
    assert.deepEqual(seen[1], ["k", 600]);
  });
  await test("adapter: a download URL on a foreign origin is rejected", async () => {
    const client = { storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://evil.example/x" }, error: null }) }) } };
    const s = new SupabaseClipperStorage(client as any, "b", "https://proj.supabase.co");
    await assert.rejects(() => s.createSignedUrl("k", 60, { download: "a.mp4" }));
  });
  await test("download link lifetime is short (60 s)", () => {
    assert.equal(CLIPPER_DOWNLOAD_URL_EXPIRY_SECONDS, 60);
  });

  // -------------------------------------------------------------------------
  // 8. Job view + fixed duration info
  // -------------------------------------------------------------------------
  await test("job view: user cancellation has a public code and refund message", () => {
    const v = toClipJobView(record("CANCELLED"));
    assert.deepEqual(v.error, { code: "USER_CANCELLED", message: "You cancelled this job before processing started. Credits were refunded." });
    assert.deepEqual(v.clips, []);
  });
  await test("fixed clip duration info mirrors the planner constants (30 s target, 5–60 s)", () => {
    assert.deepEqual({ ...CLIPPER_CLIP_DURATION_INFO }, { targetSeconds: 30, minSeconds: 5, maxSeconds: 60 });
  });

  console.log(`\n  Tests Passed: ${passed}\n  Tests Failed: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Unhandled test error:", err);
  process.exit(1);
});
