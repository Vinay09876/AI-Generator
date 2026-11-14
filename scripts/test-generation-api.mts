// Stage 5 offline tests: orchestrator (runImageGeneration) + HTTP handlers + helpers.
//
// Fully offline: NO network and NO database. Global fetch throws, credentials and database
// URLs are removed from the environment, and lifecycle.ts / prisma are never imported.
// The Stage 3 lifecycle is replaced by an in-memory model with the same guarded-transition
// semantics; the same scenarios run against the REAL lifecycle in
// scripts/test-generation-integration.mts (requires TEST_DATABASE_URL).
// Image processing uses the real sharp library.
//
// Run: npm run test:api   (uses --conditions=react-server so server-only modules load)
import { readFileSync } from "node:fs";
import sharp from "sharp";

for (const k of ["DATABASE_URL", "TEST_DATABASE_URL", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_STORAGE_BUCKET", "APP_ORIGIN", "AUTH_URL"]) {
  delete process.env[k];
}
let realNetworkAttempts = 0;
globalThis.fetch = (async () => {
  realNetworkAttempts++;
  throw new Error("Network access is forbidden in offline tests");
}) as typeof fetch;

const { runImageGeneration, FAILURE_REASONS } = await import("@/features/generations/generate-image");
const { createGenerationHandlers, nextUtcMidnight } = await import("@/features/generations/http");
const { toJobView, failureReasonFor, jobResponseStatus } = await import("@/features/generations/job-view");
const { resolveTrustedOrigins, isTrustedOrigin, readJsonBody } = await import("@/lib/api");
const { validateImageRequest } = await import("@/features/generations/validation");
const { AccountingError, GenerationUnavailableError } = await import("@/features/generations/errors");
const { ProviderError } = await import("@/features/generations/providers/types");
const { StorageError } = await import("@/features/generations/storage/types");
const { getSignedAssetUrl } = await import("@/features/generations/assets");
const { convertProviderImageToWebp } = await import("@/features/generations/image-processing");
const config = await import("@/features/generations/config");
type GenerationLifecycle = import("@/features/generations/generate-image").GenerationLifecycle;
type GenerationDeps = import("@/features/generations/generate-image").GenerationDeps;
type ImageProvider = import("@/features/generations/providers/types").ImageProvider;
type ProviderResult = import("@/features/generations/providers/types").ProviderResult;
type ObjectStorage = import("@/features/generations/storage/types").ObjectStorage;
type ImageJobRecord = import("@/features/generations/job-view").ImageJobRecord;

const keepAlive = setInterval(() => {}, 1_000);
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const section = (s: string) => console.log(`\n# ${s}`);
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------------------
// In-memory model of the Stage 3 lifecycle (same guards as lifecycle.ts / neuron-budget.ts)
// ---------------------------------------------------------------------------------------
type Status = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
type Job = {
  id: string; userId: string; status: Status; prompt: string; settings: { quality: string; steps: number; credits: number; reservedCentiNeurons: number };
  idempotencyKey: string; estimatedCredits: number; chargedCredits: number; errorMessage: string | null;
  createdAt: Date; startedAt: Date | null; completedAt: Date | null;
};
type Reservation = { status: "RESERVED" | "CONSUMED" | "RELEASED"; reserved: number; actual: number | null };
type Asset = { id: string; userId: string; jobId: string; storageKey: string; width: number; height: number; mimeType: string; fileSize: bigint; createdAt: Date };

class JobNotCompletableError extends Error { constructor() { super("Job is no longer completable."); this.name = "JobNotCompletableError"; } }

function createFakeDb() {
  const db = {
    now: new Date("2026-11-09T10:00:00.000Z"),
    users: new Map<string, { balance: number; initial: number }>(),
    jobs: new Map<string, Job>(),
    reservations: new Map<string, Reservation>(),
    ledger: [] as { type: "DEBIT" | "REFUND"; userId: string; jobId: string; amount: number }[],
    assets: new Map<string, Asset>(),
    budget: { limit: config.DAILY_NEURON_LIMIT_CENTI, reserved: 0, consumed: 0 },
    calls: {} as Record<string, number>,
    /** Fault injection: throw before an operation runs. */
    faults: {} as Partial<Record<keyof GenerationLifecycle, () => void>>,
    /** completeImageJobWithAsset commits, then throws (lost COMMIT acknowledgement). */
    throwAfterCommit: false,
    seq: 0,
    locks: new Map<string, Promise<unknown>>(),
  };
  const count = (n: string) => { db.calls[n] = (db.calls[n] ?? 0) + 1; };
  const fault = (n: keyof GenerationLifecycle) => { count(n); db.faults[n]?.(); };
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);

  function consume(jobId: string, actual: number | null) {
    const r = db.reservations.get(jobId);
    if (!r || r.status !== "RESERVED") return false;
    const amount = actual ?? r.reserved;
    db.budget.reserved -= r.reserved; db.budget.consumed += amount;
    r.status = "CONSUMED"; r.actual = amount;
    return true;
  }
  function release(jobId: string) {
    const r = db.reservations.get(jobId);
    if (!r || r.status !== "RESERVED") return false;
    db.budget.reserved -= r.reserved; r.status = "RELEASED";
    return true;
  }
  function refund(jobId: string) {
    if (db.ledger.some((l) => l.type === "REFUND" && l.jobId === jobId)) return false;
    const debit = db.ledger.find((l) => l.type === "DEBIT" && l.jobId === jobId);
    if (!debit) return false;
    db.ledger.push({ type: "REFUND", userId: debit.userId, jobId, amount: -debit.amount });
    db.users.get(debit.userId)!.balance += -debit.amount;
    return true;
  }
  async function settleFailed(jobId: string, reason: string, mode: "release" | "consume", from: Status[]) {
    await tick();
    const job = db.jobs.get(jobId);
    if (!job || !from.includes(job.status)) return { settled: false };
    job.status = "FAILED"; job.errorMessage = reason; job.completedAt = db.now;
    if (mode === "release") release(jobId); else consume(jobId, null);
    refund(jobId);
    return { settled: true };
  }
  async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = db.locks.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    db.locks.set(userId, run.catch(() => {}));
    return run;
  }

  const lifecycle: GenerationLifecycle = {
    async reconcileStaleJobs({ userId, limit = 50 } = {}) {
      fault("reconcileStaleJobs");
      await tick();
      let settled = 0;
      const all = [...db.jobs.values()].filter((j) => !userId || j.userId === userId);
      const pending = all.filter((j) => j.status === "PENDING" && db.now.getTime() - j.createdAt.getTime() > config.PENDING_STALE_MS).slice(0, limit);
      const processing = all.filter((j) => j.status === "PROCESSING" && j.startedAt && db.now.getTime() - j.startedAt.getTime() > config.PROCESSING_STALE_MS).slice(0, limit);
      for (const j of pending) if ((await settleFailed(j.id, "Generation did not start in time", "release", ["PENDING"])).settled) settled++;
      for (const j of processing) if ((await settleFailed(j.id, "Generation timed out", "consume", ["PROCESSING"])).settled) settled++;
      return { settled };
    },
    async createImageJob(input) {
      fault("createImageJob");
      const { prompt, quality, idempotencyKey } = validateImageRequest(input);
      const tier = config.IMAGE_QUALITIES[quality];
      return withUserLock(input.userId, async () => {
        await tick();
        const user = db.users.get(input.userId);
        if (!user) throw new AccountingError("USER_NOT_FOUND");
        const existing = [...db.jobs.values()].find((j) => j.userId === input.userId && j.idempotencyKey === idempotencyKey);
        if (existing) {
          if (existing.prompt !== prompt || existing.settings.quality !== quality) throw new AccountingError("IDEMPOTENCY_CONFLICT");
          return { job: { ...existing }, replayed: true };
        }
        const today = dayKey(db.now);
        const used = [...db.jobs.values()].filter((j) => j.userId === input.userId && dayKey(j.createdAt) === today &&
          ["RESERVED", "CONSUMED"].includes(db.reservations.get(j.id)?.status ?? "")).length;
        if (used >= config.DAILY_USER_IMAGE_LIMIT) throw new AccountingError("DAILY_LIMIT_REACHED");
        if ([...db.jobs.values()].some((j) => j.userId === input.userId && (j.status === "PENDING" || j.status === "PROCESSING"))) {
          throw new AccountingError("ACTIVE_JOB_EXISTS");
        }
        if (user.balance < tier.credits) throw new AccountingError("INSUFFICIENT_CREDITS");
        if (db.budget.reserved + db.budget.consumed + tier.reservedCentiNeurons > db.budget.limit) throw new AccountingError("CAPACITY_EXHAUSTED");
        const id = `cjob${String(++db.seq).padStart(21, "0")}`;
        const job: Job = {
          id, userId: input.userId, status: "PENDING", prompt,
          settings: { quality, steps: tier.steps, credits: tier.credits, reservedCentiNeurons: tier.reservedCentiNeurons },
          idempotencyKey, estimatedCredits: tier.credits, chargedCredits: 0, errorMessage: null,
          createdAt: db.now, startedAt: null, completedAt: null,
        };
        db.jobs.set(id, job);
        user.balance -= tier.credits;
        db.ledger.push({ type: "DEBIT", userId: input.userId, jobId: id, amount: -tier.credits });
        db.reservations.set(id, { status: "RESERVED", reserved: tier.reservedCentiNeurons, actual: null });
        db.budget.reserved += tier.reservedCentiNeurons;
        return { job: { ...job }, replayed: false };
      });
    },
    async markJobStarted(jobId) {
      fault("markJobStarted"); await tick();
      const j = db.jobs.get(jobId);
      if (j?.status !== "PENDING") return false;
      j.status = "PROCESSING"; j.startedAt = db.now;
      return true;
    },
    async recordProviderSuccess(jobId, actual) {
      fault("recordProviderSuccess"); await tick();
      if (db.jobs.get(jobId)?.status !== "PROCESSING") return false;
      return consume(jobId, actual);
    },
    async completeImageJobWithAsset(jobId, asset) {
      fault("completeImageJobWithAsset"); await tick();
      const j = db.jobs.get(jobId);
      if (!j || j.status !== "PROCESSING" || db.reservations.get(jobId)?.status !== "CONSUMED") throw new JobNotCompletableError();
      if (j.userId !== asset.userId) throw new JobNotCompletableError();
      j.status = "COMPLETED"; j.chargedCredits = j.estimatedCredits; j.completedAt = db.now;
      db.assets.set(asset.assetId, { id: asset.assetId, userId: asset.userId, jobId, storageKey: asset.storageKey, width: asset.width, height: asset.height, mimeType: asset.mimeType, fileSize: BigInt(asset.sizeBytes), createdAt: db.now });
      if (db.throwAfterCommit) throw new Error("connection reset after commit");
      return { jobId, assetId: asset.assetId };
    },
    async imageAssetExists(jobId, assetId) {
      fault("imageAssetExists"); await tick();
      return db.assets.get(assetId)?.jobId === jobId;
    },
    async failJobProviderNotRun(jobId, reason) { fault("failJobProviderNotRun"); return settleFailed(jobId, reason, "release", ["PENDING", "PROCESSING"]); },
    async failJobAfterProviderSuccess(jobId, reason) { fault("failJobAfterProviderSuccess"); return settleFailed(jobId, reason, "consume", ["PROCESSING"]); },
    async markProviderOutcomeUnknown(jobId, reason) {
      fault("markProviderOutcomeUnknown"); await tick();
      const j = db.jobs.get(jobId);
      if (j?.status !== "PROCESSING") return false;
      j.errorMessage = `${config.AWAITING_RECONCILIATION_PREFIX}${reason}`;
      return true;
    },
  };

  let userSeq = 0;
  const newUser = (balance = 100) => {
    const id = `cuser${String(++userSeq).padStart(20, "0")}`;
    db.users.set(id, { balance, initial: balance });
    return id;
  };
  const loadJob = async (userId: string, jobId: string): Promise<ImageJobRecord | null> => {
    const j = db.jobs.get(jobId);
    if (!j || j.userId !== userId) return null;
    return {
      id: j.id, status: j.status, prompt: j.prompt, settings: j.settings, chargedCredits: j.chargedCredits,
      errorMessage: j.errorMessage, createdAt: j.createdAt, completedAt: j.completedAt,
      assets: [...db.assets.values()].filter((a) => a.jobId === j.id && a.userId === userId)
        .map((a) => ({ id: a.id, width: a.width, height: a.height, mimeType: a.mimeType, fileSize: a.fileSize })),
    };
  };
  return { db, lifecycle, newUser, loadJob };
}

