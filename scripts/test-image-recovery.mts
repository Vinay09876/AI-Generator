// Stage 6 / B4 offline tests: page-load recovery, adoption of server-reported active jobs,
// held / expired requests, visibility handling, manual checks and Strict Mode safety.
//
// A "reload" is a NEW controller over the SAME storage (exactly what a browser refresh does).
// Every POST and its idempotency key is recorded so each scenario can assert "at most one
// generation, always the original key". No network, database, Cloudflare or Supabase.
// Run: npm run test:ui-recovery
let realNetworkAttempts = 0;
globalThis.fetch = (async () => {
  realNetworkAttempts++;
  throw new Error("Network access is forbidden in offline tests");
}) as typeof fetch;

const { GenerationController } = await import("@/features/generations/client/generation-controller");
const { startRecoveryOnMount } = await import("@/features/generations/client/recovery-scheduler");
const pr = await import("@/features/generations/client/pending-request");
type GenerationApiResult = import("@/features/generations/client/api").GenerationApiResult;
type ActiveJobInput = import("@/features/generations/client/generation-controller").ActiveJobInput;
type PendingRequest = import("@/features/generations/client/pending-request").PendingRequest;

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const section = (s: string) => console.log(`\n# ${s}`);
const tick = () => new Promise((r) => setImmediate(r));

const USER = "cuser000000000000000000001";
const JOB = "cjob0000000000000000000001";
const OTHER_JOB = "cjob0000000000000000000002";
const KEY = "orig-key-0001-aaaaaaaa";
const T0 = Date.parse("2026-11-10T09:00:00.000Z");

const body = (status: string, extra: { id?: string; prompt?: string; outcomeUnknown?: boolean; error?: unknown } = {}) => ({
  job: {
    id: extra.id ?? JOB, status, quality: "fast", prompt: extra.prompt ?? "a cat", creditsCharged: status === "COMPLETED" ? 1 : 0,
    createdAt: "x", completedAt: null, outcomeUnknown: extra.outcomeUnknown ?? false, error: extra.error ?? null,
  },
  asset: status === "COMPLETED" ? { id: "asset-1", url: "/api/assets/asset-1", width: 1024, height: 1024, mimeType: "image/webp", sizeBytes: 9 } : null,
  replayed: false,
  balance: 99,
});
const job = (httpStatus: number, status: string, extra: Parameters<typeof body>[1] = {}, retry: number | null = 3): GenerationApiResult =>
  ({ kind: "job", httpStatus, body: body(status, extra) as never, retryAfterSeconds: retry });
const err = (httpStatus: number, code: string): GenerationApiResult =>
  ({ kind: "error", httpStatus, error: { code: code as never, message: `msg ${code}`, resetAt: null, jobId: null }, retryAfterSeconds: null });
const NET: GenerationApiResult = { kind: "network", idempotencyKey: null };

class MemoryStore {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}
const saved = (over: Partial<PendingRequest> = {}): PendingRequest => ({ v: 1, key: KEY, prompt: "a cat", quality: "fast", startedAt: T0, ...over });

/** One "page": a controller over a shared store, clock and request log. */
function page(env: {
  store: MemoryStore;
  clock: { now: number };
  log: { posts: string[]; gets: string[] };
  post?: (i: number, key: string) => GenerationApiResult | Promise<GenerationApiResult>;
  get?: (i: number, id: string) => GenerationApiResult | Promise<GenerationApiResult>;
  hidden?: { value: boolean; resolvers: (() => void)[] };
}) {
  let keys = 0;
  const hidden = env.hidden ?? { value: false, resolvers: [] };
  const calls = { settled: 0, unauth: 0 };
  let posts = 0, gets = 0;
  const c = new GenerationController({
    userId: USER,
    store: env.store,
    api: {
      post: async (req) => { env.log.posts.push(req.idempotencyKey); const i = posts++; await tick(); return (env.post ?? (() => job(201, "COMPLETED")))(i, req.idempotencyKey); },
      get: async (id) => { env.log.gets.push(id); const i = gets++; await tick(); return (env.get ?? (() => job(200, "COMPLETED")))(i, id); },
    },
    now: () => env.clock.now,
    sleep: async (ms, signal) => { if (signal.aborted) return; env.clock.now += ms; await tick(); },
    visibility: {
      isHidden: () => hidden.value,
      waitUntilVisible: (signal) => new Promise<void>((r) => { if (!hidden.value || signal.aborted) return r(); hidden.resolvers.push(r); signal.addEventListener("abort", () => r(), { once: true }); }),
    },
    randomId: () => `new-key-${++keys}-aaaaaaaa`,
    onSettled: () => { calls.settled++; },
    onUnauthenticated: () => { calls.unauth++; },
  });
  c.attach();
  const until = async (pred: () => boolean, max = 5000) => { for (let i = 0; i < max && !pred(); i++) await tick(); return pred(); };
  return { c, calls, keysCreated: () => keys, until, settle: () => until(() => !c.busy) };
}
function env(over: Partial<Parameters<typeof page>[0]> = {}) {
  return { store: new MemoryStore(), clock: { now: T0 + 60_000 }, log: { posts: [] as string[], gets: [] as string[] }, ...over };
}
const stored = (e: ReturnType<typeof env>) => pr.loadPendingRequest(e.store, USER, e.clock.now);
const put = (e: ReturnType<typeof env>, p: PendingRequest) => pr.savePendingRequest(e.store, USER, p);
const active = (status = "PROCESSING", over: Partial<NonNullable<ActiveJobInput>> = {}): ActiveJobInput =>
  ({ id: JOB, status: status as never, prompt: "a cat", quality: "fast", ...over });
