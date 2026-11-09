// Stage 6 / B1 offline tests: client API parsing, pending-request persistence, polling and
// recovery decisions, and the Button component's rendered attributes.
//
// Fully offline: global fetch throws (the client functions use an injected fake), no database,
// no Cloudflare / Supabase. Run: npm run test:ui-logic
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let realNetworkAttempts = 0;
globalThis.fetch = (async () => {
  realNetworkAttempts++;
  throw new Error("Network access is forbidden in offline tests");
}) as typeof fetch;

const api = await import("@/features/generations/client/api");
const pr = await import("@/features/generations/client/pending-request");
const polling = await import("@/features/generations/client/polling");
const { Button } = await import("@/components/ui/button");
type GenerationApiResult = import("@/features/generations/client/api").GenerationApiResult;
type PendingRequest = import("@/features/generations/client/pending-request").PendingRequest;

// Compile-time contract: the new queries' rows must be accepted by toJobView (ImageJobRecord).
type Queries = typeof import("@/features/generations/queries");
type ImageJobRecord = import("@/features/generations/job-view").ImageJobRecord;
type ActiveRow = NonNullable<Awaited<ReturnType<Queries["getActiveImageJob"]>>>;
type RecentRow = Awaited<ReturnType<Queries["getRecentImageJobs"]>>[number];
const _activeFits: (r: ActiveRow) => ImageJobRecord = (r) => r;
const _recentFits: (r: RecentRow) => ImageJobRecord = (r) => r;
// @ts-expect-error — storage keys must never be part of the selected asset fields.
const _noStorageKey: RecentRow["assets"][number]["storageKey"] = "";
void _activeFits; void _recentFits; void _noStorageKey;

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const section = (s: string) => console.log(`\n# ${s}`);

const NOW = Date.parse("2026-11-10T08:00:00.000Z");
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const JOB = "cjob0000000000000000000001";
const USER = "cuser000000000000000000001";

const jobBody = (status: string, extra: Record<string, unknown> = {}) => ({
  job: { id: JOB, status, quality: "fast", prompt: "p", creditsCharged: status === "COMPLETED" ? 1 : 0, createdAt: "x", completedAt: null, outcomeUnknown: false, error: null },
  asset: status === "COMPLETED" ? { id: "asset-1", url: "/api/assets/asset-1", width: 1024, height: 1024, mimeType: "image/webp", sizeBytes: 1 } : null,
  replayed: false,
  balance: 99,
  ...extra,
});
const errBody = (code: string, extra: Record<string, unknown> = {}) => ({ error: { code, message: `server says ${code}`, ...extra } });
const jobResult = (status: string, retryAfterSeconds: number | null = 3): GenerationApiResult =>
  ({ kind: "job", httpStatus: 200, body: jobBody(status) as never, retryAfterSeconds });
const errResult = (httpStatus: number, code: string): GenerationApiResult =>
  ({ kind: "error", httpStatus, error: { code: code as never, message: "m", resetAt: null, jobId: null }, retryAfterSeconds: null });

class MemoryStore {
  map = new Map<string, string>();
  throwOn: "get" | "set" | "remove" | null = null;
  getItem(k: string) { if (this.throwOn === "get") throw new Error("denied"); return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.throwOn === "set") throw new Error("quota"); this.map.set(k, v); }
  removeItem(k: string) { if (this.throwOn === "remove") throw new Error("denied"); this.map.delete(k); }
}