// ---------------------------------------------------------------------------------------
// Fakes: provider, storage, logger
// ---------------------------------------------------------------------------------------
const jpeg1024 = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 30, g: 60, b: 120 } } })
  .composite([{ input: Buffer.from(`<svg width="1024" height="1024"><circle cx="512" cy="512" r="300" fill="#f0abfc"/></svg>`) }])
  .jpeg({ quality: 90 }).toBuffer();
const png1024 = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } }).png().toBuffer();

type ProviderBehaviour = (req: { prompt: string; steps: number; signal?: AbortSignal }) => Promise<ProviderResult>;
const success = (centi: number | null = 17_280, bytes = jpeg1024): ProviderBehaviour => async () => ({
  bytes, usage: centi === null ? { centiNeurons: null, source: "missing" } : { centiNeurons: centi, source: "header" },
  provider: "fake", model: config.IMAGE_MODEL, providerRequestId: "req-1", latencyMs: 5,
});
const failing = (p: ConstructorParameters<typeof ProviderError>[0]): ProviderBehaviour => async () => { throw new ProviderError(p); };

function fakeProvider(behaviour: ProviderBehaviour) {
  const requests: { prompt: string; steps: number; signal?: AbortSignal }[] = [];
  const provider: ImageProvider & { behaviour: ProviderBehaviour } = {
    id: "fake", model: config.IMAGE_MODEL, behaviour,
    async generate(req) { requests.push(req); return provider.behaviour(req); },
  };
  return { provider, requests };
}

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const s = {
    objects,
    failPut: false, failDelete: false, failSign: false,
    onPut: null as null | (() => Promise<void>),
    deletes: [] as string[],
    async put(key: string, body: Buffer, o: { contentType: string; maxBytes: number }) {
      if (s.failPut) throw new StorageError("UPLOAD_FAILED", "upload failed (fake)");
      if (objects.has(key)) throw new StorageError("ALREADY_EXISTS", "exists");
      if (body.length > o.maxBytes || o.contentType !== "image/webp") throw new StorageError("TOO_LARGE", "bad");
      objects.set(key, body);
      if (s.onPut) await s.onPut();
    },
    async createSignedUrl(key: string, ttl: number) {
      if (s.failSign) throw new StorageError("SIGN_FAILED", "sign failed (fake)");
      return `https://storage.invalid/sign/${key}?token=t&ttl=${ttl}`;
    },
    async delete(key: string) {
      s.deletes.push(key);
      if (s.failDelete) throw new StorageError("DELETE_FAILED", "delete failed (fake)");
      objects.delete(key);
    },
  };
  return s satisfies ObjectStorage & Record<string, unknown>;
}

