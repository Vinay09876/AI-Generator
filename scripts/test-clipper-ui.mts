// Stage 9 Batch 6 (client/UI): view-state honesty rules, local file checks, controller Fix A
// (reservation release on every path, recovery, cross-tab lock), resume(jobId), cancelQueued, and
// static rendering of the clipper components. Fully offline. Run: npm run test:clipper-ui
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as clientNs from "../src/features/clipper/client/index";
const client = ((clientNs as any).default ?? clientNs) as typeof clientNs;

const {
  createClipperController,
  createWebUploadLock,
  readPending,
  writePending,
  readReservation,
  writeReservation,
  reservationKey,
  checkLocalFile,
  checkLocalMetadata,
  getSubmitBlocker,
  presentError,
  describeClipperState,
  formatBytes,
  formatClock,
  formatElapsed,
  clipCost,
  clipDownloadHref,
  QUEUE_ESCALATION_MS,
} = client;

const { AnalysisNotice } = await import("../src/components/video-clipper/analysis-notice");
const { WorkerNotice } = await import("../src/components/video-clipper/worker-notice");
const { ClipperStatus } = await import("../src/components/video-clipper/clipper-status");
const { ClipSettings } = await import("../src/components/video-clipper/clip-settings");
const { ClipCard } = await import("../src/components/video-clipper/clip-card");
const { ClipperCostSummary } = await import("../src/components/video-clipper/clipper-cost-summary");
const { UploadDropzone } = await import("../src/components/video-clipper/upload-dropzone");

type ClipJobView = import("../src/features/clipper/job-view").ClipJobView;
type ClipperClientState = clientNs.ClipperClientState;

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

const USER = "usr_owner00001";
const KEY = `ephemeral/users/${USER}/uploads/upl_src0000001.mp4`;
const T0 = Date.parse("2026-11-11T10:00:00.000Z");

const LIMITS: clientNs.ClipperLimitsView = {
  maxUploadBytes: 50 * 1024 * 1024,
  minSourceSeconds: 15,
  maxSourceSeconds: 300,
  minLongEdge: 480,
  minShortEdge: 360,
  maxLongEdge: 1920,
  maxShortEdge: 1080,
  maxPixels: 1920 * 1080,
  maxClips: 3,
  creditsPerClip: 5,
  mimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
  extensions: [".mp4", ".mov", ".webm"],
  clipDuration: { targetSeconds: 30, minSeconds: 5, maxSeconds: 60 },
  queueTimeoutMinutes: 30,
};

const ANALYSIS = { highlightMode: "scene_pacing", speechAnalysis: "unavailable", captions: "unavailable", originalAudio: "preserved" } as const;

function job(status: string, extra: Partial<ClipJobView> = {}): ClipJobView {
  return {
    id: "job_view000001",
    status,
    createdAt: new Date(T0).toISOString(),
    startedAt: status === "PROCESSING" ? new Date(T0 + 60_000).toISOString() : null,
    completedAt: null,
    aspectRatio: "9:16",
    framing: "pillarbox_blur",
    requestedClips: 2,
    credits: { estimated: 10, charged: 0 },
    analysis: ANALYSIS,
    error: null,
    clips: [],
    ...extra,
  };
}

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const ok = <T,>(data: T, status = 200) => ({ ok: true as const, status, data });
const err = (code: string, status: number | null, message = code) => ({ ok: false as const, error: { code, message, status, retryAfterSeconds: null } });

/** Fake API with call log; each endpoint overridable. */
function fakeApi(over: Record<string, unknown> = {}) {
  const log: string[] = [];
  const api = {
    requestUploadIntent: async () => (log.push("intent"), ok({ upload: { uploadKey: KEY, uploadId: "upl_src0000001", signedUrl: "https://proj.supabase.co/up", contentType: "video/mp4", maxBytes: 1, expiresAt: "" } }, 201)),
    completeUpload: async () => (log.push("complete"), ok({ upload: { uploadKey: KEY, sizeBytes: 10, container: "mp4" } })),
    discardUpload: async (k: string) => (log.push(`discard:${k}`), ok({ deleted: true as const })),
    postClipJob: async () => (log.push("post"), ok({ job: job("PENDING"), replayed: false, balance: 90 }, 202)),
    getClipJob: async () => (log.push("get"), ok({ job: job("COMPLETED"), replayed: false, balance: 90 })),
    cancelClipJob: async () => (log.push("cancel"), ok({ job: job("CANCELLED", { error: { code: "USER_CANCELLED", message: "refunded" } }), replayed: false, balance: 100 })),
    ...over,
  };
  return { api: api as any, log };
}

