// Stage 6 / B3 offline tests: the client generation state machine (GenerationController) and
// the blob download helper. The controller runs with a scripted fake API, a fake clock whose
// sleeps advance time instantly, in-memory storage and a controllable tab-visibility flag.
// No network, database, Cloudflare or Supabase. Run: npm run test:ui-flow
let realNetworkAttempts = 0;
globalThis.fetch = (async () => {
  realNetworkAttempts++;
  throw new Error("Network access is forbidden in offline tests");
}) as typeof fetch;

const { GenerationController } = await import("@/features/generations/client/generation-controller");
const pr = await import("@/features/generations/client/pending-request");
const { downloadAsset, assetFilename, isAssetUrl } = await import("@/features/generations/client/download");
type GenerationState = import("@/features/generations/client/generation-controller").GenerationState;
type GenerationApiResult = import("@/features/generations/client/api").GenerationApiResult;

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const section = (s: string) => console.log(`\n# ${s}`);
const tick = () => new Promise((r) => setImmediate(r));

const USER = "cuser000000000000000000001";
const JOB = "cjob0000000000000000000001";
const T0 = Date.parse("2026-11-10T09:00:00.000Z");

// ------------------------------------------------------------------ fixtures
type Job = { status: string; outcomeUnknown?: boolean; error?: unknown; asset?: boolean; id?: string; prompt?: string };
const jobBody = (j: Job) => ({
  job: {
    id: j.id ?? JOB, status: j.status, quality: "fast", prompt: j.prompt ?? "a cat", creditsCharged: j.status === "COMPLETED" ? 1 : 0,
    createdAt: "2026-11-10T09:00:00.000Z", completedAt: null, outcomeUnknown: j.outcomeUnknown ?? false, error: j.error ?? null,
  },
  asset: j.status === "COMPLETED" && j.asset !== false ? { id: "asset-1", url: "/api/assets/asset-1", width: 1024, height: 1024, mimeType: "image/webp", sizeBytes: 9 } : null,
  replayed: false,
  balance: 99,
});
const job = (httpStatus: number, j: Job, retryAfterSeconds: number | null = 3): GenerationApiResult =>
  ({ kind: "job", httpStatus, body: jobBody(j) as never, retryAfterSeconds });
const err = (httpStatus: number, code: string, extra: { resetAt?: string; jobId?: string } = {}): GenerationApiResult =>
  ({ kind: "error", httpStatus, error: { code: code as never, message: `msg ${code}`, resetAt: extra.resetAt ?? null, jobId: extra.jobId ?? null }, retryAfterSeconds: null });
const NET: GenerationApiResult = { kind: "network", idempotencyKey: null };
const FAILED_REFUNDED = { code: "GENERATION_FAILED", reason: "SERVICE_BUSY", message: "The image service is busy right now. Your credits were refunded — please try again later.", refunded: true };