function capturingLog() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string, d?: Record<string, unknown>) => lines.push(`INFO ${m} ${JSON.stringify(d ?? {})}`),
    error: (m: string, d?: Record<string, unknown>) => lines.push(`ERROR ${m} ${JSON.stringify(d ?? {})}`),
  };
}

function harness(behaviour: ProviderBehaviour = success()) {
  const fake = createFakeDb();
  const prov = fakeProvider(behaviour);
  const storage = memoryStorage();
  const log = capturingLog();
  let providerResolutions = 0;
  const deps: GenerationDeps = {
    lifecycle: fake.lifecycle,
    getProvider: () => { providerResolutions++; return prov.provider; },
    getStorage: () => storage,
    convertImage: (b) => convertProviderImageToWebp(b),
    log,
  };
  const run = (userId: string, prompt: unknown, quality: unknown, key: unknown) =>
    runImageGeneration({ userId, prompt, quality, idempotencyKey: key }, deps);
  const tryRun = (userId: string, prompt: unknown, quality: unknown, key: unknown) =>
    run(userId, prompt, quality, key).then((r) => ({ ok: true as const, ...r }), (e: Error) => ({ ok: false as const, name: e.name, code: (e as { code?: string }).code }));
  return { ...fake, prov, storage, log, deps, run, tryRun, providerResolutions: () => providerResolutions };
}
type Harness = ReturnType<typeof harness>;

const PROMPT = "A secret-ish prompt about a lighthouse at dawn";
let keySeq = 0;
const key = () => `key_${Date.now()}_${++keySeq}`;
const deferred = <T = void,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

/** Accounting invariants over the whole fake database. */
function checkInvariants(h: Harness, label: string) {
  const problems: string[] = [];
  for (const [userId, u] of h.db.users) {
    const net = h.db.ledger.filter((l) => l.userId === userId).reduce((s, l) => s + l.amount, 0);
    if (u.balance !== u.initial + net) problems.push(`wallet != ledger for ${userId}`);
    if (u.balance < 0) problems.push(`negative balance ${userId}`);
  }
  for (const j of h.db.jobs.values()) {
    const debits = h.db.ledger.filter((l) => l.jobId === j.id && l.type === "DEBIT").length;
    const refunds = h.db.ledger.filter((l) => l.jobId === j.id && l.type === "REFUND").length;
    const r = h.db.reservations.get(j.id)!;
    const assets = [...h.db.assets.values()].filter((a) => a.jobId === j.id);
    if (debits !== 1) problems.push(`${j.id} debits=${debits}`);
    if (refunds > 1) problems.push(`${j.id} refunds=${refunds}`);
    if (j.status === "COMPLETED") {
      if (refunds !== 0 || r.status !== "CONSUMED" || assets.length !== 1 || j.chargedCredits !== j.estimatedCredits) problems.push(`${j.id} bad COMPLETED`);
      if (assets[0] && !h.storage.objects.has(assets[0].storageKey)) problems.push(`${j.id} asset object missing`);
    }
    if (j.status === "FAILED" && (refunds !== 1 || r.status === "RESERVED" || assets.length !== 0 || j.chargedCredits !== 0)) problems.push(`${j.id} bad FAILED`);
    if ((j.status === "PENDING" || j.status === "PROCESSING") && (refunds !== 0 || r.status === "RELEASED")) problems.push(`${j.id} bad active`);
  }
  // Every stored object belongs to a COMPLETED job's asset row (no orphans unless delete failed).
  const keys = new Set([...h.db.assets.values()].map((a) => a.storageKey));
  for (const k of h.storage.objects.keys()) if (!keys.has(k)) problems.push(`orphan object ${k.slice(0, 40)}`);
  const reserved = [...h.db.reservations.values()].filter((r) => r.status === "RESERVED").reduce((s, r) => s + r.reserved, 0);
  const consumed = [...h.db.reservations.values()].filter((r) => r.status === "CONSUMED").reduce((s, r) => s + (r.actual ?? 0), 0);
  if (reserved !== h.db.budget.reserved || consumed !== h.db.budget.consumed) problems.push("budget totals mismatch");
  ok(problems.length === 0, `invariants hold: ${label}${problems.length ? ` → ${problems.join("; ")}` : ""}`);
}
const job = (h: Harness, id: string) => h.db.jobs.get(id)!;
const res = (h: Harness, id: string) => h.db.reservations.get(id)!;
const refunds = (h: Harness, id: string) => h.db.ledger.filter((l) => l.jobId === id && l.type === "REFUND").length;