const atMostOneGeneration = (e: ReturnType<typeof env>, label: string) =>
  ok(new Set(e.log.posts).size <= 1 && e.log.posts.every((k) => k === KEY), `${label}: at most one generation (every POST used the original key)`);

try {
  section("Refresh during submission (no response yet)");
  {
    // The server already created the job (active, PENDING) — the stored request has no job id.
    const e = env({ get: (i) => (i === 0 ? job(200, "PROCESSING") : job(200, "COMPLETED")) });
    put(e, saved());
    const p = page(e);
    p.c.recover(active("PENDING"));
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.posts.length === 0, "active job matches the stored request → polled, NO POST");
    ok(stored(e) === null && p.calls.settled === 1, "stored request cleared only after confirmed completion");
    ok(p.keysCreated() === 0, "no key created during recovery");
  }
  {
    // The request had not reached job creation yet: no active job → replay with the original key.
    const e = env({ post: () => job(202, "PROCESSING"), get: () => job(200, "COMPLETED") });
    put(e, saved());
    const p = page(e);
    p.c.recover(null);
    await p.until(() => stored(e)?.jobId === JOB);
    const s1 = p.c.getState();
    ok(s1.phase === "polling" && s1.recovered === true, "replayed (recovered) → polling");
    ok(stored(e)?.key === KEY, "acknowledged job id stored under the SAME key");
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.posts.length === 1, "one replay POST → completed");
    atMostOneGeneration(e, "replay");
  }

  section("Refresh after a 202");
  {
    const e = env({ get: (i) => (i < 2 ? job(200, "PROCESSING") : job(200, "COMPLETED")) });
    put(e, saved({ jobId: JOB }));
    const p = page(e);
    p.c.recover(active());
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.posts.length === 0 && e.log.gets.length === 3, "active job = stored job id → polled to completion, no POST");
    ok(stored(e) === null, "cleared after completion");
  }
  {
    // The job finished while the page was closed: no active job, stored id → one GET shows the result.
    const e = env({ get: () => job(200, "COMPLETED") });
    put(e, saved({ jobId: JOB }));
    const p = page(e);
    p.c.recover(null);
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.gets.length === 1 && e.log.posts.length === 0, "stored job id, job already finished → result restored with one GET");
  }

  section("Refresh after completion / failure");
  {
    const e = env();
    const first = page({ ...e, post: () => job(201, "COMPLETED") });
    first.c.submit({ prompt: "a cat", quality: "fast" });
    await first.settle();
    first.c.detach();
    const reload = page(e);
    reload.c.recover(null);
    await reload.settle();
    ok(reload.c.getState().phase === "idle" && e.log.posts.length === 1 && e.log.gets.length === 0, "after completion: nothing stored → idle, no requests");
  }
  {
    const e = env();
    const first = page({ ...e, post: () => job(502, "FAILED", { error: { code: "GENERATION_FAILED", reason: "SERVICE_BUSY", message: "refunded", refunded: true } }) });
    first.c.submit({ prompt: "a cat", quality: "fast" });
    await first.settle();
    first.c.detach();
    const reload = page(e);
    reload.c.recover(null);
    await reload.settle();
    ok(reload.c.getState().phase === "idle" && e.log.posts.length === 1, "after failure/refund: nothing stored → idle, no new POST");
  }

  section("Active server job + a different saved request");
  {
    const e = env({ get: (i) => (i === 0 ? job(200, "PROCESSING", { prompt: "a dog" }) : job(200, "COMPLETED", { prompt: "a dog" })) });
    put(e, saved({ prompt: "a cat" })); // no job id, different prompt
    const p = page(e);
    p.c.recover(active("PROCESSING", { prompt: "a dog" }));
    const n = p.c.getNotice();
    ok(n?.kind === "held" && n.prompt === "a cat", "different saved prompt → HELD notice (preserved, explained)");
    ok(!p.c.submit({ prompt: "x", quality: "fast" }), "a new submit is refused while a request is held");
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.posts.length === 0, "the server's active job is followed to completion by polling only");
    ok(stored(e)?.key === KEY && stored(e)?.prompt === "a cat", "held request NOT cleared by the other job's completion");
    ok(!p.c.busy && !p.c.submit({ prompt: "something new", quality: "fast" }) && stored(e)?.key === KEY,
      "while idle, a new submit is still refused until the held request is resumed or discarded (its slot is never overwritten)");
    // User resumes it explicitly: replay with the ORIGINAL key.
    // From now on the server answers the replay with a completed job (default response).
    (e as { post?: unknown }).post = undefined;
    ok(p.c.resumeHeld(), "Resume it → accepted once nothing is running");
    await p.settle();
    ok(e.log.posts.length === 1 && e.log.posts[0] === KEY && p.c.getNotice() === null, "resume replays the held request with its original key");
    atMostOneGeneration(e, "held → resumed");
  }
  {
    const e = env({ get: (i, id) => (id === OTHER_JOB ? job(200, "COMPLETED", { id: OTHER_JOB }) : i === 0 ? job(200, "PROCESSING") : job(200, "COMPLETED")) });
    put(e, saved({ jobId: OTHER_JOB }));
    const p = page(e);
    p.c.recover(active());
    ok(p.c.getNotice()?.kind === "held", "saved job id ≠ active job → held");
    await p.settle();
    ok(p.c.resumeHeld(), "resume a held request with a job id…");
    await p.settle();
    ok(e.log.posts.length === 0 && e.log.gets.at(-1) === OTHER_JOB, "…polls that job (GET), never POSTs");
    ok(stored(e) === null, "cleared after its own job is confirmed");
  }
  {
    const e = env({ get: () => job(200, "COMPLETED", { prompt: "a dog" }) });
    put(e, saved({ prompt: "a cat" }));
    const p = page(e);
    p.c.recover(active("PROCESSING", { prompt: "a dog" }));
    await p.settle();
    p.c.discardHeld();
    ok(stored(e) === null && p.c.getNotice() === null && e.log.posts.length === 0, "Discard (explicit) removes the held request; nothing sent");
  }
  {
    const e = env({ get: () => job(200, "COMPLETED") });
    put(e, saved({ prompt: "a cat", startedAt: T0 - 60 * 60_000 }));
    const p = page(e);
    p.c.recover(active("PROCESSING", { prompt: "a dog" }));
    await p.settle();
    ok(p.c.resumeHeld() === false && p.c.getNotice()?.kind === "expired" && stored(e) === null && e.log.posts.length === 0,
      "resuming a held request that has since expired → expired notice, nothing sent");
  }

  section("Expired request");
  {
    const e = env();
    put(e, saved({ startedAt: T0 - 11 * 60_000 }));
    const p = page(e);
    p.c.recover(null);
    const n = p.c.getNotice();
    ok(n?.kind === "expired" && n.prompt === "a cat" && n.quality === "fast", "> 10 min, no job id → expired notice with the prompt (restorable)");
    ok(stored(e) === null && e.log.posts.length === 0 && e.log.gets.length === 0 && p.c.getState().phase === "idle", "removed; no request sent");
    p.c.dismissNotice();
    ok(p.c.getNotice() === null, "expired notice can be dismissed");
  }
  {
    const e = env();
    put(e, saved({ jobId: JOB, startedAt: T0 - 25 * 3_600_000 }));
    const p = page(e);
    p.c.recover(null);
    ok(p.c.getNotice()?.kind === "expired" && e.log.gets.length === 0, "stored job id older than 24 h → expired notice, no GET");
  }

  section("Multiple mounts and React Strict Mode");
  {
    const e = env({ post: () => job(201, "COMPLETED") });
    put(e, saved());
    const p = page(e);
    p.c.recover(null);
    p.c.recover(null);
    p.c.recover(active());
    await p.settle();
    ok(e.log.posts.length === 1, "recover() called three times → one replay POST");
    const gets = e.log.gets.length;
    p.c.recover(active());
    for (let i = 0; i < 20; i++) await tick();
    ok(e.log.posts.length === 1 && e.log.gets.length === gets && p.c.getState().phase === "completed",
      "recover() after recovery finished (idle) → no-op (later active jobs go through adoption)");
  }
  {
    // Strict Mode: mount → cleanup → mount with the real scheduler and manual timers.
    const e = env({ post: () => job(201, "COMPLETED") });
    put(e, saved());
    const p = page(e);
    const timers: { fn: () => void; cleared: boolean }[] = [];
    const t = { set: (fn: () => void) => { const h = { fn, cleared: false }; timers.push(h); return h; }, clear: (h: unknown) => { (h as { cleared: boolean }).cleared = true; } };
    const cleanup1 = startRecoveryOnMount(p.c, () => null, t);
    cleanup1(); // Strict Mode unmount
    startRecoveryOnMount(p.c, () => null, t); // remount
    timers.filter((h) => !h.cleared).forEach((h) => h.fn());
    await p.settle();
    ok(timers.length === 2 && timers[0].cleared && e.log.posts.length === 1, "Strict Mode mount/unmount/mount → recovery runs once, one POST");
    atMostOneGeneration(e, "strict mode");
  }
  {
    // Adoption is ignored before recovery ran (Strict Mode double effect on first render).
    const e = env({ get: () => job(200, "COMPLETED") });
    const p = page(e);
    ok(p.c.adoptActiveJob(active()) === false && e.log.gets.length === 0, "adoptActiveJob before recovery → ignored (recovery owns the first decision)");
    p.c.recover(active());
    ok(p.c.adoptActiveJob(active()) === false, "adopting the job already being polled → ignored (no duplicate loop)");
    await p.settle();
    ok(e.log.gets.length === 1, "exactly one polling loop");
  }
  {
    // Two tabs recovering the same stored request concurrently: same key both times.
    const e = env({ post: () => job(202, "PROCESSING"), get: () => job(200, "COMPLETED") });
    put(e, saved());
    const a = page(e), b = page(e);
    a.c.recover(null); b.c.recover(null);
    await a.settle(); await b.settle();
    ok(e.log.posts.length === 2 && e.log.posts.every((k) => k === KEY), "two tabs replay concurrently → both use the original key (server returns one job)");
  }
  {
    // Unmount during a recovered replay: browser request aborted, stored request kept; a later page continues.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const e = env({ post: async () => { await gate; return job(202, "PROCESSING"); }, get: () => job(200, "COMPLETED") });
    put(e, saved());
    const first = page(e);
    first.c.recover(null);
    await first.until(() => e.log.posts.length === 1);
    first.c.detach();
    release();
    for (let i = 0; i < 20; i++) await tick();
    ok(stored(e)?.key === KEY && first.c.getState().phase === "submitting", "unmount mid-replay: no state change, stored request kept (server work continues)");
    const second = page(e);
    second.c.recover(null);
    await second.settle();
    ok(second.c.getState().phase === "completed" && e.log.posts.every((k) => k === KEY), "next page replays the same key and completes");
  }

  section("Hidden / visible tab");
  {
    const hidden = { value: false, resolvers: [] as (() => void)[] };
    const e = env({ hidden, get: (i) => (i < 1 ? job(200, "PROCESSING") : job(200, "COMPLETED")) });
    put(e, saved({ jobId: JOB }));
    hidden.value = true;
    const p = page(e);
    p.c.recover(active());
    await p.until(() => e.log.gets.length === 1);
    for (let i = 0; i < 50; i++) await tick();
    ok(e.log.gets.length === 1 && p.c.getState().phase === "polling", "hidden while recovering → one poll, then paused");
    hidden.value = false; hidden.resolvers.splice(0).forEach((r) => r());
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.gets.length === 2, "visible → resumes immediately and completes");
  }
  {
    const e = env({ get: () => job(200, "PROCESSING") });
    put(e, saved({ jobId: JOB }));
    const p = page(e);
    p.c.recover(null);
    await p.settle();
    const s = p.c.getState();
    ok(s.phase === "stalled" && s.jobId === JOB, "still processing after 7 min → stalled");
    const before = e.log.gets.length;
    p.c.onVisible();
    await p.until(() => e.log.gets.length > before);
    ok(e.log.posts.length === 0 && e.log.gets.length > before, "tab visible again → stalled job re-checked (GET only)");
    p.c.detach();
  }
  {
    const e = env({ post: () => NET });
    put(e, saved());
    const p = page(e);
    p.c.recover(null);
    await p.settle();
    const posts = e.log.posts.length;
    p.c.onVisible();
    for (let i = 0; i < 20; i++) await tick();
    ok(p.c.getState().phase === "stalled" && e.log.posts.length === posts, "stalled WITHOUT a job id: visibility never triggers a POST");
    atMostOneGeneration(e, "stalled replay");
  }

  section("Network interruption during recovery + manual checks");
  {
    const e = env({ post: (i) => (i < 2 ? NET : job(202, "PROCESSING")), get: (i) => (i < 2 ? NET : job(200, "COMPLETED")) });
    put(e, saved());
    const p = page(e);
    p.c.recover(null);
    await p.until(() => { const s = p.c.getState(); return s.phase === "submitting" && s.checking; });
    ok(true, "recovery replay hits a network error → checking");
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.posts.length === 3, "replays (same key) until acknowledged, then polls through errors to completion");
    atMostOneGeneration(e, "network during recovery");
    ok(p.keysCreated() === 0, "no key created");
  }
  {
    // "Check now" ends the current wait early (GET happens without waiting out the backoff).
    const e = env({ get: (i) => (i === 0 ? job(200, "PROCESSING", { outcomeUnknown: true }, 30) : job(200, "COMPLETED")) });
    put(e, saved({ jobId: JOB }));
    const p = page(e);
    // Replace sleep with a real wait that only ends via checkNow / abort.
    (p.c as unknown as { deps: { sleep: (ms: number, s: AbortSignal) => Promise<void> } }).deps.sleep = (_ms, signal) =>
      new Promise<void>((r) => { signal.addEventListener("abort", () => r(), { once: true }); });
    p.c.recover(active());
    await p.until(() => e.log.gets.length === 1);
    for (let i = 0; i < 20; i++) await tick();
    ok(e.log.gets.length === 1 && p.c.getState().phase === "polling", "outcome unknown: waiting for the next poll");
    ok(p.c.checkNow(), "Check now accepted while busy");
    await p.settle();
    ok(e.log.gets.length === 2 && p.c.getState().phase === "completed" && e.log.posts.length === 0, "Check now → immediate GET → completed (no POST)");
  }
  {
    const e = env({ get: () => job(200, "PROCESSING") });
    put(e, saved({ jobId: JOB }));
    const p = page(e);
    p.c.recover(null);
    await p.settle();
    const posts = e.log.posts.length;
    ok(p.c.checkAgain() && e.log.posts.length === posts, "stalled → Check again (explicit) polls the job, no POST");
    p.c.detach();
  }

  section("Server is authoritative");
  {
    const e = env({ get: () => ({ kind: "error", httpStatus: 404, error: { code: "NOT_FOUND", message: "x", resetAt: null, jobId: null }, retryAfterSeconds: null }) as GenerationApiResult });
    put(e, saved({ jobId: "cjobNOTMINE000000000000001" }));
    const p = page(e);
    p.c.recover(null);
    await p.settle();
    ok(p.c.getState().phase === "error" && stored(e) === null && e.log.posts.length === 0, "stored job id the server doesn't return for this user → 404 → cleared, nothing sent");
  }
  {
    const e = env({ get: () => job(200, "COMPLETED") });
    const p = page(e);
    p.c.recover(null);
    p.c.adoptActiveJob(active());
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.posts.length === 0, "active job reported after a refresh (409 / other tab) → adopted by polling only");
  }
  {
    // After a 409 the stored request was cleared; adopting the other job must not touch a new stored request.
    const e = env({ post: () => err(409, "ACTIVE_JOB_EXISTS"), get: () => job(200, "COMPLETED") });
    const p = page(e);
    p.c.recover(null);
    p.c.submit({ prompt: "a cat", quality: "fast" });
    await p.settle();
    ok(p.c.getState().phase === "error" && stored(e) === null && p.calls.settled === 1, "409 → error, refresh requested, request cleared (no job was created)");
    p.c.adoptActiveJob(active("PROCESSING", { prompt: "a dog" }));
    await p.settle();
    ok(p.c.getState().phase === "completed" && e.log.posts.length === 1, "the other job is then followed by polling; still one POST in total");
  }

  ok(realNetworkAttempts === 0, "no real network request was attempted");
} catch (e) {
  fail++;
  console.error("UNCAUGHT", e);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