class MemoryStore {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

/** Build a controller with scripted POST / GET responses (functions of the call index). */
function harness(opts: {
  post?: (i: number, key: string) => GenerationApiResult | Promise<GenerationApiResult>;
  get?: (i: number, jobId: string) => GenerationApiResult | Promise<GenerationApiResult>;
} = {}) {
  let clock = T0;
  let hidden = false;
  let visibleResolvers: (() => void)[] = [];
  const store = new MemoryStore();
  const posts: { key: string; prompt: string; quality: string; signal?: AbortSignal }[] = [];
  const gets: { jobId: string; at: number }[] = [];
  const sleeps: number[] = [];
  const states: GenerationState[] = [];
  let keys = 0;
  const calls = { settled: 0, unauth: 0 };
  const c = new GenerationController({
    userId: USER,
    store,
    api: {
      post: async (req, o) => { posts.push({ key: req.idempotencyKey, prompt: req.prompt, quality: req.quality, signal: o?.signal }); await tick(); return (opts.post ?? (() => job(201, { status: "COMPLETED" })))(posts.length - 1, req.idempotencyKey); },
      get: async (id) => { gets.push({ jobId: id, at: clock }); await tick(); return (opts.get ?? (() => job(200, { status: "COMPLETED" })))(gets.length - 1, id); },
    },
    now: () => clock,
    sleep: async (ms, signal) => { if (signal.aborted) return; sleeps.push(ms); clock += ms; await tick(); },
    visibility: {
      isHidden: () => hidden,
      waitUntilVisible: (signal) => new Promise<void>((r) => { if (!hidden || signal.aborted) return r(); visibleResolvers.push(r); signal.addEventListener("abort", () => r(), { once: true }); }),
    },
    randomId: () => `key-${String(++keys).padStart(4, "0")}-aaaaaaaa`,
    onSettled: () => { calls.settled++; },
    onUnauthenticated: () => { calls.unauth++; },
  });
  c.subscribe(() => states.push(c.getState()));
  c.attach();
  const stored = () => pr.loadPendingRequest(store, USER, clock);
  const until = async (pred: () => boolean, max = 5000) => { for (let i = 0; i < max && !pred(); i++) await tick(); return pred(); };
  const settle = () => until(() => !c.busy);
  return {
    c, store, posts, gets, sleeps, states, calls, stored, until, settle,
    keysCreated: () => keys,
    advance: (ms: number) => { clock += ms; },
    setHidden: (h: boolean) => { hidden = h; if (!h) { visibleResolvers.forEach((r) => r()); visibleResolvers = []; } },
  };
}
const phases = (h: ReturnType<typeof harness>) => [...new Set(h.states.map((s) => s.phase))];
const phase = (h: ReturnType<typeof harness>) => h.c.getState().phase;

try {
  section("Happy paths");
  {
    const h = harness();
    ok(h.c.submit({ prompt: "a cat", quality: "fast" }), "submit accepted while idle");
    ok(h.stored()?.key === "key-0001-aaaaaaaa", "pending request persisted BEFORE the response");
    await h.settle();
    const s = h.c.getState();
    ok(s.phase === "completed" && s.asset.url === "/api/assets/asset-1", "201 COMPLETED → completed with the /api/assets/ URL");
    ok(JSON.stringify(phases(h)) === JSON.stringify(["submitting", "completed"]), "transitions: submitting → completed");
    ok(h.posts.length === 1 && h.gets.length === 0, "one POST, no polling");
    ok(h.stored() === null, "pending request cleared after confirmed completion");
    ok(h.calls.settled === 1, "server data refreshed once (router.refresh)");
    ok(!JSON.stringify(h.states).includes("supabase") && !JSON.stringify(h.states).includes("users/"), "state never holds signed URLs or storage keys");
  }
  {
    const h = harness({
      post: () => job(202, { status: "PROCESSING" }, 3),
      get: (i) => (i < 2 ? job(200, { status: "PROCESSING" }, 3) : job(200, { status: "COMPLETED" })),
    });
    h.c.submit({ prompt: "a cat", quality: "detailed" });
    await h.until(() => h.stored()?.jobId === JOB);
    ok(h.stored()?.jobId === JOB && h.stored()?.key === "key-0001-aaaaaaaa", "202 → job id stored with the SAME key");
    await h.settle();
    ok(phase(h) === "completed" && h.gets.length === 3 && h.posts.length === 1, "202 → polls until COMPLETED (3 GETs, still one POST)");
    ok(JSON.stringify(phases(h)) === JSON.stringify(["submitting", "polling", "completed"]), "transitions: submitting → polling → completed");
    ok(JSON.stringify(h.sleeps) === JSON.stringify([3000, 3000, 3000]), "poll interval follows Retry-After (3 s)");
    ok(h.posts[0].quality === "detailed" && h.stored() === null && h.calls.settled === 1, "quality sent; pending cleared; refreshed once");
  }
  {
    const h = harness({ post: () => job(200, { status: "COMPLETED" }) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "completed", "200 (replayed finished job) → completed");
  }

  section("Failures with a job (refunded)");
  {
    const h = harness({ post: () => job(502, { status: "FAILED", error: FAILED_REFUNDED }) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    const s = h.c.getState();
    ok(s.phase === "failed" && s.message.includes("refunded"), "502 with a FAILED job → failed, server's refunded message");
    ok(h.stored() === null && h.calls.settled === 1 && h.gets.length === 0, "pending cleared, data refreshed, no polling");
  }
  {
    const h = harness({
      post: () => job(202, { status: "PROCESSING", outcomeUnknown: true }),
      get: (i) => (i < 2 ? job(200, { status: "PROCESSING", outcomeUnknown: true }) : job(200, { status: "FAILED", error: { ...FAILED_REFUNDED, reason: "TIMED_OUT" } })),
    });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.until(() => h.c.getState().phase === "polling");
    const p = h.c.getState();
    ok(p.phase === "polling" && p.outcomeUnknown, "202 outcome unknown → polling with outcomeUnknown (checking state)");
    await h.settle();
    ok(phase(h) === "failed" && h.posts.length === 1, "unknown outcome later reconciled → failed (refunded); never re-submitted");
  }
  {
    const h = harness({ get: (i) => (i === 0 ? job(200, { status: "PROCESSING" }) : job(200, { status: "CANCELLED" })), post: () => job(202, { status: "PENDING" }) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "failed", "CANCELLED is terminal → failed");
  }
  {
    const h = harness({ post: () => job(201, { status: "COMPLETED", asset: false }) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "stalled" && h.stored() !== null, "COMPLETED without an asset → NOT claimed as done (stalled, request kept)");
  }

  section("Rejected before a job exists");
  for (const [status, code, refresh] of [
    [402, "INSUFFICIENT_CREDITS", true], [409, "ACTIVE_JOB_EXISTS", true], [409, "IDEMPOTENCY_CONFLICT", false],
    [429, "DAILY_LIMIT_REACHED", true], [503, "CAPACITY_EXHAUSTED", true], [503, "SERVICE_UNAVAILABLE", false],
    [400, "INVALID_INPUT", false], [403, "FORBIDDEN_ORIGIN", false],
  ] as const) {
    const h = harness({ post: () => err(status, code, { resetAt: code === "DAILY_LIMIT_REACHED" ? "2026-11-11T00:00:00.000Z" : undefined }) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    const s = h.c.getState();
    ok(s.phase === "error" && s.code === code && h.posts.length === 1 && h.gets.length === 0 && h.stored() === null && h.calls.settled === (refresh ? 1 : 0),
      `${status} ${code} → error, single POST, pending cleared${refresh ? ", data refreshed" : ""}`);
  }
  {
    const h = harness({ post: () => err(429, "DAILY_LIMIT_REACHED", { resetAt: "2026-11-11T00:00:00.000Z" }) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    const s = h.c.getState();
    ok(s.phase === "error" && s.resetAt === "2026-11-11T00:00:00.000Z", "429 keeps resetAt for display");
  }
  {
    const h = harness({ post: () => err(401, "UNAUTHENTICATED") });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "error" && h.calls.unauth === 1 && h.stored()?.key === "key-0001-aaaaaaaa", "401 → sign-in redirect; pending KEPT for recovery with the same key");
  }

  section("Network loss and uncertain outcomes (same key, never a second generation)");
  {
    const h = harness({ post: (i) => (i < 3 ? NET : job(201, { status: "COMPLETED" })) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.until(() => { const s = h.c.getState(); return s.phase === "submitting" && s.checking; });
    ok(true, "network loss → submitting (checking: connection interrupted)");
    await h.settle();
    ok(phase(h) === "completed" && h.posts.length === 4, "replayed until the job is confirmed");
    ok(h.posts.every((p) => p.key === "key-0001-aaaaaaaa") && h.keysCreated() === 1, "all 4 attempts used the SAME key; only one key ever created");
    ok(JSON.stringify(h.sleeps) === JSON.stringify([3000, 6000, 12000]), "replay backoff: 3, 6, 12 s");
    ok(h.posts.every((p) => p.prompt === "a cat" && p.quality === "fast"), "replays send the identical body");
  }
  {
    const h = harness({ post: () => NET });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    const s = h.c.getState();
    ok(s.phase === "stalled" && s.jobId === null && h.stored()?.key === "key-0001-aaaaaaaa", "network down for 7 minutes → stalled, request (and key) kept");
    ok(h.sleeps.slice(3).every((ms) => ms === 30_000) && h.keysCreated() === 1, "backoff capped at 30 s; still one key");
  }
  {
    const h = harness({ post: (i) => (i === 0 ? err(504, "UNKNOWN") : job(201, { status: "COMPLETED" })) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "completed" && h.posts.length === 2 && h.posts[1].key === h.posts[0].key, "504 proxy page (uncertain) → replay with the same key");
  }
  {
    const h = harness({ post: () => err(500, "INTERNAL_ERROR", { jobId: JOB }), get: () => job(200, { status: "COMPLETED" }) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "completed" && h.posts.length === 1 && h.gets.length === 1 && h.gets[0].jobId === JOB, "500 with jobId → polls that job (no re-POST)");
  }
  {
    const h = harness({ post: (i) => (i === 0 ? err(500, "INTERNAL_ERROR") : job(201, { status: "COMPLETED" })) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "completed" && h.posts.length === 2 && h.posts[1].key === h.posts[0].key, "500 without jobId → replay with the same key");
  }

  section("Duplicate clicks and explicit new generations");
  {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({ post: async () => { await gate; return job(201, { status: "COMPLETED" }); } });
    const first = h.c.submit({ prompt: "a cat", quality: "fast" });
    const second = h.c.submit({ prompt: "a cat", quality: "fast" });
    const third = h.c.submit({ prompt: "a dog", quality: "detailed" });
    ok(first && !second && !third, "submits while busy are ignored");
    release();
    await h.settle();
    ok(h.posts.length === 1 && h.keysCreated() === 1, "duplicate clicks → exactly one POST and one key");
    ok(h.c.submit({ prompt: "a dog", quality: "fast" }), "after completion an explicit submit is accepted");
    await h.settle();
    ok(h.posts.length === 2 && h.posts[1].key !== h.posts[0].key && h.keysCreated() === 2, "…and it is a new request with a NEW key (user action only)");
  }

  section("Polling behaviour");
  {
    const h = harness({
      post: () => job(202, { status: "PROCESSING" }),
      get: (i) => (i < 4 ? NET : i === 4 ? err(503, "SERVICE_UNAVAILABLE") : job(200, { status: "COMPLETED" })),
    });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.until(() => { const s = h.c.getState(); return s.phase === "polling" && s.checking; });
    ok(true, "poll network failure → polling (checking)");
    await h.settle();
    ok(phase(h) === "completed", "recovers once the server answers");
    ok(JSON.stringify(h.sleeps) === JSON.stringify([3000, 3000, 6000, 12000, 30000, 30000]), "poll backoff after failures: 3, 6, 12, 30, 30 s");
    ok(h.posts.length === 1, "poll failures never trigger a POST");
  }
  {
    const h = harness({ post: () => job(202, { status: "PROCESSING" }), get: () => job(200, { status: "PROCESSING" }) });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    const s = h.c.getState();
    ok(s.phase === "stalled" && s.jobId === JOB && h.stored()?.jobId === JOB, "still PROCESSING after 7 minutes → stalled (job id kept)");
    ok(h.gets.length === 140 && h.sleeps.reduce((a, b) => a + b, 0) === 7 * 60_000, "polled every 3 s for exactly 7 minutes (140 GETs), then stopped");
    // Check again: polls the same job; never re-submits.
    const getsBefore = h.gets.length;
    ok(h.c.checkAgain(), "Check again accepted from stalled");
    await h.until(() => h.gets.length > getsBefore);
    ok(h.posts.length === 1 && h.gets.at(-1)?.jobId === JOB, "Check again polls the same job (no POST)");
    h.c.detach();
  }
  {
    const h = harness({ post: () => job(202, { status: "PROCESSING" }), get: () => err(404, "NOT_FOUND") });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "error" && h.stored() === null, "poll 404 → error, pending cleared");
  }
  {
    const h = harness({ post: () => job(202, { status: "PROCESSING" }), get: () => err(401, "UNAUTHENTICATED") });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    ok(phase(h) === "error" && h.calls.unauth === 1 && h.stored()?.jobId === JOB, "poll 401 → sign-in redirect, pending kept");
  }
  {
    const h = harness({ post: () => job(202, { status: "PROCESSING" }), get: (i) => (i < 1 ? job(200, { status: "PROCESSING" }) : job(200, { status: "COMPLETED" })) });
    h.setHidden(true);
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.until(() => h.gets.length === 1);
    for (let i = 0; i < 50; i++) await tick();
    ok(h.gets.length === 1 && phase(h) === "polling", "hidden tab → polling paused after the first result");
    h.setHidden(false);
    await h.settle();
    ok(phase(h) === "completed" && h.gets.length === 2, "visible again → polls immediately and completes");
  }

  section("Detach / stale runs");
  {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({ post: async () => { await gate; return job(201, { status: "COMPLETED" }); } });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.until(() => h.posts.length === 1);
    h.c.detach();
    ok(h.posts[0].signal?.aborted === true, "detach aborts the browser request (the server's own work is unaffected)");
    release();
    for (let i = 0; i < 20; i++) await tick();
    ok(phase(h) === "submitting" && h.stored()?.key === "key-0001-aaaaaaaa" && h.calls.settled === 0, "no state change after detach; pending kept for recovery");
  }
  {
    const h = harness({ post: () => err(402, "INSUFFICIENT_CREDITS") });
    h.c.submit({ prompt: "a cat", quality: "fast" });
    await h.settle();
    h.c.reset();
    ok(phase(h) === "idle", "reset clears an error back to idle");
    const busy = harness({ post: () => new Promise(() => {}) });
    busy.c.submit({ prompt: "a cat", quality: "fast" });
    busy.c.reset();
    ok(phase(busy) === "submitting", "reset never cancels an in-progress job");
    busy.c.detach();
  }

  section("Download helper");
  {
    ok(assetFilename(JOB) === `pixora-${JOB}.webp` && assetFilename("../x") === "pixora-image.webp", "filename pixora-<jobId>.webp (sanitised)");
    ok(isAssetUrl("/api/assets/asset-1") && !isAssetUrl("https://x.supabase.co/storage/v1/object/sign/a") && !isAssetUrl("/api/assets/../secret"), "only same-origin /api/assets/ URLs");
    const clicks: [string, string][] = []; const revoked: string[] = []; const opened: string[] = []; const fetched: string[] = [];
    const deps = {
      fetchImpl: async (u: string) => { fetched.push(u); return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" })); },
      createObjectURL: () => "blob:local/1",
      revokeObjectURL: (u: string) => { revoked.push(u); },
      clickDownloadLink: (href: string, name: string) => { clicks.push([href, name]); },
      openWindow: (u: string) => { opened.push(u); },
      schedule: (fn: () => void) => fn(),
    };
    const r1 = await downloadAsset({ url: "/api/assets/asset-1", jobId: JOB }, deps);
    ok(r1 === "downloaded" && fetched[0] === "/api/assets/asset-1" && clicks[0][0] === "blob:local/1" && clicks[0][1] === `pixora-${JOB}.webp` && revoked[0] === "blob:local/1",
      "fetches the asset route as a blob, saves pixora-<jobId>.webp, revokes the object URL");
    const r2 = await downloadAsset({ url: "/api/assets/asset-1", jobId: JOB }, { ...deps, fetchImpl: async () => { throw new TypeError("CORS"); } });
    ok(r2 === "opened" && opened[0] === "/api/assets/asset-1", "cross-origin read blocked → opens /api/assets/ in a new tab");
    const r3 = await downloadAsset({ url: "/api/assets/asset-1", jobId: JOB }, { ...deps, fetchImpl: async () => new Response("<html>", { headers: { "content-type": "text/html" } }) });
    ok(r3 === "opened", "non-image response → fallback (never saves HTML as .webp)");
    const r4 = await downloadAsset({ url: "https://evil.example/x.webp", jobId: JOB }, deps);
    ok(r4 === "failed" && fetched.length === 1, "foreign URL refused without any request (shared fetch still called only once, by the first case)");
  }

  ok(realNetworkAttempts === 0, "no real network request was attempted");
} catch (e) {
  fail++;
  console.error("UNCAUGHT", e);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