const fileBlob = () => Object.assign(new Blob(["video"], { type: "video/mp4" }));
const startInput = () => ({ file: fileBlob(), hints: { durationSeconds: 60, width: 1920, height: 1080 }, options: { aspectRatio: "9:16" as const, framing: "pillarbox_blur" as const, clipCount: 2 } });
/** Yields a macrotask (so tests can interleave) and returns early on abort. */
const noSleep = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, 0);
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

function controller(over: { api?: any; upload?: any; storage?: MemStorage; lock?: any; newKey?: () => string } = {}) {
  const storage = over.storage ?? new MemStorage();
  const { api, log } = over.api ? { api: over.api, log: [] as string[] } : fakeApi();
  const c = createClipperController({
    userId: USER,
    storage,
    api,
    upload: over.upload ?? (async () => ({ ok: true as const })),
    uploadLock: over.lock ?? null,
    now: () => T0,
    sleep: noSleep,
    newKey: over.newKey ?? (() => "clip-testkey000001"),
  });
  return { c, storage, log };
}

async function run() {
  // -------------------------------------------------------------------------
  // 1. Formatting + local checks
  // -------------------------------------------------------------------------
  await test("formatters", () => {
    assert.equal(formatBytes(50 * 1024 * 1024), "50 MB");
    assert.equal(formatBytes(1536 * 1024), "1.5 MB");
    assert.equal(formatClock(75), "1:15");
    assert.equal(formatClock(null), "—");
    assert.equal(formatElapsed(45_000), "45 s");
    assert.equal(formatElapsed(3 * 60_000), "3 min");
    assert.equal(formatElapsed(65 * 60_000), "1 h 5 min");
    assert.equal(clipCost(3, 5), 15);
  });
  await test("local file: accepts MP4/MOV/WebM, infers MIME for an empty-type .mov", () => {
    assert.deepEqual(checkLocalFile({ name: "a.mp4", type: "video/mp4", size: 10 }, LIMITS), { ok: true, mimeType: "video/mp4" });
    assert.deepEqual(checkLocalFile({ name: "Clip.MOV", type: "", size: 10 }, LIMITS), { ok: true, mimeType: "video/quicktime" });
  });
  await test("local file: rejects other types, mismatched extension, empty and oversized files", () => {
    assert.equal(checkLocalFile({ name: "a.avi", type: "video/x-msvideo", size: 10 }, LIMITS).ok, false);
    assert.equal(checkLocalFile({ name: "a.mp4", type: "image/png", size: 10 }, LIMITS).ok, false);
    assert.equal(checkLocalFile({ name: "noext", type: "video/mp4", size: 10 }, LIMITS).ok, false);
    assert.equal(checkLocalFile({ name: "a.mp4", type: "video/mp4", size: 0 }, LIMITS).ok, false);
    const big = checkLocalFile({ name: "a.mp4", type: "video/mp4", size: LIMITS.maxUploadBytes + 1 }, LIMITS);
    assert.equal(big.ok, false);
    assert.match((big as any).message, /maximum is 50 MB/);
    assert.equal(checkLocalFile({ name: "a.mp4", type: "video/mp4", size: LIMITS.maxUploadBytes }, LIMITS).ok, true);
  });
  await test("local metadata: unreadable is blocking (duration is required by the API)", () => {
    assert.equal(checkLocalMetadata(null, LIMITS).ok, false);
    assert.equal(checkLocalMetadata({ durationSeconds: NaN, width: 1, height: 1 }, LIMITS).ok, false);
  });
  await test("local metadata: duration bounds are inclusive (15 s – 5 min)", () => {
    assert.equal(checkLocalMetadata({ durationSeconds: 15, width: 1280, height: 720 }, LIMITS).ok, true);
    assert.equal(checkLocalMetadata({ durationSeconds: 300, width: 1280, height: 720 }, LIMITS).ok, true);
    assert.equal(checkLocalMetadata({ durationSeconds: 14.9, width: 1280, height: 720 }, LIMITS).ok, false);
    assert.equal(checkLocalMetadata({ durationSeconds: 300.5, width: 1280, height: 720 }, LIMITS).ok, false);
  });
  await test("local metadata (Batch 7): portrait, landscape and square 1080p are all accepted", () => {
    for (const [w, h] of [[1080, 1920], [1920, 1080], [1080, 1080], [720, 1280], [360, 480]]) {
      assert.equal(checkLocalMetadata({ durationSeconds: 60, width: w, height: h }, LIMITS).ok, true, `${w}x${h}`);
    }
  });
  await test("local metadata (Batch 7): above 1080p or below 480x360 is rejected in either orientation", () => {
    for (const [w, h] of [[2160, 3840], [3840, 2160], [1440, 2560], [1440, 1440], [1200, 1200], [1081, 1920], [320, 240], [240, 320]]) {
      assert.equal(checkLocalMetadata({ durationSeconds: 60, width: w, height: h }, LIMITS).ok, false, `${w}x${h}`);
    }
    const msg = (checkLocalMetadata({ durationSeconds: 60, width: 2160, height: 3840 }, LIMITS) as any).message;
    assert.match(msg, /in any orientation/);
  });
  await test("submit blockers: switch first, then daily limit, credits, file", () => {
    const base = { submissionsEnabled: true, balance: 100, cost: 10, dailyUsed: 0, dailyLimit: 2, hasFile: true, fileError: null };
    assert.equal(getSubmitBlocker(base), null);
    assert.equal(getSubmitBlocker({ ...base, submissionsEnabled: false, balance: 0 })?.code, "CLIPPER_UNAVAILABLE");
    assert.equal(getSubmitBlocker({ ...base, dailyUsed: 2 })?.code, "DAILY_LIMIT_REACHED");
    assert.equal(getSubmitBlocker({ ...base, balance: 9 })?.code, "INSUFFICIENT_CREDITS");
    assert.equal(getSubmitBlocker({ ...base, hasFile: false })?.code, "NO_FILE");
    assert.equal(getSubmitBlocker({ ...base, fileError: "bad" })?.code, "FILE_INVALID");
  });
  await test("error presentation: actions and server-message fallback", () => {
    assert.equal(presentError("UNAUTHENTICATED").action, "sign_in");
    assert.equal(presentError("UPLOAD_PENDING_EXISTS").action, "release_pending");
    assert.equal(presentError("UPLOAD_TOO_LARGE").action, "choose_file");
    assert.equal(presentError("NETWORK_ERROR").action, "retry");
    assert.equal(presentError("CLIPPER_UNAVAILABLE", "off").action, "none");
    assert.equal(presentError("SOMETHING_NEW", "Server said this").message, "Server said this");
    assert.equal(presentError("INSUFFICIENT_HIGHLIGHTS", "x").title, "Not enough distinct moments");
  });

  // -------------------------------------------------------------------------
  // 2. Status view honesty
  // -------------------------------------------------------------------------
  const limits = { queueTimeoutMinutes: 30 };
  const allStates: ClipperClientState[] = [
    { phase: "idle" },
    { phase: "uploading", progress: 0.42 },
    { phase: "verifying" },
    { phase: "submitting", attempt: 1 },
    { phase: "submitting", attempt: 3 },
    { phase: "processing", job: null },
    { phase: "processing", job: job("PENDING") },
    { phase: "processing", job: job("PROCESSING") },
    { phase: "completed", job: job("COMPLETED") },
    { phase: "failed", error: { code: "INSUFFICIENT_HIGHLIGHTS", message: "x" } },
    { phase: "cancelled", job: job("CANCELLED") },
    { phase: "expired" },
  ];
  await test("honesty: the only percentage is real upload progress", () => {
    for (const s of allStates) {
      const v = describeClipperState(s, T0 + 10 * 60_000, limits);
      if (s.phase === "uploading") assert.equal(v.uploadPercent, 42);
      else {
        assert.equal(v.uploadPercent, null, s.phase);
        assert.ok(!/\d\s*%/.test(`${v.title} ${v.detail}`), `no percentage in ${s.phase}`);
      }
    }
  });
  await test("honesty: 'Processing' only when the server says a worker started the job", () => {
    for (const s of allStates) {
      const v = describeClipperState(s, T0 + 30_000, limits);
      const isStarted = s.phase === "processing" && s.job?.status === "PROCESSING";
      assert.equal(v.kind === "processing", isStarted, s.phase);
      if (v.kind !== "processing") assert.ok(!/^Processing/.test(v.title), `title for ${s.phase}`);
    }
  });
  await test("queued: plain waiting state, escalates after 2 minutes with refund options", () => {
    const early = describeClipperState({ phase: "processing", job: job("PENDING") }, T0 + QUEUE_ESCALATION_MS - 1, limits);
    assert.equal(early.kind, "queued");
    assert.equal(early.title, "Queued, waiting for a worker");
    assert.equal(early.canCancelQueued, true);
    const late = describeClipperState({ phase: "processing", job: job("PENDING") }, T0 + QUEUE_ESCALATION_MS, limits);
    assert.equal(late.kind, "queued_long");
    assert.equal(late.tone, "warning");
    assert.match(late.detail, /No worker has started this job yet/);
    assert.match(late.detail, /30 minutes/);
    assert.equal(late.elapsedLabel, "Waiting 2 min");
  });
  await test("cancel-and-refund is offered only for queued jobs", () => {
    for (const s of allStates) {
      const v = describeClipperState(s, T0, limits);
      assert.equal(v.canCancelQueued, s.phase === "processing" && s.job?.status === "PENDING", s.phase);
    }
  });
  await test("processing shows time since the worker started", () => {
    const v = describeClipperState({ phase: "processing", job: job("PROCESSING") }, T0 + 4 * 60_000, limits);
    assert.equal(v.elapsedLabel, "Started 3 min ago");
  });
  await test("retry with the same key is explained without implying a double charge", () => {
    const v = describeClipperState({ phase: "submitting", attempt: 2 }, T0, limits);
    assert.match(v.detail, /can't be charged twice/);
  });

  // -------------------------------------------------------------------------
  // 3. Controller Fix A — reservation released on every path before a job exists
  // -------------------------------------------------------------------------
  await test("Fix A: the reservation key is persisted before the upload starts", async () => {
    const storage = new MemStorage();
    let seenDuringUpload: unknown = null;
    const { c } = controller({
      storage,
      upload: async () => {
        seenDuringUpload = readReservation(storage, USER);
        return { ok: true as const };
      },
    });
    await c.startUpload(startInput());
    assert.equal((seenDuringUpload as any)?.uploadKey, KEY);
  });
  await test("Fix A: success hands the upload to the job and clears the reservation record", async () => {
    const { c, storage } = controller();
    await c.startUpload(startInput());
    assert.equal(c.getState().phase, "completed");
    assert.equal(readReservation(storage, USER), null);
  });
  await test("Fix A: cancel during upload → released, idle", async () => {
    const { api, log } = fakeApi();
    let release: () => void = () => {};
    const storage = new MemStorage();
    const { c } = controller({
      api,
      storage,
      upload: ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, code: "ABORTED", status: null });
          signal.addEventListener("abort", () => release());
        }),
    });
    const p = c.startUpload(startInput());
    await new Promise((r) => setTimeout(r, 0));
    c.cancel();
    await p;
    assert.equal(c.getState().phase, "idle");
    assert.ok(log.includes(`discard:${KEY}`));
    assert.equal(readReservation(storage, USER), null);
  });
  await test("Fix A: cancel during verification → released (was leaked before Batch 6)", async () => {
    const storage = new MemStorage();
    let ctl: ReturnType<typeof controller>["c"] | null = null;
    const { api, log } = fakeApi({
      completeUpload: async () => {
        ctl!.cancel();
        return err("ABORTED", null);
      },
    });
    const { c } = controller({ api, storage });
    ctl = c;
    await c.startUpload(startInput());
    assert.equal(c.getState().phase, "idle");
    assert.ok(log.includes(`discard:${KEY}`));
    assert.equal(readReservation(storage, USER), null);
    assert.ok(!log.includes("post"), "no job submitted");
  });
  await test("Fix A: cancel while the intent request is in flight but answered → released", async () => {
    let ctl: ReturnType<typeof controller>["c"] | null = null;
    const { api, log } = fakeApi({
      requestUploadIntent: async () => {
        ctl!.cancel();
        return ok({ upload: { uploadKey: KEY, uploadId: "u", signedUrl: "https://proj.supabase.co/up", contentType: "video/mp4", maxBytes: 1, expiresAt: "" } });
      },
    });
    const { c } = controller({ api });
    ctl = c;
    await c.startUpload(startInput());
    assert.ok(log.includes(`discard:${KEY}`));
    assert.ok(!log.includes("complete"));
  });
  await test("Fix A: upload failure and verification failure both release", async () => {
    const a = fakeApi();
    const one = controller({ api: a.api, upload: async () => ({ ok: false, code: "UPLOAD_REJECTED", status: 403 }) });
    await one.c.startUpload(startInput());
    assert.equal(one.c.getState().phase, "failed");
    assert.ok(a.log.includes(`discard:${KEY}`));
    const b = fakeApi({ completeUpload: async () => err("UPLOAD_INVALID_CONTAINER", 415) });
    const two = controller({ api: b.api });
    await two.c.startUpload(startInput());
    assert.ok(b.log.includes(`discard:${KEY}`));
    assert.equal(readReservation(two.storage, USER), null);
  });
  await test("Fix A: CLIPPER_UNAVAILABLE (503) is definitive — one POST, no retries, upload released", async () => {
    const { api, log } = fakeApi({ postClipJob: async () => (log.push("post"), err("CLIPPER_UNAVAILABLE", 503)) });
    const { c, storage } = controller({ api });
    await c.startUpload(startInput());
    assert.equal(log.filter((l) => l === "post").length, 1);
    assert.equal(c.getState().phase, "failed");
    assert.ok(log.includes(`discard:${KEY}`));
    assert.equal(readPending(storage, USER, T0), null);
  });
  await test("Fix A: a failed release keeps the record for the next page load", async () => {
    const { api } = fakeApi({ discardUpload: async () => err("NETWORK_ERROR", null), completeUpload: async () => err("UPLOAD_INVALID_CONTAINER", 415) });
    const { c, storage } = controller({ api });
    await c.startUpload(startInput());
    assert.equal(readReservation(storage, USER)?.uploadKey, KEY);
  });

  // -------------------------------------------------------------------------
  // 4. Recovery of abandoned reservations on page load
  // -------------------------------------------------------------------------
  await test("recover: an orphan reservation (no pending job) is released and cleared", async () => {
    const storage = new MemStorage();
    writeReservation(storage, USER, { v: 1, uploadKey: KEY, createdAt: T0 });
    const { api, log } = fakeApi();
    const { c } = controller({ api, storage });
    await c.recover();
    assert.deepEqual(log, [`discard:${KEY}`]);
    assert.equal(storage.getItem(reservationKey(USER)), null);
    assert.equal(c.getState().phase, "idle");
  });
  await test("recover: a reservation held by another tab is left alone", async () => {
    const storage = new MemStorage();
    writeReservation(storage, USER, { v: 1, uploadKey: KEY, createdAt: T0 });
    const { api, log } = fakeApi();
    const { c } = controller({ api, storage, lock: { run: (fn: any) => fn(), isHeld: async () => true } });
    await c.recover();
    assert.deepEqual(log, []);
    assert.equal(readReservation(storage, USER)?.uploadKey, KEY);
  });
  await test("recover: a reservation already owned by a created job is just cleared (no discard)", async () => {
    const storage = new MemStorage();
    writeReservation(storage, USER, { v: 1, uploadKey: KEY, createdAt: T0 });
    writePending(storage, USER, {
      v: 1,
      idempotencyKey: "clip-testkey000001",
      source: { type: "upload", uploadKey: KEY },
      options: { aspectRatio: "9:16", framing: "fit", clipCount: 1 },
      createdAt: T0,
      jobId: "job_view000001",
    });
    const { api, log } = fakeApi();
    const { c } = controller({ api, storage });
    await c.recover();
    assert.ok(!log.some((l) => l.startsWith("discard")));
    assert.equal(readReservation(storage, USER), null);
    assert.equal(c.getState().phase, "completed", "polled the existing job");
  });
  await test("recover: an unconfirmed submission keeps its upload and replays with the SAME key", async () => {
    const storage = new MemStorage();
    writeReservation(storage, USER, { v: 1, uploadKey: KEY, createdAt: T0 });
    writePending(storage, USER, {
      v: 1,
      idempotencyKey: "clip-original00001",
      source: { type: "upload", uploadKey: KEY },
      options: { aspectRatio: "9:16", framing: "fit", clipCount: 1 },
      createdAt: T0,
    });
    const keys: string[] = [];
    const { api, log } = fakeApi({ postClipJob: async (i: any) => (keys.push(i.idempotencyKey), log.push("post"), ok({ job: job("COMPLETED"), replayed: true, balance: 90 })) });
    let minted = 0;
    const { c } = controller({ api, storage, newKey: () => (minted++, "clip-new00000001") });
    await c.recover();
    assert.deepEqual(keys, ["clip-original00001"]);
    assert.equal(minted, 0);
    assert.ok(!log.some((l) => l.startsWith("discard")));
    assert.equal(readReservation(storage, USER), null);
  });

  // -------------------------------------------------------------------------
  // 5. resume(jobId) and cancelQueued()
  // -------------------------------------------------------------------------
  await test("resume: polls an existing job, never POSTs, never mints a key", async () => {
    let minted = 0;
    const { api, log } = fakeApi();
    const { c, storage } = controller({ api, newKey: () => (minted++, "clip-x00000000001") });
    await c.resume("job_view000001");
    assert.deepEqual(log, ["get"]);
    assert.equal(minted, 0);
    assert.equal(c.getState().phase, "completed");
    assert.equal(storage.map.size, 0, "nothing persisted");
  });
  await test("resume: ignores malformed ids and does nothing while busy", async () => {
    const { api, log } = fakeApi();
    const { c } = controller({ api });
    await c.resume("../../etc");
    assert.deepEqual(log, []);
    assert.equal(c.getState().phase, "idle");
  });
  await test("cancelQueued: PENDING → server cancel → 'cancelled', local record cleared", async () => {
    let polls = 0;
    const { api, log } = fakeApi({ getClipJob: async () => (polls++, ok({ job: job("PENDING"), replayed: false, balance: 90 })) });
    const storage = new MemStorage();
    const { c } = controller({ api, storage });
    const p = c.resume("job_view000001");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(c.getState().phase, "processing");
    const res = await c.cancelQueued();
    assert.deepEqual(res, { ok: true });
    assert.equal(c.getState().phase, "cancelled");
    assert.ok(log.includes("cancel"));
    await p;
    assert.ok(polls >= 1);
  });
  await test("cancelQueued: worker won the race (409) → keeps processing, returns the message", async () => {
    let stop = false;
    const { api } = fakeApi({
      getClipJob: async () => ok({ job: job("PENDING"), replayed: false, balance: 90 }),
      cancelClipJob: async () => err("JOB_ALREADY_STARTED", 409, "A worker has already started this job"),
    });
    const c = createClipperController({
      userId: USER,
      storage: new MemStorage(),
      api,
      now: () => T0,
      sleep: (_ms, signal) => new Promise((r) => (stop ? r() : signal.addEventListener("abort", () => r()))),
    });
    const p = c.resume("job_view000001");
    await new Promise((r) => setTimeout(r, 0));
    const res = await c.cancelQueued();
    assert.equal(res.ok, false);
    assert.equal((res as any).code, "JOB_ALREADY_STARTED");
    assert.equal(c.getState().phase, "processing");
    stop = true;
    c.cancel();
    await p;
  });
  await test("cancelQueued: refuses without calling the API unless the job is PENDING", async () => {
    const { api, log } = fakeApi({ getClipJob: async () => ok({ job: job("PROCESSING"), replayed: false, balance: 90 }) });
    const c = createClipperController({ userId: USER, storage: null, api, now: () => T0, sleep: (_ms, s) => new Promise((r) => s.addEventListener("abort", () => r())) });
    const idle = await c.cancelQueued();
    assert.equal(idle.ok, false);
    const p = c.resume("job_view000001");
    await new Promise((r) => setTimeout(r, 0));
    const res = await c.cancelQueued();
    assert.equal((res as any).code, "NOT_CANCELLABLE");
    assert.ok(!log.includes("cancel"));
    c.cancel();
    await p;
  });
  await test("cancel(): stops local polling and returns to idle; the pending record is kept for recovery", async () => {
    const storage = new MemStorage();
    const { api } = fakeApi({
      postClipJob: async () => ok({ job: job("PENDING"), replayed: false, balance: 90 }, 202),
      getClipJob: async () => ok({ job: job("PENDING"), replayed: false, balance: 90 }),
    });
    const c = createClipperController({
      userId: USER,
      storage,
      api,
      upload: async () => ({ ok: true as const }),
      now: () => T0,
      newKey: () => "clip-testkey000001",
      sleep: (_ms, s) => new Promise((r) => s.addEventListener("abort", () => r())),
    });
    const p = c.startUpload(startInput());
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.getState().phase, "processing");
    c.cancel();
    await p;
    assert.equal(c.getState().phase, "idle");
    assert.equal(readPending(storage, USER, T0)?.jobId, "job_view000001");
  });

  // -------------------------------------------------------------------------
  // 6. Cross-tab lock adapter
  // -------------------------------------------------------------------------
  await test("tab lock: never waits (ifAvailable), detects holders by name, fails safe on query errors", async () => {
    const requests: unknown[] = [];
    const manager = {
      request: async (name: string, opts: unknown, cb: (l: unknown) => Promise<unknown>) => (requests.push([name, opts]), cb({})),
      query: async () => ({ held: [{ name: `yourai:clipper:upload:${USER}` }] }),
    };
    const lock = createWebUploadLock(USER, manager)!;
    assert.equal(await lock.run(async () => 7), 7);
    assert.deepEqual(requests[0], [`yourai:clipper:upload:${USER}`, { ifAvailable: true }]);
    assert.equal(await lock.isHeld(), true);
    const other = createWebUploadLock("usr_other00001", manager)!;
    assert.equal(await other.isHeld(), false);
    const broken = createWebUploadLock(USER, { request: manager.request, query: async () => { throw new Error("x"); } })!;
    assert.equal(await broken.isHeld(), true);
    assert.equal(createWebUploadLock(USER, null), null);
  });

  // -------------------------------------------------------------------------
  // 7. Component rendering
  // -------------------------------------------------------------------------
  await test("render: analysis notice states speech analysis and captions are unavailable", () => {
    const html = renderToStaticMarkup(createElement(AnalysisNotice, { analysis: ANALYSIS }));
    assert.match(html, /Speech analysis/);
    assert.match(html, /Not available yet: what people say is not analysed/);
    assert.match(html, /Captions/);
    assert.match(html, /Not available yet: clips have no subtitles/);
    assert.match(html, /Original audio kept/);
  });
  await test("render: worker notice never claims a worker is online", () => {
    const on = renderToStaticMarkup(createElement(WorkerNotice, { enabled: true }));
    const off = renderToStaticMarkup(createElement(WorkerNotice, { enabled: false }));
    for (const html of [on, off]) {
      assert.ok(!/\bonline\b/i.test(html), "no 'online' claim");
      assert.ok(!/worker is (running|available)/i.test(html), "no liveness claim");
    }
    assert.match(on, /can&#x27;t tell whether it is running/);
    assert.match(off, /switched off/);
    assert.match(off, /Nothing can be uploaded, reserved or charged/);
  });
  await test("render: queued status offers cancel-and-refund and shows no percentage", () => {
    const status = describeClipperState({ phase: "processing", job: job("PENDING") }, T0 + 30_000, limits);
    const html = renderToStaticMarkup(createElement(ClipperStatus, { status, onCancelUpload: () => {}, onCancelQueued: async () => ({ ok: true as const }) }));
    assert.match(html, /Cancel and refund/);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.ok(!/role="progressbar"/.test(html));
    assert.ok(!/\d\s*%/.test(html.replace(/style="[^"]*"/g, "")));
  });
  await test("render: upload status has an accessible progress bar with the real value", () => {
    const status = describeClipperState({ phase: "uploading", progress: 0.375 }, T0, limits);
    const html = renderToStaticMarkup(createElement(ClipperStatus, { status, onCancelUpload: () => {}, onCancelQueued: async () => ({ ok: true as const }) }));
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuenow="37"/);
    assert.match(html, /Cancel upload/);
    assert.ok(!/Cancel and refund/.test(html));
  });
  await test("render: settings use native radio groups; clip length is fixed text, not a control", () => {
    const html = renderToStaticMarkup(
      createElement(ClipSettings, {
        value: { aspectRatio: "9:16", framing: "pillarbox_blur", clipCount: 2 },
        onChange: () => {},
        maxClips: 3,
        clipDuration: LIMITS.clipDuration,
      }),
    );
    assert.equal((html.match(/name="clip-aspect"/g) ?? []).length, 3);
    assert.equal((html.match(/name="clip-framing"/g) ?? []).length, 3);
    assert.equal((html.match(/name="clip-count"/g) ?? []).length, 3);
    assert.equal((html.match(/<legend/g) ?? []).length, 3);
    assert.match(html, /about 30 seconds each/);
    assert.match(html, /between.*5.*and.*60.*seconds/);
    assert.match(html, /can&#x27;t be adjusted yet/);
    assert.ok(!/type="range"|type="number"/.test(html), "no duration control");
  });
  await test("render: clip card downloads through the same-origin route, not the signed URL", () => {
    const html = renderToStaticMarkup(
      createElement(ClipCard, {
        jobId: "job_view000001",
        clip: { assetId: "ast_clip0000001", title: "Clip 1", durationSeconds: 29.6, width: 1080, height: 1920, videoUrl: "https://proj.supabase.co/sign/v?token=t", thumbnailUrl: null },
        index: 0,
        aspectRatio: "9:16",
        onExpired: () => {},
      }),
    );
    assert.match(html, /href="\/api\/generations\/clip\/job_view000001\/clips\/ast_clip0000001\/download"/);
    assert.match(html, /aria-label="Download Clip 1"/);
    assert.match(html, /<video[^>]+controls/);
    assert.equal(clipDownloadHref("a b", "c/d"), "/api/generations/clip/a%20b/clips/c%2Fd/download");
  });
  await test("render: cost summary and dropzone show the real limits", () => {
    const cost = renderToStaticMarkup(createElement(ClipperCostSummary, { cost: 10, balance: 5, dailyUsed: 1, dailyLimit: 2 }));
    assert.match(cost, /10 credits/);
    assert.match(cost, /1 \/ 2/);
    assert.match(cost, /refunded automatically/);
    const drop = renderToStaticMarkup(
      createElement(UploadDropzone, { onFile: () => {}, disabled: true, maxUploadBytes: LIMITS.maxUploadBytes, minSourceSeconds: 15, maxSourceSeconds: 300, maxLongEdge: 1920, maxShortEdge: 1080, accept: ".mp4,video/mp4" }),
    );
    assert.match(drop, /type="file"/);
    assert.match(drop, /disabled=""/);
    assert.match(drop, /up to 50 MB/);
    assert.match(drop, /0:15–5:00/);
    assert.match(drop, /vertical, square or landscape/);
  });

  console.log(`\n  Tests Passed: ${passed}\n  Tests Failed: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Unhandled test error:", e);
  process.exit(1);
});