try {
  // ===================================================================== config consistency
  section("Timeout / threshold consistency");
  {
    ok(config.PROVIDER_TIMEOUT_MS < config.GENERATION_REQUEST_MAX_DURATION_S * 1000, "provider timeout (60 s) < request max duration (90 s)");
    ok(config.GENERATION_REQUEST_MAX_DURATION_S * 1000 < config.PROCESSING_STALE_MS, "request max duration (90 s) < PROCESSING reconciliation threshold (5 min)");
    ok(config.PROVIDER_TIMEOUT_MS === 60_000 && config.PROCESSING_STALE_MS === 5 * 60_000, "approved values kept: 60 s provider timeout, 5 min reconciliation");
    const route = readFileSync("src/app/api/generations/image/route.ts", "utf8");
    const m = /export const maxDuration = (\d+);/.exec(route);
    ok(m !== null && Number(m[1]) === config.GENERATION_REQUEST_MAX_DURATION_S, "route maxDuration literal matches GENERATION_REQUEST_MAX_DURATION_S");
    ok(/export const runtime = "nodejs"/.test(route), "generation route uses the Node.js runtime (sharp)");
  }

  // ===================================================================== static safety checks
  section("Static safety checks");
  {
    const orch = readFileSync("src/features/generations/generate-image.ts", "utf8");
    ok(!/signal\s*:/.test(orch.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "orchestrator never passes an abort signal to the provider");
    ok(!/\$transaction/.test(orch), "orchestrator opens no database transaction (provider is never inside one)");
    ok(!/debitWallet|refundJobDebit|reserveNeuronsForJob|consumeReservation|releaseReservation/.test(orch), "orchestrator has no direct debit/refund/reservation logic");
    const service = readFileSync("src/features/generations/service.ts", "utf8");
    ok(service.startsWith('import "server-only";'), "service wiring is server-only");
    for (const f of ["src/app/api/generations/image/route.ts", "src/app/api/generations/[jobId]/route.ts", "src/app/api/assets/[assetId]/route.ts"]) {
      const src = readFileSync(f, "utf8");
      ok(!/process\.env/.test(src) && /generationHandlers\./.test(src), `${f.split("/api/")[1]}: delegates to handlers, reads no env`);
    }
    const api = readFileSync("src/lib/api.ts", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    ok(!/headers\.get\(["'](host|x-forwarded-[a-z]+|forwarded)["']\)/i.test(api), "origin check never reads Host / X-Forwarded-* headers");
  }

  // ===================================================================== helpers
  section("Trusted origin resolution");
  {
    ok(JSON.stringify(resolveTrustedOrigins({ APP_ORIGIN: "https://pixora.example, https://www.pixora.example/", NODE_ENV: "production" })) ===
      JSON.stringify(["https://pixora.example", "https://www.pixora.example"]), "APP_ORIGIN list parsed and normalised to origins");
    ok(resolveTrustedOrigins({ AUTH_URL: "https://auth.example/api/auth", NODE_ENV: "production" })[0] === "https://auth.example", "AUTH_URL origin trusted");
    ok(resolveTrustedOrigins({ APP_ORIGIN: "not a url, ftp://x.example", NODE_ENV: "production" }).length === 0, "invalid / non-http entries ignored");
    ok(resolveTrustedOrigins({ NODE_ENV: "production" }).length === 0, "production with nothing configured: empty list (fail closed)");
    ok(resolveTrustedOrigins({ NODE_ENV: "development" }).includes("http://localhost:3000"), "development fallback: localhost:3000");
    const trusted = ["https://pixora.example"];
    const req = (h: Record<string, string>) => new Request("https://pixora.example/api/generations/image", { method: "POST", headers: h });
    ok(isTrustedOrigin(req({ origin: "https://pixora.example" }), trusted), "matching Origin accepted");
    ok(!isTrustedOrigin(req({}), trusted), "missing Origin rejected");
    ok(!isTrustedOrigin(req({ origin: "null" }), trusted), "Origin: null rejected");
    ok(!isTrustedOrigin(req({ origin: "https://evil.example", host: "evil.example", "x-forwarded-host": "evil.example" }), trusted), "spoofed Host / X-Forwarded-Host do not make a foreign Origin trusted");
    ok(!isTrustedOrigin(req({ origin: "https://pixora.example", "sec-fetch-site": "cross-site" }), trusted), "Sec-Fetch-Site: cross-site rejected");
    ok(!isTrustedOrigin(req({ origin: "https://pixora.example.evil.example" }), trusted), "suffix-lookalike origin rejected (exact match)");
  }

  section("JSON body reader");
  {
    const mk = (body: BodyInit | null, h: Record<string, string> = { "content-type": "application/json" }) => new Request("http://x/", { method: "POST", body, headers: h });
    ok((await readJsonBody(mk('{"a":1}'), 100)).ok, "valid JSON accepted");
    ok((await readJsonBody(mk('{"a":1}', { "content-type": "text/plain" }), 100)).ok === false, "non-JSON content type rejected");
    const big = await readJsonBody(mk(JSON.stringify({ a: "x".repeat(200) })), 100);
    ok(!big.ok && big.reason === "TOO_LARGE", "oversized body rejected (content-length)");
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(50))); c.close(); } });
    const streamed = await readJsonBody(new Request("http://x/", { method: "POST", body: stream, headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit), 100);
    ok(!streamed.ok && streamed.reason === "TOO_LARGE", "oversized streamed body (no content-length) rejected while reading");
    const bad = await readJsonBody(mk("{oops"), 100);
    ok(!bad.ok && bad.reason === "INVALID_JSON", "invalid JSON rejected");
    const badUtf8 = await readJsonBody(mk(new Uint8Array([0x22, 0xff, 0x22])), 100);
    ok(!badUtf8.ok, "invalid UTF-8 rejected");
  }

  section("Job view mapping");
  {
    ok(failureReasonFor("provider_not_run:QUOTA_EXHAUSTED") === "SERVICE_BUSY" && failureReasonFor("provider_not_run:RATE_LIMITED") === "SERVICE_BUSY", "quota / rate limit → SERVICE_BUSY");
    ok(failureReasonFor("provider_not_run:INVALID_REQUEST") === "PROMPT_REJECTED", "provider validation rejection → PROMPT_REJECTED");
    ok(failureReasonFor("Generation timed out") === "TIMED_OUT" && failureReasonFor("Generation did not start in time") === "TIMED_OUT", "reconciliation reasons → TIMED_OUT");
    ok(failureReasonFor("storage_failed:UPLOAD_FAILED") === "FAILED" && failureReasonFor(null) === "FAILED", "other reasons → FAILED");
    ok(jobResponseStatus("COMPLETED", "created") === 201 && jobResponseStatus("FAILED", "created") === 502 &&
      jobResponseStatus("PROCESSING", "created") === 202 && jobResponseStatus("PENDING", "replayed") === 202 &&
      jobResponseStatus("COMPLETED", "replayed") === 200 && jobResponseStatus("FAILED", "replayed") === 200 &&
      jobResponseStatus("PROCESSING", "fetched") === 200, "status contract: 201 / 502 / 202 / 200");
    const view = toJobView({ id: "j1", status: "FAILED", prompt: "p", settings: { quality: "fast", steps: 4 }, chargedCredits: 0,
      errorMessage: "provider_ran:MALFORMED_RESPONSE", createdAt: new Date(0), completedAt: new Date(0), assets: [] });
    const text = JSON.stringify(view);
    ok(view.job.error?.refunded === true && !text.includes("MALFORMED") && !text.includes("provider_ran") && !text.includes("steps"),
      "failed view: user-safe message, no internal reason code or settings leaked");
    const done = toJobView({ id: "j2", status: "COMPLETED", prompt: "p", settings: { quality: "detailed" }, chargedCredits: 2, errorMessage: null,
      createdAt: new Date(0), completedAt: new Date(0), assets: [{ id: "a-1", width: 1024, height: 1024, mimeType: "image/webp", fileSize: BigInt(1234) }] });
    ok(done.asset?.url === "/api/assets/a-1" && done.asset.sizeBytes === 1234 && done.job.quality === "detailed", "completed view: stable asset URL, numeric size");
    ok(nextUtcMidnight(new Date("2026-11-09T23:59:59Z")).toISOString() === "2026-11-10T00:00:00.000Z", "resetAt = next 00:00 UTC");
  }

  // ===================================================================== orchestrator
  section("Orchestrator — success paths");
  {
    const h = harness(success(17_000));
    const u = h.newUser();
    const r = await h.run(u, `  ${PROMPT}  `, "fast", key());
    const j = job(h, r.jobId);
    ok(r.outcome === "completed" && !r.replayed && j.status === "COMPLETED", "fast: job COMPLETED");
    ok(h.prov.requests.length === 1 && h.prov.requests[0].steps === 4 && h.prov.requests[0].prompt === PROMPT, "provider called once with trimmed prompt and 4 steps");
    ok(h.prov.requests[0].signal === undefined, "no abort signal passed to the provider");
    ok(res(h, r.jobId).status === "CONSUMED" && res(h, r.jobId).actual === 17_000, "actual usage from provider recorded (17,000, not the 17,280 reservation)");
    const asset = [...h.db.assets.values()].find((a) => a.jobId === r.jobId);
    ok(!!asset && asset.mimeType === "image/webp" && asset.width === 1024 && asset.height === 1024 && asset.userId === u, "asset row: WebP 1024×1024 owned by the user");
    ok(!!asset && asset.storageKey === `users/${u}/images/${r.jobId}/${asset.id}.webp` && h.storage.objects.has(asset.storageKey), "object stored under the user's prefix");
    const stored = asset ? h.storage.objects.get(asset.storageKey)! : Buffer.alloc(0);
    ok(stored.subarray(0, 4).toString() === "RIFF" && stored.subarray(8, 12).toString() === "WEBP" && Number(asset?.fileSize) === stored.length, "stored bytes are WebP and size matches the row");
    ok(h.db.users.get(u)!.balance === 99 && j.chargedCredits === 1 && refunds(h, r.jobId) === 0, "1 credit charged, no refund");
    ok(h.db.calls.completeImageJobWithAsset === 1 && (h.db.calls.failJobAfterProviderSuccess ?? 0) === 0, "completed through completeImageJobWithAsset only");
    ok(!h.log.lines.join("\n").includes(PROMPT.slice(0, 20)), "logs never contain the prompt");
    checkInvariants(h, "success");
  }
  {
    const h = harness(success(null));
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "detailed", key());
    ok(r.outcome === "completed" && h.prov.requests[0].steps === 8, "detailed: 8 steps, completed");
    ok(res(h, r.jobId).actual === 32_640 && h.db.users.get(u)!.balance === 98, "missing usage header → reserved 32,640 charged (conservative); 2 credits");
    checkInvariants(h, "missing usage");
  }

  section("Orchestrator — provider failures");
  {
    const h = harness(failing({ code: "QUOTA_EXHAUSTED", outcome: "not_run", message: "429", httpStatus: 429, providerCode: 3036 }));
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "failed" && job(h, r.jobId).status === "FAILED" && job(h, r.jobId).errorMessage === FAILURE_REASONS.providerNotRun("QUOTA_EXHAUSTED"), "not_run → FAILED via failJobProviderNotRun");
    ok(res(h, r.jobId).status === "RELEASED" && refunds(h, r.jobId) === 1 && h.db.users.get(u)!.balance === 100, "not_run: Neurons released, credit refunded once");
    ok(h.storage.objects.size === 0, "not_run: nothing uploaded");
    // RELEASED jobs do not count toward the daily limit: 10 more not_run failures, then a success still allowed.
    for (let i = 0; i < 10; i++) await h.run(u, PROMPT, "fast", key());
    h.prov.provider.behaviour = success();
    const after = await h.tryRun(u, PROMPT, "fast", key());
    ok(after.ok && after.outcome === "completed", "11 released failures do not exhaust the daily limit");
    checkInvariants(h, "not_run");
  }
  {
    const h = harness(failing({ code: "MALFORMED_RESPONSE", outcome: "ran", message: "bad", httpStatus: 200, usage: { centiNeurons: 17_100, source: "header" } }));
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "failed" && res(h, r.jobId).status === "CONSUMED" && res(h, r.jobId).actual === 17_100, "ran + reported usage → actual usage consumed");
    ok(refunds(h, r.jobId) === 1 && job(h, r.jobId).errorMessage === FAILURE_REASONS.providerRan("MALFORMED_RESPONSE"), "ran: refunded once, reason recorded");
    checkInvariants(h, "ran with usage");
  }
  {
    const h = harness(failing({ code: "MALFORMED_RESPONSE", outcome: "ran", message: "bad", httpStatus: 200 }));
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(res(h, r.jobId).status === "CONSUMED" && res(h, r.jobId).actual === 17_280 && refunds(h, r.jobId) === 1, "ran without usage → reserved amount consumed, refunded");
    // CONSUMED jobs count toward the daily limit.
    for (let i = 0; i < 9; i++) await h.run(u, PROMPT, "fast", key());
    const eleventh = await h.tryRun(u, PROMPT, "fast", key());
    ok(!eleventh.ok && eleventh.code === "DAILY_LIMIT_REACHED", "10 'ran' failures count → 11th request DAILY_LIMIT_REACHED");
    checkInvariants(h, "ran without usage");
  }
  {
    const h = harness(failing({ code: "TIMEOUT", outcome: "unknown", message: "timeout" }));
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    const j = job(h, r.jobId);
    ok(r.outcome === "pending" && j.status === "PROCESSING" && res(h, r.jobId).status === "RESERVED" && refunds(h, r.jobId) === 0, "unknown → stays PROCESSING, RESERVED, no refund");
    ok(j.errorMessage === `${config.AWAITING_RECONCILIATION_PREFIX}${FAILURE_REASONS.providerUnknown("TIMEOUT")}`, "unknown: awaiting-reconciliation marker set");
    const blocked = await h.tryRun(u, PROMPT, "fast", key());
    ok(!blocked.ok && blocked.code === "ACTIVE_JOB_EXISTS", "slot stays held while the outcome is unknown");
    h.db.now = new Date(h.db.now.getTime() + 4 * 60_000);
    await h.lifecycle.reconcileStaleJobs({});
    ok(job(h, r.jobId).status === "PROCESSING", "not settled before 5 minutes");
    h.db.now = new Date(h.db.now.getTime() + 61_000);
    await h.lifecycle.reconcileStaleJobs({});
    await h.lifecycle.reconcileStaleJobs({});
    ok(job(h, r.jobId).status === "FAILED" && res(h, r.jobId).actual === 17_280 && refunds(h, r.jobId) === 1, "after 5 min: settled once (reserved consumed, refunded once) despite repeated reconciliation");
    checkInvariants(h, "unknown + reconcile");
  }
  {
    const h = harness(async () => { throw new TypeError("boom"); });
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "pending" && job(h, r.jobId).status === "PROCESSING" && refunds(h, r.jobId) === 0, "unexpected (non-provider) exception → treated as unknown, no refund");
    checkInvariants(h, "unexpected exception");
  }

  section("Orchestrator — failures after provider success");
  {
    const h = harness(success(17_280, png1024));
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "failed" && job(h, r.jobId).errorMessage === FAILURE_REASONS.imageInvalid("UNSUPPORTED_FORMAT"), "non-JPEG output → FAILED (image_invalid)");
    ok(res(h, r.jobId).status === "CONSUMED" && refunds(h, r.jobId) === 1 && h.storage.objects.size === 0, "usage kept, refunded once, nothing uploaded");
    checkInvariants(h, "conversion failure");
  }
  {
    const h = harness();
    h.storage.failPut = true;
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "failed" && job(h, r.jobId).errorMessage === FAILURE_REASONS.storage("UPLOAD_FAILED") && refunds(h, r.jobId) === 1, "upload failure → FAILED, refunded once");
    ok((h.db.calls.completeImageJobWithAsset ?? 0) === 0, "no completion attempted after a failed upload");
    checkInvariants(h, "upload failure");
  }
  {
    const h = harness();
    h.db.faults.completeImageJobWithAsset = () => { throw new Error("db down"); };
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "failed" && job(h, r.jobId).errorMessage === FAILURE_REASONS.assetRecord && refunds(h, r.jobId) === 1, "asset DB write failure → FAILED, refunded once");
    ok(h.storage.objects.size === 0 && h.storage.deletes.length === 1, "uploaded object deleted after the DB write failed");
    checkInvariants(h, "db write failure");
  }
  {
    const h = harness();
    h.db.throwAfterCommit = true;
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "completed" && job(h, r.jobId).status === "COMPLETED" && h.storage.objects.size === 1 && h.storage.deletes.length === 0,
      "ambiguous commit (row exists) → treated as completed, object kept");
    checkInvariants(h, "ambiguous commit");
  }
  {
    const h = harness();
    h.db.faults.completeImageJobWithAsset = () => { throw new Error("db down"); };
    h.storage.failDelete = true;
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "failed" && refunds(h, r.jobId) === 1, "DB write + cleanup both fail → still FAILED and refunded once");
    ok(h.log.lines.some((l) => l.includes("orphaned storage object")) && !h.log.lines.join("\n").includes("users/"), "orchestrator logs the orphan by job id (the asset layer logs the key once for manual cleanup)");
  }

  section("Orchestrator — races with reconciliation");
  {
    // Reconciliation wins while the upload is in progress.
    const h = harness();
    const u = h.newUser();
    h.storage.onPut = async () => {
      h.db.now = new Date(h.db.now.getTime() + 6 * 60_000);
      await h.lifecycle.reconcileStaleJobs({});
    };
    const r = await h.run(u, PROMPT, "fast", key());
    const j = job(h, r.jobId);
    ok(r.outcome === "superseded" && j.status === "FAILED" && j.errorMessage === "Generation timed out", "cleanup won during upload → actual settled state (FAILED by reconciliation)");
    ok(h.storage.objects.size === 0 && h.storage.deletes.length === 1, "uploaded object deleted");
    ok(refunds(h, r.jobId) === 1 && res(h, r.jobId).status === "CONSUMED" && res(h, r.jobId).actual === 17_280, "single refund; recorded usage kept");
    ok((h.db.calls.failJobAfterProviderSuccess ?? 0) === 0, "orchestrator did not attempt a second settlement");
    ok([...h.db.assets.values()].length === 0, "no asset row for a FAILED job");
    checkInvariants(h, "reconcile during upload");
  }
  {
    // Late provider response: reconciliation settles the job while the provider runs.
    let h!: Harness;
    h = harness(async () => {
      h.db.now = new Date(h.db.now.getTime() + 6 * 60_000);
      await h.lifecycle.reconcileStaleJobs({});
      return success()({ prompt: "", steps: 4 });
    });
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "superseded" && job(h, r.jobId).status === "FAILED", "late provider response → job keeps reconciliation's FAILED state");
    ok(h.storage.objects.size === 0 && h.storage.deletes.length === 0 && (h.db.calls.completeImageJobWithAsset ?? 0) === 0, "late image discarded: nothing uploaded");
    ok(refunds(h, r.jobId) === 1 && res(h, r.jobId).actual === 17_280, "exactly one settlement (conservative) and one refund");
    checkInvariants(h, "late provider response");
  }
  {
    // Reconciliation settles a PENDING job before it starts.
    const h = harness();
    const u = h.newUser();
    const real = h.lifecycle.markJobStarted;
    h.deps.lifecycle = { ...h.lifecycle, markJobStarted: async (id) => {
      h.db.now = new Date(h.db.now.getTime() + 3 * 60_000);
      await h.lifecycle.reconcileStaleJobs({});
      return real(id);
    } };
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "superseded" && h.prov.requests.length === 0, "markJobStarted false → provider never called");
    ok(res(h, r.jobId).status === "RELEASED" && refunds(h, r.jobId) === 1, "stale PENDING released and refunded once");
    checkInvariants(h, "settled before start");
  }

  section("Orchestrator — idempotency");
  {
    const h = harness();
    const u = h.newUser();
    const k = key();
    const first = await h.run(u, PROMPT, "fast", k);
    const again = await h.run(u, PROMPT, "fast", k);
    ok(again.replayed && again.outcome === "replayed" && again.jobId === first.jobId, "replay after completion returns the same job");
    ok(h.prov.requests.length === 1 && h.db.ledger.filter((l) => l.type === "DEBIT").length === 1 && h.db.reservations.size === 1,
      "replay: no second provider call, debit or reservation");
    const conflict = await h.tryRun(u, `${PROMPT}!`, "fast", k);
    const conflictQ = await h.tryRun(u, PROMPT, "detailed", k);
    ok(!conflict.ok && conflict.code === "IDEMPOTENCY_CONFLICT" && !conflictQ.ok && conflictQ.code === "IDEMPOTENCY_CONFLICT", "same key, different prompt or quality → IDEMPOTENCY_CONFLICT");
    checkInvariants(h, "replay after completion");
  }
  {
    const h = harness(failing({ code: "AUTH", outcome: "not_run", message: "401", httpStatus: 401 }));
    const u = h.newUser();
    const k = key();
    const first = await h.run(u, PROMPT, "fast", k);
    h.prov.provider.behaviour = success();
    const again = await h.run(u, PROMPT, "fast", k);
    ok(again.replayed && job(h, first.jobId).status === "FAILED" && h.prov.requests.length === 1 && refunds(h, first.jobId) === 1,
      "replay after failure: returns the FAILED job, provider not re-run, no second refund");
  }
  {
    const h = harness();
    const gate = deferred();
    const inside = deferred();
    h.prov.provider.behaviour = async (req) => { inside.resolve(); await gate.promise; return success()(req); };
    const u = h.newUser();
    const k = key();
    const first = h.run(u, PROMPT, "fast", k);
    await inside.promise;
    const replay = await h.run(u, PROMPT, "fast", k);
    ok(replay.replayed && job(h, replay.jobId).status === "PROCESSING", "replay while in flight → returns the in-progress job immediately");
    gate.resolve();
    const done = await first;
    ok(done.jobId === replay.jobId && h.prov.requests.length === 1 && job(h, done.jobId).status === "COMPLETED", "in-flight replay never triggers a second provider call");
    checkInvariants(h, "in-flight replay");
  }
  {
    const h = harness();
    const u = h.newUser();
    const k = key();
    const results = await Promise.all([h.tryRun(u, PROMPT, "fast", k), h.tryRun(u, PROMPT, "fast", k), h.tryRun(u, PROMPT, "fast", k)]);
    const created = results.filter((r) => r.ok && !r.replayed).length;
    const replayed = results.filter((r) => r.ok && r.replayed).length;
    ok(created === 1 && replayed === 2 && h.prov.requests.length === 1 && h.db.ledger.filter((l) => l.type === "DEBIT").length === 1,
      "3 concurrent requests, same key → 1 job, 1 provider call, 1 debit");
    checkInvariants(h, "concurrent same key");
  }
  {
    const h = harness();
    const u = h.newUser();
    const results = await Promise.all([h.tryRun(u, PROMPT, "fast", key()), h.tryRun(u, PROMPT, "fast", key())]);
    ok(results.filter((r) => r.ok).length === 1 && results.some((r) => !r.ok && r.code === "ACTIVE_JOB_EXISTS"), "2 concurrent requests, different keys → one ACTIVE_JOB_EXISTS");
    ok(h.prov.requests.length === 1, "only one provider call");
    checkInvariants(h, "concurrent different keys");
  }

  section("Orchestrator — rejected before a job exists");
  {
    const h = harness();
    const u = h.newUser();
    for (const [label, p, q, k] of [["empty prompt", "  ", "fast", key()], ["2049-char prompt", "x".repeat(2049), "fast", key()], ["bad quality", PROMPT, "ultra", key()], ["bad key", PROMPT, "fast", "short"]] as const) {
      const r = await h.tryRun(u, p, q, k);
      ok(!r.ok && r.code === "INVALID_INPUT", `invalid input (${label}) → INVALID_INPUT`);
    }
    ok(h.providerResolutions() === 0 && h.db.jobs.size === 0, "invalid input: provider not even resolved, no job");
  }
  {
    const h = harness();
    h.deps.getProvider = () => { throw new ProviderError({ code: "CONFIG", outcome: "not_run", message: "Missing environment variables: X." }); };
    const u = h.newUser();
    const r = await h.tryRun(u, PROMPT, "fast", key());
    ok(!r.ok && r.name === "GenerationUnavailableError" && h.db.jobs.size === 0 && h.db.users.get(u)!.balance === 100, "provider not configured → GenerationUnavailableError, nothing charged");
    h.deps.getProvider = () => h.prov.provider;
    h.deps.getStorage = () => { throw new StorageError("CONFIG", "missing"); };
    const s = await h.tryRun(u, PROMPT, "fast", key());
    ok(!s.ok && s.name === "GenerationUnavailableError" && h.db.jobs.size === 0, "storage not configured → GenerationUnavailableError, nothing charged");
  }
  {
    const h = harness();
    const poor = h.newUser(1);
    const r = await h.tryRun(poor, PROMPT, "detailed", key());
    ok(!r.ok && r.code === "INSUFFICIENT_CREDITS" && h.prov.requests.length === 0, "insufficient credits → INSUFFICIENT_CREDITS, provider not called");
    h.db.budget.limit = 10_000;
    const u = h.newUser();
    const c = await h.tryRun(u, PROMPT, "fast", key());
    ok(!c.ok && c.code === "CAPACITY_EXHAUSTED" && h.prov.requests.length === 0, "budget exhausted → CAPACITY_EXHAUSTED, provider not called");
  }
  {
    const h = harness();
    h.db.faults.reconcileStaleJobs = () => { throw new Error("db hiccup"); };
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "completed", "pre-request user reconciliation failure does not block generation");
  }
  {
    // A settlement call itself fails (DB down) → job left for reconciliation, still settled exactly once later.
    const h = harness(failing({ code: "RATE_LIMITED", outcome: "not_run", message: "429", httpStatus: 429 }));
    h.db.faults.failJobProviderNotRun = () => { throw new Error("db down"); };
    const u = h.newUser();
    const r = await h.run(u, PROMPT, "fast", key());
    ok(r.outcome === "pending" && job(h, r.jobId).status === "PROCESSING" && refunds(h, r.jobId) === 0, "settlement failure → job left PROCESSING (no premature refund)");
    h.db.now = new Date(h.db.now.getTime() + 6 * 60_000);
    await h.lifecycle.reconcileStaleJobs({});
    ok(job(h, r.jobId).status === "FAILED" && refunds(h, r.jobId) === 1, "reconciliation later settles it exactly once");
    checkInvariants(h, "settlement failure");
  }

  // ===================================================================== HTTP handlers
  section("HTTP — POST /api/generations/image");
  const ORIGIN = "https://pixora.example";
  function httpHarness(behaviour?: ProviderBehaviour) {
    const h = harness(behaviour);
    let session: string | null = null;
    const scheduled: (() => Promise<unknown>)[] = [];
    const extra = { loadFails: false, generateThrows: null as Error | null };
    const handlers = createGenerationHandlers({
      getUserId: async () => session,
      trustedOrigins: () => [ORIGIN],
      generate: (input) => (extra.generateThrows ? Promise.reject(extra.generateThrows) : runImageGeneration(input, h.deps)),
      loadJob: async (u, j) => { if (extra.loadFails) throw new Error("db"); return h.loadJob(u, j); },
      loadBalance: async (u) => h.db.users.get(u)?.balance ?? null,
      reconcileForUser: (u) => h.lifecycle.reconcileStaleJobs({ userId: u, limit: 5 }),
      scheduleBackground: (t) => { scheduled.push(t); },
      reconcileGlobal: () => h.lifecycle.reconcileStaleJobs({ limit: 10 }),
      signAssetUrl: (u, a) => getSignedAssetUrl({ userId: u, assetId: a, storage: h.storage,
        findAsset: async ({ assetId, userId }) => { const x = h.db.assets.get(assetId); return x && x.userId === userId ? { storageKey: x.storageKey } : null; } }),
      log: { error: () => {} },
    });
    const post = (body: unknown, opts: { key?: string | null; origin?: string | null; type?: string; raw?: string } = {}) => {
      const headers: Record<string, string> = { "content-type": opts.type ?? "application/json" };
      if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
      if (opts.key !== null) headers["idempotency-key"] = opts.key ?? key();
      return handlers.postImage(new Request(`${ORIGIN}/api/generations/image`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }));
    };
    return { ...h, handlers, post, scheduled, extra, login: (u: string | null) => { session = u; } };
  }
  const read = async (r: Response) => ({ status: r.status, headers: r.headers, text: await r.text() });
  const body = (t: { text: string }) => JSON.parse(t.text);
  {
    const h = httpHarness();
    const u = h.newUser();
    h.login(null);
    const noAuth = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(noAuth.status === 401 && body(noAuth).error.code === "UNAUTHENTICATED" && h.db.jobs.size === 0 && h.scheduled.length === 0, "unauthenticated → 401, no job, no background work");
    h.login(u);
    const foreign = await read(await h.post({ prompt: PROMPT, quality: "fast" }, { origin: "https://evil.example" }));
    const noOrigin = await read(await h.post({ prompt: PROMPT, quality: "fast" }, { origin: null }));
    ok(foreign.status === 403 && body(foreign).error.code === "FORBIDDEN_ORIGIN" && noOrigin.status === 403 && h.db.jobs.size === 0, "foreign or missing Origin → 403 FORBIDDEN_ORIGIN, no job");
    const noKey = await read(await h.post({ prompt: PROMPT, quality: "fast" }, { key: null }));
    const badKey = await read(await h.post({ prompt: PROMPT, quality: "fast" }, { key: "bad key!" }));
    ok(noKey.status === 400 && badKey.status === 400 && body(noKey).error.code === "INVALID_INPUT", "missing / malformed Idempotency-Key → 400");
    const wrongType = await read(await h.post({ prompt: PROMPT, quality: "fast" }, { type: "text/plain" }));
    const badJson = await read(await h.post(null, { raw: "{nope" }));
    const tooBig = await read(await h.post({ prompt: "x".repeat(20_000), quality: "fast" }));
    const arr = await read(await h.post([PROMPT]));
    ok(wrongType.status === 400 && badJson.status === 400 && tooBig.status === 400 && arr.status === 400 && h.db.jobs.size === 0, "wrong content type / bad JSON / >16 KB / non-object body → 400, no job");
    const badQuality = await read(await h.post({ prompt: PROMPT, quality: "ultra" }));
    ok(badQuality.status === 400 && body(badQuality).error.code === "INVALID_INPUT", "invalid quality → 400 INVALID_INPUT");
    ok(h.prov.requests.length === 0, "no provider call for any rejected request");

    const k = key();
    const created = await read(await h.post({ prompt: PROMPT, quality: "fast", userId: "someone-else" }, { key: k }));
    const b = body(created);
    ok(created.status === 201 && b.job.status === "COMPLETED" && b.replayed === false && b.balance === 99, "success → 201 COMPLETED, balance 99");
    ok(h.db.jobs.get(b.job.id)?.userId === u, "client-supplied userId in the body is ignored; job owned by the session user");
    ok(b.asset?.url === `/api/assets/${b.asset?.id}` && b.asset.mimeType === "image/webp" && b.asset.width === 1024, "response carries the stable asset URL");
    ok(!created.text.includes("users/") && !created.text.includes("storageKey") && !created.text.includes("errorMessage") && !created.text.includes("reservedCentiNeurons"),
      "response leaks no storage key, internal reason or accounting internals");
    ok(created.headers.get("cache-control") === "private, no-store" && created.headers.get("location") === `/api/generations/${b.job.id}`, "no-store + Location headers");
    ok(h.scheduled.length === 2, "background reconciliation scheduled only for authenticated, well-formed POSTs (2 so far; none for 401/403/400-shape)");
    const replay = await read(await h.post({ prompt: PROMPT, quality: "fast" }, { key: k }));
    ok(replay.status === 200 && body(replay).replayed === true && body(replay).job.id === b.job.id && h.prov.requests.length === 1, "replay → 200 replayed, same job, no new provider call");
    const conflict = await read(await h.post({ prompt: "different", quality: "fast" }, { key: k }));
    ok(conflict.status === 409 && body(conflict).error.code === "IDEMPOTENCY_CONFLICT", "key reuse with different body → 409 IDEMPOTENCY_CONFLICT");
    await h.scheduled[0]();
    ok(true, "scheduled background task runs without error");
  }
  {
    const h = httpHarness(failing({ code: "QUOTA_EXHAUSTED", outcome: "not_run", message: "Provider said: quota (secret detail)", httpStatus: 429, providerCode: 3036 }));
    const u = h.newUser(); h.login(u);
    const r = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    const b = body(r);
    ok(r.status === 502 && b.job.status === "FAILED" && b.job.error.code === "GENERATION_FAILED" && b.job.error.reason === "SERVICE_BUSY" && b.job.error.refunded === true, "not_run failure → 502 FAILED, SERVICE_BUSY, refunded");
    ok(b.balance === 100 && b.job.creditsCharged === 0 && !r.text.includes("secret detail") && !r.text.includes("3036"), "balance restored; raw provider message never returned");
  }
  {
    const h = httpHarness(failing({ code: "TIMEOUT", outcome: "unknown", message: "timeout" }));
    const u = h.newUser(); h.login(u);
    const k = key();
    const r = await read(await h.post({ prompt: PROMPT, quality: "fast" }, { key: k }));
    const b = body(r);
    ok(r.status === 202 && b.job.status === "PROCESSING" && b.job.outcomeUnknown === true && r.headers.get("retry-after") === String(config.GENERATION_POLL_INTERVAL_S), "unknown outcome → 202 + Retry-After, outcomeUnknown");
    const replay = await read(await h.post({ prompt: PROMPT, quality: "fast" }, { key: k }));
    ok(replay.status === 202 && body(replay).replayed && h.prov.requests.length === 1, "refresh recovery: replaying the key → 202, no provider call");
    const g1 = await read(await h.handlers.getJob(new Request("http://x"), b.job.id));
    ok(g1.status === 200 && body(g1).job.status === "PROCESSING", "GET while unresolved → 200 PROCESSING");
    h.db.now = new Date(h.db.now.getTime() + 5 * 60_000 + 1_000);
    const g2 = await read(await h.handlers.getJob(new Request("http://x"), b.job.id));
    ok(g2.status === 200 && body(g2).job.status === "FAILED" && body(g2).job.error.reason === "TIMED_OUT" && body(g2).balance === 100, "GET after 5 min → reconciled FAILED (TIMED_OUT), refunded");
    const busy = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(busy.status !== 409, "slot freed after reconciliation");
  }
  {
    const h = httpHarness();
    const gate = deferred(); const inside = deferred();
    h.prov.provider.behaviour = async (req) => { inside.resolve(); await gate.promise; return success()(req); };
    const u = h.newUser(); h.login(u);
    const first = h.post({ prompt: PROMPT, quality: "fast" });
    await inside.promise;
    const second = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(second.status === 409 && body(second).error.code === "ACTIVE_JOB_EXISTS", "second job while one is active → 409 ACTIVE_JOB_EXISTS");
    gate.resolve(); await first;
    const poor = h.newUser(0); h.login(poor);
    const p = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(p.status === 402 && body(p).error.code === "INSUFFICIENT_CREDITS", "no credits → 402");
    const busyUser = h.newUser(); h.login(busyUser);
    h.prov.provider.behaviour = failing({ code: "MALFORMED_RESPONSE", outcome: "ran", message: "x", httpStatus: 200 });
    for (let i = 0; i < 10; i++) await h.post({ prompt: PROMPT, quality: "fast" });
    const lim = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(lim.status === 429 && body(lim).error.code === "DAILY_LIMIT_REACHED" && /T00:00:00\.000Z$/.test(body(lim).error.resetAt) && Number(lim.headers.get("retry-after")) > 0,
      "daily limit → 429 with resetAt (00:00 UTC) and Retry-After");
    h.db.budget.limit = h.db.budget.reserved + h.db.budget.consumed;
    const capUser = h.newUser(); h.login(capUser);
    const cap = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(cap.status === 503 && body(cap).error.code === "CAPACITY_EXHAUSTED" && !!body(cap).error.resetAt, "app budget used up → 503 CAPACITY_EXHAUSTED with resetAt");
  }
  {
    const h = httpHarness();
    const u = h.newUser(); h.login(u);
    h.extra.generateThrows = new GenerationUnavailableError();
    const un = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(un.status === 503 && body(un).error.code === "SERVICE_UNAVAILABLE", "service not configured → 503 SERVICE_UNAVAILABLE");
    h.extra.generateThrows = new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2");
    const boom = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(boom.status === 500 && body(boom).error.code === "INTERNAL_ERROR" && !boom.text.includes("hunter2") && !boom.text.includes("ECONNREFUSED"), "unexpected error → 500 without internal details");
    h.extra.generateThrows = null;
    h.extra.loadFails = true;
    const lost = await read(await h.post({ prompt: PROMPT, quality: "fast" }));
    ok(lost.status === 500 && typeof body(lost).error.jobId === "string", "job created but status unreadable → 500 with jobId for recovery");
  }

  section("HTTP — GET /api/generations/{jobId} and /api/assets/{assetId}");
  {
    const h = httpHarness();
    const owner = h.newUser(); const other = h.newUser();
    h.login(owner);
    const created = body(await read(await h.post({ prompt: PROMPT, quality: "fast" })));
    const g = await read(await h.handlers.getJob(new Request("http://x"), created.job.id));
    ok(g.status === 200 && body(g).job.id === created.job.id && body(g).asset.id === created.asset.id && body(g).replayed === false, "owner GET job → 200 with asset");
    h.login(other);
    const g2 = await read(await h.handlers.getJob(new Request("http://x"), created.job.id));
    const g3 = await read(await h.handlers.getJob(new Request("http://x"), "does-not-exist"));
    const g4 = await read(await h.handlers.getJob(new Request("http://x"), "../../etc"));
    ok(g2.status === 404 && g3.status === 404 && g4.status === 404 && g2.text === g3.text, "other user's / missing / malformed job id → identical 404");
    const a2 = await h.handlers.getAsset(new Request("http://x"), created.asset.id);
    ok(a2.status === 404, "other user's asset → 404 (no signed URL)");
    h.login(null);
    ok((await h.handlers.getJob(new Request("http://x"), created.job.id)).status === 401 && (await h.handlers.getAsset(new Request("http://x"), created.asset.id)).status === 401, "unauthenticated GETs → 401");
    h.login(owner);
    const a = await h.handlers.getAsset(new Request("http://x"), created.asset.id);
    const loc = a.headers.get("location") ?? "";
    ok(a.status === 302 && loc.includes(`/users/${owner}/images/${created.job.id}/`) && loc.includes(`ttl=${config.SIGNED_URL_TTL_SECONDS}`), "owner asset → 302 to a 10-minute signed URL");
    ok(a.headers.get("cache-control") === "private, no-store" && a.headers.get("referrer-policy") === "no-referrer", "redirect is not cacheable and sends no referrer");
    ok((await h.handlers.getAsset(new Request("http://x"), "missing-asset-id")).status === 404, "unknown asset → 404");
    h.storage.failSign = true;
    const s = await read(await h.handlers.getAsset(new Request("http://x"), created.asset.id));
    ok(s.status === 503 && !s.text.includes("sign failed"), "signing failure → 503 without internal details");
  }

  ok(realNetworkAttempts === 0, "no real network request was attempted");
} catch (e) {
  fail++;
  console.error("UNCAUGHT", e);
} finally {
  clearInterval(keepAlive);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