try {
  // ===================================================================== API parsing
  section("API response parsing");
  {
    const created = api.parseApiResponse(201, null, JSON.stringify(jobBody("COMPLETED")));
    ok(created.kind === "job" && created.httpStatus === 201 && created.body.asset?.url === "/api/assets/asset-1", "201 with job body → job result");
    const failed = api.parseApiResponse(502, null, JSON.stringify({ ...jobBody("FAILED"), job: { ...jobBody("FAILED").job, error: { code: "GENERATION_FAILED", reason: "SERVICE_BUSY", message: "busy", refunded: true } } }));
    ok(failed.kind === "job" && failed.body.job.status === "FAILED" && failed.body.job.error?.refunded === true, "502 with job body → job result (failed + refunded), not an error");
    const pending = api.parseApiResponse(202, "3", JSON.stringify(jobBody("PROCESSING")));
    ok(pending.kind === "job" && pending.retryAfterSeconds === 3, "202 + Retry-After: 3 → job result with retryAfterSeconds 3");

    const limit = api.parseApiResponse(429, "3600", JSON.stringify(errBody("DAILY_LIMIT_REACHED", { resetAt: "2026-11-11T00:00:00.000Z" })));
    ok(limit.kind === "error" && limit.error.code === "DAILY_LIMIT_REACHED" && limit.error.resetAt === "2026-11-11T00:00:00.000Z" && limit.retryAfterSeconds === 3600,
      "429 DAILY_LIMIT_REACHED → code, resetAt and Retry-After parsed");
    const credits = api.parseApiResponse(402, null, JSON.stringify(errBody("INSUFFICIENT_CREDITS")));
    ok(credits.kind === "error" && credits.error.code === "INSUFFICIENT_CREDITS" && credits.error.message === "server says INSUFFICIENT_CREDITS", "402 → INSUFFICIENT_CREDITS with the server's message");
    const lost = api.parseApiResponse(500, null, JSON.stringify(errBody("INTERNAL_ERROR", { jobId: JOB })));
    ok(lost.kind === "error" && lost.error.jobId === JOB, "500 with jobId → jobId kept for recovery");
    const badJobId = api.parseApiResponse(500, null, JSON.stringify(errBody("INTERNAL_ERROR", { jobId: "../../x" })));
    ok(badJobId.kind === "error" && badJobId.error.jobId === null, "malformed jobId in an error is dropped");
    for (const code of ["ACTIVE_JOB_EXISTS", "IDEMPOTENCY_CONFLICT", "CAPACITY_EXHAUSTED", "SERVICE_UNAVAILABLE", "FORBIDDEN_ORIGIN", "INVALID_INPUT"]) {
      const r = api.parseApiResponse(400, null, JSON.stringify(errBody(code)));
      ok(r.kind === "error" && r.error.code === code, `error code ${code} recognised`);
    }
    const unknownCode = api.parseApiResponse(418, null, JSON.stringify(errBody("SOMETHING_NEW")));
    ok(unknownCode.kind === "error" && unknownCode.error.code === "UNKNOWN", "unrecognised code → UNKNOWN");
    const html = api.parseApiResponse(504, null, "<html>Gateway Timeout</html>");
    ok(html.kind === "error" && html.error.code === "UNKNOWN" && html.error.message === api.fallbackMessage("UNKNOWN"), "non-JSON proxy page → UNKNOWN with a safe fallback message");
    const proxy401 = api.parseApiResponse(401, null, "");
    const proxy404 = api.parseApiResponse(404, null, "not found");
    ok(proxy401.kind === "error" && proxy401.error.code === "UNAUTHENTICATED" && proxy404.kind === "error" && proxy404.error.code === "NOT_FOUND", "empty / non-contract 401 and 404 mapped by status");
    const longMsg = api.parseApiResponse(400, null, JSON.stringify({ error: { code: "INVALID_INPUT", message: "x".repeat(1000) } }));
    ok(longMsg.kind === "error" && longMsg.error.message.length === 300, "overlong server message truncated");
    const noMsg = api.parseApiResponse(503, null, JSON.stringify({ error: { code: "CAPACITY_EXHAUSTED" } }));
    ok(noMsg.kind === "error" && noMsg.error.message === api.fallbackMessage("CAPACITY_EXHAUSTED"), "missing message → local fallback");
    const evilAsset = api.parseApiResponse(201, null, JSON.stringify({ ...jobBody("COMPLETED"), asset: { id: "a", url: "https://evil.example/x.webp" } }));
    ok(evilAsset.kind !== "job", "asset URL outside /api/assets/ is rejected (never rendered)");
    const badStatus = api.parseApiResponse(200, null, JSON.stringify({ job: { id: JOB, status: "DONE" } }));
    ok(badStatus.kind === "error", "unknown job status → not treated as a job");
    ok(api.parseRetryAfter(" 5 ") === 5 && api.parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT") === null && api.parseRetryAfter(null) === null && api.parseRetryAfter("-1") === null,
      "Retry-After: delta seconds only");
  }

  section("API client (fake fetch)");
  {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (respond: () => Response | Promise<Response>) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(); };
    const r = await api.postImageGeneration({ prompt: "a cat", quality: "fast", idempotencyKey: KEY },
      { fetchImpl: fakeFetch(() => new Response(JSON.stringify(jobBody("COMPLETED")), { status: 201 })) });
    const sent = calls[0];
    const headers = new Headers(sent.init.headers);
    ok(r.kind === "job" && sent.url === "/api/generations/image" && sent.init.method === "POST", "POST to /api/generations/image");
    ok(headers.get("idempotency-key") === KEY && headers.get("content-type") === "application/json", "sends the caller's Idempotency-Key and JSON content type");
    ok(sent.init.body === JSON.stringify({ prompt: "a cat", quality: "fast" }), "body contains only prompt and quality (no user id)");
    ok(sent.init.credentials === "same-origin" && sent.init.cache === "no-store", "same-origin credentials, no-store");

    const net = await api.postImageGeneration({ prompt: "a cat", quality: "fast", idempotencyKey: KEY }, { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    ok(net.kind === "network" && net.idempotencyKey === KEY, "network failure → kind 'network' and the SAME key is returned");
    const cut = await api.postImageGeneration({ prompt: "a cat", quality: "fast", idempotencyKey: KEY }, {
      fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.error(new Error("reset")); } }), { status: 201 }),
    });
    ok(cut.kind === "network" && cut.idempotencyKey === KEY, "body cut off after headers → 'network' (outcome unknown), key kept");
    const ac = new AbortController(); ac.abort();
    const aborted = await api.postImageGeneration({ prompt: "a cat", quality: "fast", idempotencyKey: KEY }, {
      signal: ac.signal, fetchImpl: async (_u, init) => { if (init.signal?.aborted) throw new DOMException("aborted", "AbortError"); return new Response(""); },
    });
    ok(aborted.kind === "aborted", "caller abort → kind 'aborted'");

    calls.length = 0;
    const g = await api.getGenerationJob(JOB, { fetchImpl: fakeFetch(() => new Response(JSON.stringify(jobBody("PROCESSING")), { status: 200, headers: { "Retry-After": "3" } })) });
    ok(g.kind === "job" && g.retryAfterSeconds === 3 && calls[0].url === `/api/generations/${JOB}` && calls[0].init.method === "GET", "GET /api/generations/{id} parsed with Retry-After");
    calls.length = 0;
    const bad = await api.getGenerationJob("../../etc/passwd", { fetchImpl: fakeFetch(() => new Response("")) });
    ok(bad.kind === "error" && bad.error.code === "NOT_FOUND" && calls.length === 0, "malformed job id → NOT_FOUND without any request");
  }

  // ===================================================================== pending request
  section("Pending request persistence");
  {
    ok(pr.pendingStorageKey(USER) === `yourai:image:pending:${USER}`, "user-scoped storage key");
    let threw = false; try { pr.pendingStorageKey("../other"); } catch { threw = true; }
    ok(threw, "invalid user id rejected for the storage key");

    const created = pr.createPendingRequest({ prompt: "a cat", quality: "fast" }, { now: NOW, randomId: () => KEY });
    ok(created.key === KEY && created.startedAt === NOW && created.jobId === undefined && created.v === 1, "createPendingRequest: key, startedAt, no jobId");
    let badKey = false; try { pr.createPendingRequest({ prompt: "x", quality: "fast" }, { randomId: () => "bad key!" }); } catch { badKey = true; }
    ok(badKey, "an invalid generated key is refused");
    const real = pr.createPendingRequest({ prompt: "x", quality: "detailed" });
    ok(/^[0-9a-f-]{36}$/.test(real.key), "default key is a UUID (accepted by the server's key format)");

    const withJob = pr.withJobId(created, JOB);
    ok(withJob.jobId === JOB && withJob.key === KEY && created.jobId === undefined, "withJobId adds the job id, keeps the key, does not mutate");
    ok(pr.withJobId(created, "bad id!") === created, "withJobId ignores a malformed job id");

    const store = new MemoryStore();
    ok(pr.savePendingRequest(store, USER, withJob), "save → true");
    const loaded = pr.loadPendingRequest(store, USER, NOW);
    ok(JSON.stringify(loaded) === JSON.stringify(withJob), "round trip preserves key, prompt, quality, startedAt, jobId");
    ok(pr.loadPendingRequest(store, "cuser000000000000000000002", NOW) === null, "another user's entry is not visible");

    const invalid: [string, unknown][] = [
      ["not JSON", "{oops"],
      ["array", []],
      ["wrong version", { ...withJob, v: 2 }],
      ["bad key", { ...withJob, key: "short" }],
      ["empty prompt", { ...withJob, prompt: "   " }],
      ["2049-char prompt", { ...withJob, prompt: "x".repeat(2049) }],
      ["unknown quality", { ...withJob, quality: "ultra" }],
      ["string startedAt", { ...withJob, startedAt: "yesterday" }],
      ["startedAt far in the future", { ...withJob, startedAt: NOW + 5 * 60_000 }],
      ["malformed jobId", { ...withJob, jobId: "../x" }],
    ];
    for (const [label, value] of invalid) {
      store.map.set(pr.pendingStorageKey(USER), typeof value === "string" ? value : JSON.stringify(value));
      const r = pr.loadPendingRequest(store, USER, NOW);
      ok(r === null && !store.map.has(pr.pendingStorageKey(USER)), `invalid stored data (${label}) → ignored and removed`);
    }
    store.map.set(pr.pendingStorageKey(USER), JSON.stringify({ ...created, startedAt: NOW + 30_000 }));
    ok(pr.loadPendingRequest(store, USER, NOW) !== null, "small clock skew (30 s) tolerated");

    pr.clearPendingRequest(store, USER);
    ok(!store.map.has(pr.pendingStorageKey(USER)), "clear removes the entry");
    store.throwOn = "get";
    ok(pr.loadPendingRequest(store, USER, NOW) === null, "storage read error → null (no crash)");
    store.throwOn = "set";
    ok(pr.savePendingRequest(store, USER, created) === false, "storage write error (quota / privacy mode) → false (no crash)");
    store.throwOn = "remove";
    pr.clearPendingRequest(store, USER);
    ok(true, "storage remove error swallowed");
    ok(pr.loadPendingRequest(null, USER, NOW) === null && pr.savePendingRequest(null, USER, created) === false, "no storage available → graceful no-op");
    ok(pr.browserStore() === null, "browserStore() is null outside a browser");
  }

  // ===================================================================== polling decisions
  section("Polling decisions");
  {
    const base = { pollStartedAt: NOW, now: NOW + 10_000, consecutiveFailures: 0, hidden: false };
    for (const s of ["COMPLETED", "FAILED", "CANCELLED"]) {
      const d = polling.decideNextPoll({ ...base, result: jobResult(s) });
      ok(d.action === "stop" && d.reason === "terminal", `${s} → stop (terminal)`);
    }
    for (const s of ["PENDING", "PROCESSING"]) {
      const d = polling.decideNextPoll({ ...base, result: jobResult(s, 3) });
      ok(d.action === "wait" && d.delayMs === 3_000, `${s} + Retry-After 3 → wait 3 s`);
    }
    const noHeader = polling.decideNextPoll({ ...base, result: jobResult("PROCESSING", null) });
    ok(noHeader.action === "wait" && noHeader.delayMs === 3_000, "no Retry-After → default 3 s");
    const tiny = polling.decideNextPoll({ ...base, result: jobResult("PROCESSING", 0) });
    const huge = polling.decideNextPoll({ ...base, result: jobResult("PROCESSING", 600) });
    ok(tiny.action === "wait" && tiny.delayMs === 1_000 && huge.action === "wait" && huge.delayMs === 30_000, "Retry-After clamped to 1–30 s");

    ok(polling.backoffDelayMs(1) === 3_000 && polling.backoffDelayMs(2) === 6_000 && polling.backoffDelayMs(3) === 12_000 &&
      polling.backoffDelayMs(4) === 30_000 && polling.backoffDelayMs(9) === 30_000 && polling.backoffDelayMs(0) === 3_000, "backoff: 3, 6, 12, then 30 s max");
    const seq = [1, 2, 3, 4, 5].map((n) => polling.decideNextPoll({ ...base, consecutiveFailures: n, result: { kind: "network", idempotencyKey: null } }));
    ok(JSON.stringify(seq.map((d) => (d.action === "wait" ? d.delayMs : -1))) === JSON.stringify([3000, 6000, 12000, 30000, 30000]), "consecutive network failures follow the backoff");
    const s5 = polling.decideNextPoll({ ...base, consecutiveFailures: 2, result: errResult(503, "SERVICE_UNAVAILABLE") });
    const s500 = polling.decideNextPoll({ ...base, consecutiveFailures: 1, result: errResult(500, "INTERNAL_ERROR") });
    ok(s5.action === "wait" && s5.delayMs === 6_000 && s500.action === "wait" && s500.delayMs === 3_000, "5xx → backoff (keeps polling)");

    const nf = polling.decideNextPoll({ ...base, result: errResult(404, "NOT_FOUND") });
    const ua = polling.decideNextPoll({ ...base, result: errResult(401, "UNAUTHENTICATED") });
    const bad = polling.decideNextPoll({ ...base, result: errResult(400, "INVALID_INPUT") });
    ok(nf.action === "stop" && nf.reason === "not-found", "404 → stop (not-found)");
    ok(ua.action === "stop" && ua.reason === "unauthenticated", "401 → stop (unauthenticated)");
    ok(bad.action === "stop" && bad.reason === "fatal", "other 4xx → stop (fatal)");
    const ab = polling.decideNextPoll({ ...base, result: { kind: "aborted" } });
    ok(ab.action === "stop" && ab.reason === "aborted", "aborted → stop");

    const late = polling.decideNextPoll({ ...base, now: NOW + 7 * 60_000, result: jobResult("PROCESSING") });
    const justBefore = polling.decideNextPoll({ ...base, now: NOW + 7 * 60_000 - 1, result: jobResult("PROCESSING") });
    ok(late.action === "stop" && late.reason === "timeout" && justBefore.action === "wait", "stops at exactly 7 minutes");
    const lateDone = polling.decideNextPoll({ ...base, now: NOW + 9 * 60_000, result: jobResult("COMPLETED") });
    ok(lateDone.action === "stop" && lateDone.reason === "terminal", "a terminal result after 7 min still reports terminal");

    const hidden = polling.decideNextPoll({ ...base, hidden: true, result: jobResult("PROCESSING") });
    const hiddenDone = polling.decideNextPoll({ ...base, hidden: true, result: jobResult("COMPLETED") });
    ok(hidden.action === "pause" && hiddenDone.action === "stop", "hidden tab → pause (terminal still stops)");
    ok(polling.isPollFailure({ kind: "network", idempotencyKey: null }) && polling.isPollFailure(errResult(503, "SERVICE_UNAVAILABLE")) && !polling.isPollFailure(jobResult("PROCESSING")),
      "isPollFailure classifies results");
  }

  // ===================================================================== recovery decisions
  section("Recovery decisions");
  {
    const pending: PendingRequest = { v: 1, key: KEY, prompt: "a cat", quality: "fast", startedAt: NOW - 60_000 };
    const withJob: PendingRequest = { ...pending, jobId: JOB };

    const active = polling.decideRecovery({ activeJob: { id: "cjobACTIVE00000000000000", status: "PROCESSING" }, pending: withJob, now: NOW });
    ok(active.action === "poll" && active.jobId === "cjobACTIVE00000000000000" && active.source === "active-job", "server-reported active job wins → poll it");
    const activeNoStorage = polling.decideRecovery({ activeJob: { id: JOB, status: "PENDING" }, pending: null, now: NOW });
    ok(activeNoStorage.action === "poll" && activeNoStorage.source === "active-job", "active job recovered even with localStorage cleared");
    const activeTerminal = polling.decideRecovery({ activeJob: { id: JOB, status: "COMPLETED" }, pending: null, now: NOW });
    ok(activeTerminal.action === "none", "a finished 'active' job is not polled");

    const known = polling.decideRecovery({ activeJob: null, pending: withJob, now: NOW });
    ok(known.action === "poll" && known.jobId === JOB && known.source === "pending", "stored job id → poll (no POST)");
    const knownOld = polling.decideRecovery({ activeJob: null, pending: { ...withJob, startedAt: NOW - 25 * 3_600_000 }, now: NOW });
    ok(knownOld.action === "discard", "stored job id older than 24 h → discard");

    const replay = polling.decideRecovery({ activeJob: null, pending, now: NOW });
    ok(replay.action === "replay" && replay.request.key === KEY && replay.request.prompt === "a cat" && replay.request.quality === "fast",
      "no job id, 1 min old → replay with the ORIGINAL key, prompt and quality");
    const edge = polling.decideRecovery({ activeJob: null, pending: { ...pending, startedAt: NOW - 10 * 60_000 + 1 }, now: NOW });
    const expired = polling.decideRecovery({ activeJob: null, pending: { ...pending, startedAt: NOW - 10 * 60_000 }, now: NOW });
    ok(edge.action === "replay" && expired.action === "discard" && expired.reason === "expired", "replay only while < 10 minutes old; at 10 min → discard");
    ok(polling.decideRecovery({ activeJob: null, pending: null, now: NOW }).action === "none", "nothing stored → none");

    ok(polling.shouldClearPendingOnTerminal(withJob, JOB) && polling.shouldClearPendingOnTerminal(pending, JOB) && !polling.shouldClearPendingOnTerminal(withJob, "cjobOTHER00000000000000") &&
      !polling.shouldClearPendingOnTerminal(null, JOB), "pending cleared only for its own job (or when its job id was never learned)");
  }

  section("Idempotency preservation (end-to-end through storage)");
  {
    // Submit → network loss → reload → recovery replays the SAME key; no new key is ever made.
    const store = new MemoryStore();
    let generated = 0;
    const submit = pr.createPendingRequest({ prompt: "a lighthouse", quality: "detailed" }, { now: NOW, randomId: () => { generated++; return KEY; } });
    pr.savePendingRequest(store, USER, submit);
    const sentKeys: string[] = [];
    const first = await api.postImageGeneration({ prompt: submit.prompt, quality: submit.quality, idempotencyKey: submit.key },
      { fetchImpl: async (_u, init) => { sentKeys.push(new Headers(init.headers).get("idempotency-key")!); throw new TypeError("offline"); } });
    ok(first.kind === "network", "first attempt lost on the network");

    const restored = pr.loadPendingRequest(store, USER, NOW + 2 * 60_000);
    const decision = polling.decideRecovery({ activeJob: null, pending: restored, now: NOW + 2 * 60_000 });
    ok(decision.action === "replay", "after reload: replay");
    if (decision.action === "replay") {
      const again = await api.postImageGeneration({ prompt: decision.request.prompt, quality: decision.request.quality, idempotencyKey: decision.request.key },
        { fetchImpl: async (_u, init) => { sentKeys.push(new Headers(init.headers).get("idempotency-key")!); return new Response(JSON.stringify(jobBody("PROCESSING", { replayed: true })), { status: 202, headers: { "Retry-After": "3" } }); } });
      ok(again.kind === "job" && again.body.job.id === JOB, "replay returns the job");
      if (again.kind === "job") pr.savePendingRequest(store, USER, pr.withJobId(decision.request, again.body.job.id));
    }
    ok(sentKeys.length === 2 && sentKeys.every((k) => k === KEY) && generated === 1, "both attempts used the same key; only one key was ever generated");
    const afterAck = polling.decideRecovery({ activeJob: null, pending: pr.loadPendingRequest(store, USER, NOW + 3 * 60_000), now: NOW + 3 * 60_000 });
    ok(afterAck.action === "poll" && afterAck.jobId === JOB, "once acknowledged, later recoveries poll instead of replaying");
  }

  // ===================================================================== Button
  section("Button component");
  {
    const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
    // The disabled ATTRIBUTE (class names also contain "disabled:" variants).
    const isDisabled = (markup: string) => / disabled=""/.test(markup);
    const plain = html(createElement(Button, null, "Generate"));
    ok(/^<button type="button"/.test(plain) && plain.includes("Generate") && !isDisabled(plain), "default: type=button, enabled, renders children");
    const submit = html(createElement(Button, { type: "submit", "aria-label": "Generate image", "aria-describedby": "cost" }, "Go"));
    ok(submit.includes('type="submit"') && submit.includes('aria-label="Generate image"') && submit.includes('aria-describedby="cost"'), "type and aria attributes passed through");
    const loading = html(createElement(Button, { loading: true, loadingLabel: "Generating…" }, "Generate"));
    ok(!isDisabled(loading) && loading.includes('aria-disabled="true"') && loading.includes('aria-busy="true"') && loading.includes("Generating…") && !loading.includes(">Generate<") && loading.includes("animate-spin"),
      "loading: aria-disabled + aria-busy (NOT native disabled, so focus is kept), spinner, loading label replaces children");
    const loadingNoLabel = html(createElement(Button, { loading: true }, "Generate"));
    ok(loadingNoLabel.includes("Generate") && loadingNoLabel.includes('aria-disabled="true"'), "loading without a label keeps the children");
    // Activation is blocked while loading (the click handler prevents the default form submit).
    let clicks = 0; let prevented = 0;
    const fakeEvent = { preventDefault: () => { prevented++; } };
    const loadingEl = Button({ loading: true, onClick: () => { clicks++; }, children: "Go" }) as { props: { onClick: (e: unknown) => void } };
    loadingEl.props.onClick(fakeEvent);
    const idleEl = Button({ onClick: () => { clicks++; }, children: "Go" }) as { props: { onClick: (e: unknown) => void } };
    idleEl.props.onClick(fakeEvent);
    ok(prevented === 1 && clicks === 1, "loading blocks activation (default prevented, onClick not called); idle button calls onClick");
    const disabled = html(createElement(Button, { disabled: true }, "x"));
    ok(isDisabled(disabled) && !disabled.includes("aria-busy"), "disabled without aria-busy");
    const secondary = html(createElement(Button, { variant: "secondary", size: "lg", className: "w-full" }, "x"));
    ok(secondary.includes("ring-white/10") && secondary.includes("h-12") && secondary.includes("w-full"), "variants, sizes and className applied");
  }

  ok(realNetworkAttempts === 0, "no real network request was attempted");
} catch (e) {
  fail++;
  console.error("UNCAUGHT", e);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
