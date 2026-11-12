// Stage 9 Batch 7 (offline): orientation-neutral source limits, FFprobe rotation handling,
// lost-response upload reservation recovery (server + client), release-pending endpoint.
// No database, no storage, no network. Run: npm run test:clipper-b7
import assert from "node:assert/strict";
import * as clipperNs from "../src/features/clipper/index";
import * as clientNs from "../src/features/clipper/client/index";
const clipper = ((clipperNs as any).default ?? clipperNs) as typeof clipperNs;
const client = ((clientNs as any).default ?? clientNs) as typeof clientNs;

const {
  checkSourceDimensions,
  sourceOrientation,
  validateSourceMetadata,
  parseRotationDegrees,
  parseFfprobeJson,
  buildClipFilterGraph,
  CLIPPER_ASPECT_RATIOS,
  CLIPPER_FRAMING_MODES,
  createUploadIntent,
  discardUpload,
  releasePendingUploads,
  resolveDiscardTarget,
  createClipperHandlers,
  CLIPPER_UPLOAD_INTENT_DEADLINE_MS,
  CLIPPER_UPLOAD_ID_RELEASE_DELAY_MS,
  EPHEMERAL_UPLOAD_TTL_SECONDS,
} = clipper;
const { createClipperController, readReservation, writeReservation, newUploadId } = client;

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
const OTHER = "usr_other00001";
const ID = `upl_${"a".repeat(32)}`;
const ID2 = `upl_${"b".repeat(32)}`;
const KEY = `ephemeral/users/${USER}/uploads/${ID}.mp4`;
const T0 = new Date("2026-11-12T10:00:00.000Z");

const meta = (width: number, height: number, extra: Record<string, unknown> = {}) => ({
  durationSeconds: 60,
  width,
  height,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  hasAudio: true,
  sampleRate: 48000,
  channels: 2,
  bitrate: 4_000_000,
  fileSizeBytes: 30_000_000,
  ...extra,
});

// ---------------------------------------------------------------------------
// In-memory ClipperStorage (upload subset) with call log
// ---------------------------------------------------------------------------
class MemStore {
  objects = new Map<string, { size: number; createdAt: Date }>();
  log: string[] = [];
  failList = false;
  failDelete = false;
  clock = () => T0;
  async listFolder(prefix: string, page: { limit: number; offset: number }) {
    if (this.failList) throw new Error("list down");
    const all = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes("/"))
      .map(([key, o]) => ({ key, sizeBytes: o.size, createdAt: o.createdAt, updatedAt: o.createdAt }));
    return { objects: all.slice(page.offset, page.offset + page.limit), folders: [] };
  }
  async putPlaceholder(key: string) {
    this.log.push(`placeholder:${key}`);
    this.objects.set(key, { size: 0, createdAt: this.clock() });
  }
  async createSignedUploadUrl(key: string) {
    this.log.push(`sign:${key}`);
    return { signedUrl: `https://proj.supabase.co/upload/${encodeURIComponent(key)}?token=t`, key };
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error("delete down");
    this.log.push(`delete:${key}`);
    this.objects.delete(key);
  }
  async info() {
    return null;
  }
  async readPrefix() {
    return Buffer.alloc(0);
  }
  async openDownloadStream(): Promise<any> {
    throw new Error("n/a");
  }
  async createSignedUrl() {
    return "https://proj.supabase.co/x";
  }
  async putStream(): Promise<any> {
    throw new Error("n/a");
  }
}

function uploadDeps(store: MemStore, over: Partial<clipperNs.ClipperUploadDeps> = {}, active: string[] = [], referenced: string[] = []) {
  let locks = 0;
  const deps: clipperNs.ClipperUploadDeps = {
    storage: store as unknown as clipperNs.ClipperStorage,
    withUserLock: async (_u, fn) => {
      locks++;
      return fn({ activeSourceKeys: async () => active });
    },
    isSourceKeyReferenced: async (_u, k) => referenced.includes(k),
    now: () => store.clock(),
    ...over,
  };
  return { deps, locks: () => locks };
}

async function run() {
  // =========================================================================
  // 1. Orientation-neutral source limits
  // =========================================================================
  await test("dims: portrait, landscape and square 1080p are accepted (and orientation is reported)", () => {
    const cases: Array<[number, number, string]> = [
      [1080, 1920, "portrait"],
      [1920, 1080, "landscape"],
      [1080, 1080, "square"],
      [720, 1280, "portrait"],
      [1280, 720, "landscape"],
      [480, 360, "landscape"],
      [360, 480, "portrait"],
      [480, 480, "square"],
    ];
    for (const [w, h, o] of cases) {
      const r = checkSourceDimensions(w, h);
      assert.equal(r.ok, true, `${w}x${h}`);
      assert.equal((r as any).orientation, o);
      assert.equal(sourceOrientation(w, h), o);
    }
  });
  await test("dims: anything above 1080p is rejected in either orientation (edges AND pixel count)", () => {
    for (const [w, h] of [[3840, 2160], [2160, 3840], [2560, 1440], [1440, 2560], [1921, 1080], [1080, 1921], [1081, 1920], [1920, 1081], [1440, 1440], [1081, 1081]]) {
      const r = checkSourceDimensions(w, h);
      assert.equal(r.ok, false, `${w}x${h}`);
      assert.equal((r as any).code, "RESOLUTION_TOO_HIGH");
    }
  });
  await test("dims: below 480x360 is rejected in either orientation; invalid sizes rejected", () => {
    for (const [w, h] of [[479, 360], [480, 359], [360, 479], [359, 480], [320, 240], [240, 320], [359, 359], [360, 360]]) {
      assert.equal((checkSourceDimensions(w, h) as any).code, "RESOLUTION_TOO_LOW", `${w}x${h}`);
    }
    for (const [w, h] of [[0, 1080], [1080, -1], [1080.5, 1920], [NaN, 1080]]) {
      assert.equal((checkSourceDimensions(w, h) as any).code, "RESOLUTION_INVALID", `${w}x${h}`);
    }
  });
  await test("validateSourceMetadata: all three orientations pass; 4K portrait fails", () => {
    for (const [w, h] of [[1080, 1920], [1920, 1080], [1080, 1080]]) {
      const r = validateSourceMetadata(meta(w, h) as any);
      assert.equal(r.valid, true, `${w}x${h}`);
      if (r.valid) assert.deepEqual([r.data.width, r.data.height], [w, h]);
    }
    const r = validateSourceMetadata(meta(2160, 3840) as any);
    assert.equal(r.valid, false);
    if (!r.valid) assert.equal(r.code, "RESOLUTION_TOO_HIGH");
  });

  // =========================================================================
  // 2. FFprobe rotation
  // =========================================================================
  const probe = (stream: Record<string, unknown>) =>
    JSON.stringify({
      streams: [{ index: 0, codec_type: "video", codec_name: "h264", r_frame_rate: "30/1", ...stream }, { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 }],
      format: { duration: "61.5", size: "1000", bit_rate: "1000" },
    });
  await test("rotation: display-matrix and legacy tag values normalise to 0/90/180/270", () => {
    assert.equal(parseRotationDegrees({}), 0);
    assert.equal(parseRotationDegrees({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }), 270);
    assert.equal(parseRotationDegrees({ side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }] }), 90);
    assert.equal(parseRotationDegrees({ side_data_list: [{ rotation: "-180" }] }), 180);
    assert.equal(parseRotationDegrees({ tags: { rotate: "90" } }), 90);
    assert.equal(parseRotationDegrees({ tags: { rotate: "270" } }), 270);
    assert.equal(parseRotationDegrees({ tags: { rotate: "abc" } }), 0);
    assert.equal(parseRotationDegrees({ side_data_list: [{ side_data_type: "Other" }], tags: { rotate: "90" } }), 90, "falls back to the tag");
  });
  await test("rotation: a phone file coded 1920x1080 with -90° reports DISPLAY 1080x1920 (portrait)", () => {
    const m = parseFfprobeJson(probe({ width: 1920, height: 1080, side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }));
    assert.deepEqual([m.width, m.height], [1080, 1920]);
    assert.deepEqual([m.codedWidth, m.codedHeight, m.rotationDegrees], [1920, 1080, 270]);
    assert.equal(validateSourceMetadata(m).valid, true);
  });
  await test("rotation: 180° and 0° keep dimensions; legacy tag 90 swaps", () => {
    const a = parseFfprobeJson(probe({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }));
    assert.deepEqual([a.width, a.height, a.rotationDegrees], [1920, 1080, 180]);
    const b = parseFfprobeJson(probe({ width: 1080, height: 1080 }));
    assert.deepEqual([b.width, b.height, b.rotationDegrees], [1080, 1080, 0]);
    const c = parseFfprobeJson(probe({ width: 1280, height: 720, tags: { rotate: "90" } }));
    assert.deepEqual([c.width, c.height], [720, 1280]);
  });

  // =========================================================================
  // 3. Output aspect ratio is independent of source orientation
  // =========================================================================
  await test("render graph: output size comes only from the requested aspect ratio (9 combos × 3 source orientations)", () => {
    for (const aspectRatio of Object.keys(CLIPPER_ASPECT_RATIOS) as Array<keyof typeof CLIPPER_ASPECT_RATIOS>) {
      for (const framing of Object.keys(CLIPPER_FRAMING_MODES) as Array<keyof typeof CLIPPER_FRAMING_MODES>) {
        const g = buildClipFilterGraph({ aspectRatio, framing, hasAudio: true, sourceFps: 30 });
        assert.deepEqual([g.width, g.height], [CLIPPER_ASPECT_RATIOS[aspectRatio].width, CLIPPER_ASPECT_RATIOS[aspectRatio].height]);
        // The graph takes no source dimensions at all, so any orientation renders to the same canvas.
        assert.ok(!("sourceWidth" in g));
        assert.match(g.graph, framing === "center_crop" ? /force_original_aspect_ratio=increase,crop=/ : /force_original_aspect_ratio=decrease/);
      }
    }
  });

  // =========================================================================
  // 4. Server: client-chosen upload ids, re-grant, deadline, discard by id, release-pending
  // =========================================================================
  const intentInput = (over: Record<string, unknown> = {}) => ({ mimeType: "video/mp4", sizeBytes: 1_000_000, uploadId: ID, ...over });

  await test("intent: a client upload id is used verbatim inside the caller's own folder", async () => {
    const store = new MemStore();
    const { deps } = uploadDeps(store);
    const r = await createUploadIntent(deps, { userId: USER, input: intentInput() });
    assert.equal(r.uploadKey, KEY);
    assert.equal(r.uploadId, ID);
    assert.equal(r.regranted, false);
    assert.deepEqual(store.log, [`placeholder:${KEY}`, `sign:${KEY}`]);
  });
  await test("intent: malformed client ids are rejected (no path tricks, no uppercase, no other prefixes)", async () => {
    const store = new MemStore();
    const { deps } = uploadDeps(store);
    for (const bad of ["../x", `upl_${"A".repeat(32)}`, `upl_${"a".repeat(31)}`, `job_${"a".repeat(32)}`, `upl_${"a".repeat(32)}/..`, 42]) {
      await assert.rejects(() => createUploadIntent(deps, { userId: USER, input: intentInput({ uploadId: bad }) }), (e: any) => e.code === "INVALID_INPUT", String(bad));
    }
    assert.equal(store.objects.size, 0);
  });
  await test("intent: retry with the SAME id re-grants the same reservation (no second slot, no new placeholder)", async () => {
    const store = new MemStore();
    const { deps } = uploadDeps(store);
    await createUploadIntent(deps, { userId: USER, input: intentInput() });
    store.log = [];
    const again = await createUploadIntent(deps, { userId: USER, input: intentInput() });
    assert.equal(again.regranted, true);
    assert.equal(again.uploadKey, KEY);
    assert.deepEqual(store.log, [`sign:${KEY}`], "no placeholder overwrite (the user's bytes are kept)");
    assert.equal(store.objects.size, 1);
  });
  await test("intent: a DIFFERENT id is still blocked by the one-pending-upload limit (quota not weakened)", async () => {
    const store = new MemStore();
    const { deps } = uploadDeps(store);
    await createUploadIntent(deps, { userId: USER, input: intentInput() });
    await assert.rejects(() => createUploadIntent(deps, { userId: USER, input: intentInput({ uploadId: ID2 }) }), (e: any) => e.code === "UPLOAD_PENDING_EXISTS");
    await assert.rejects(() => createUploadIntent(deps, { userId: USER, input: intentInput({ uploadId: undefined }) }), (e: any) => e.code === "UPLOAD_PENDING_EXISTS");
    assert.equal(store.objects.size, 1);
  });
  await test("intent: re-grant still counts every OTHER pending upload", async () => {
    const store = new MemStore();
    store.objects.set(`ephemeral/users/${USER}/uploads/${ID2}.mp4`, { size: 10, createdAt: T0 });
    store.objects.set(KEY, { size: 0, createdAt: T0 });
    const { deps } = uploadDeps(store);
    await assert.rejects(() => createUploadIntent(deps, { userId: USER, input: intentInput() }), (e: any) => e.code === "UPLOAD_PENDING_EXISTS");
  });
  await test("intent: re-grant refused when the upload was already used by a job, or is in use", async () => {
    const store = new MemStore();
    store.objects.set(KEY, { size: 100, createdAt: T0 });
    const used = uploadDeps(store, {}, [], [KEY]);
    await assert.rejects(() => createUploadIntent(used.deps, { userId: USER, input: intentInput() }), (e: any) => e.code === "UPLOAD_ALREADY_USED");
    const active = uploadDeps(store, {}, [KEY], []);
    await assert.rejects(() => createUploadIntent(active.deps, { userId: USER, input: intentInput() }), (e: any) => e.code === "UPLOAD_ALREADY_USED");
  });
  await test("intent: re-grant refused once the reservation has expired; fails closed without a timestamp", async () => {
    const store = new MemStore();
    store.objects.set(KEY, { size: 0, createdAt: new Date(T0.getTime() - EPHEMERAL_UPLOAD_TTL_SECONDS * 1000) });
    const { deps } = uploadDeps(store);
    await assert.rejects(() => createUploadIntent(deps, { userId: USER, input: intentInput() }), (e: any) => e.code === "UPLOAD_EXPIRED");
    const store2 = new MemStore();
    (store2 as any).listFolder = async () => ({ objects: [{ key: KEY, sizeBytes: 0, createdAt: null, updatedAt: null }], folders: [] });
    await assert.rejects(() => createUploadIntent(uploadDeps(store2).deps, { userId: USER, input: intentInput() }), (e: any) => e.code === "QUOTA_UNVERIFIABLE");
  });
  await test("intent: no reservation is written after the server-side deadline", async () => {
    const store = new MemStore();
    let t = T0.getTime();
    const { deps } = uploadDeps(store, {
      now: () => new Date(t),
      withUserLock: async (_u, fn) => {
        t += CLIPPER_UPLOAD_INTENT_DEADLINE_MS + 1; // lock wait / slow listing
        return fn({ activeSourceKeys: async () => [] });
      },
    });
    await assert.rejects(() => createUploadIntent(deps, { userId: USER, input: intentInput() }), (e: any) => e.code === "STORAGE_UNAVAILABLE");
    assert.equal(store.objects.size, 0, "no placeholder written");
  });
  await test("intent: just inside the deadline the reservation is written", async () => {
    const store = new MemStore();
    let t = T0.getTime();
    const { deps } = uploadDeps(store, {
      now: () => new Date(t),
      withUserLock: async (_u, fn) => {
        t += CLIPPER_UPLOAD_INTENT_DEADLINE_MS;
        return fn({ activeSourceKeys: async () => [] });
      },
    });
    await createUploadIntent(deps, { userId: USER, input: intentInput() });
    assert.equal(store.objects.size, 1);
  });
  await test("intent: the client release delay is longer than the server deadline (ordering guarantee)", () => {
    assert.ok(CLIPPER_UPLOAD_ID_RELEASE_DELAY_MS > CLIPPER_UPLOAD_INTENT_DEADLINE_MS + 10_000);
  });
  await test("discard by id: builds the key in the caller's folder; another user's id cannot reach their folder", async () => {
    assert.equal(resolveDiscardTarget(USER, { uploadId: ID, mimeType: "video/mp4" }), KEY);
    assert.equal(resolveDiscardTarget(USER, { uploadId: ID, mimeType: "video/quicktime" }), `ephemeral/users/${USER}/uploads/${ID}.mov`);
    assert.equal(resolveDiscardTarget(OTHER, { uploadId: ID, mimeType: "video/mp4" }), `ephemeral/users/${OTHER}/uploads/${ID}.mp4`);
    assert.throws(() => resolveDiscardTarget(USER, { uploadKey: `ephemeral/users/${OTHER}/uploads/${ID}.mp4` }), (e: any) => e.code === "UPLOAD_NOT_FOUND");
    assert.throws(() => resolveDiscardTarget(USER, { uploadId: "../x", mimeType: "video/mp4" }), (e: any) => e.code === "INVALID_INPUT");
    assert.throws(() => resolveDiscardTarget(USER, { uploadId: ID, mimeType: "image/png" }), (e: any) => e.code === "INVALID_INPUT");
    assert.throws(() => resolveDiscardTarget(USER, {}), (e: any) => e.code === "INVALID_INPUT");
  });
  await test("discard by id: deletes the reservation under the user lock; refuses when an active job uses it", async () => {
    const store = new MemStore();
    store.objects.set(KEY, { size: 0, createdAt: T0 });
    const { deps, locks } = uploadDeps(store);
    assert.deepEqual(await discardUpload(deps, { userId: USER, uploadId: ID, mimeType: "video/mp4" }), { deleted: true });
    assert.equal(store.objects.size, 0);
    assert.equal(locks(), 1);
    store.objects.set(KEY, { size: 10, createdAt: T0 });
    const busy = uploadDeps(store, {}, [KEY]);
    await assert.rejects(() => discardUpload(busy.deps, { userId: USER, uploadId: ID, mimeType: "video/mp4" }), (e: any) => e.code === "UPLOAD_IN_USE");
    assert.equal(store.objects.size, 1);
  });
  await test("release-pending: deletes only the caller's unused uploads; keeps in-use ones", async () => {
    const store = new MemStore();
    const inUse = `ephemeral/users/${USER}/uploads/${ID2}.mp4`;
    store.objects.set(KEY, { size: 0, createdAt: T0 });
    store.objects.set(inUse, { size: 10, createdAt: T0 });
    store.objects.set(`ephemeral/users/${OTHER}/uploads/${ID}.mp4`, { size: 0, createdAt: T0 });
    const { deps } = uploadDeps(store, {}, [inUse]);
    assert.deepEqual(await releasePendingUploads(deps, { userId: USER }), { released: 1, kept: 1 });
    assert.deepEqual([...store.objects.keys()].sort(), [inUse, `ephemeral/users/${OTHER}/uploads/${ID}.mp4`].sort());
  });
  await test("release-pending: listing failure deletes nothing (fails closed)", async () => {
    const store = new MemStore();
    store.objects.set(KEY, { size: 0, createdAt: T0 });
    store.failList = true;
    await assert.rejects(() => releasePendingUploads(uploadDeps(store).deps, { userId: USER }), (e: any) => e.code === "QUOTA_UNVERIFIABLE");
    assert.equal(store.objects.size, 1);
  });
  await test("release-pending: after release a new reservation succeeds", async () => {
    const store = new MemStore();
    const { deps } = uploadDeps(store);
    await createUploadIntent(deps, { userId: USER, input: intentInput() });
    await releasePendingUploads(deps, { userId: USER });
    const r = await createUploadIntent(deps, { userId: USER, input: intentInput({ uploadId: ID2 }) });
    assert.equal(r.regranted, false);
  });

  // =========================================================================
  // 5. HTTP: discard by id, release-pending route, not gated by the switch
  // =========================================================================
  const ORIGIN = "https://app.yourai.test";
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  function handlers(store: MemStore, enabled = false) {
    const { deps } = uploadDeps(store);
    return createClipperHandlers({
      getUserId: async () => USER,
      trustedOrigins: () => [ORIGIN],
      uploads: deps,
      jobs: { uploads: deps, loadPlatformVideoAsset: async () => null, findJobByIdempotencyKey: async () => null, createJob: (async () => { throw new Error("no"); }) as any },
      loadJob: async () => null,
      loadBalance: async () => 0,
      signAsset: async () => "",
      submissionsEnabled: () => enabled,
      cancelJob: async () => ({ outcome: "not_found" as const }),
      signDownload: async () => null,
      log: { error: () => {} },
    });
  }
  await test("http: discard accepts {uploadId, mimeType} while submissions are OFF", async () => {
    const store = new MemStore();
    store.objects.set(KEY, { size: 0, createdAt: T0 });
    const res = await handlers(store).postUploadDiscard(post("/api/clipper/uploads/discard", { uploadId: ID, mimeType: "video/mp4" }));
    assert.equal(res.status, 200);
    assert.equal(store.objects.size, 0);
  });
  await test("http: release-pending → 200 {released, kept}; foreign origin 403; not gated by the switch", async () => {
    const store = new MemStore();
    store.objects.set(KEY, { size: 0, createdAt: T0 });
    const h = handlers(store, false);
    assert.equal((await h.postReleasePendingUploads(post("/api/clipper/uploads/release-pending", {}, { origin: "https://evil.example" }))).status, 403);
    const res = await h.postReleasePendingUploads(post("/api/clipper/uploads/release-pending", {}));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { released: 1, kept: 0 });
  });
  await test("http: intent with a client id when ON returns it; malformed id → 400", async () => {
    const store = new MemStore();
    const h = handlers(store, true);
    const ok = await h.postUploadIntent(post("/api/clipper/uploads", intentInput()));
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).upload.uploadId, ID);
    const bad = await h.postUploadIntent(post("/api/clipper/uploads", intentInput({ uploadId: "../../x" })));
    assert.equal(bad.status, 400);
  });

  // =========================================================================
  // 6. Client: lost reservation response
  // =========================================================================
  class Mem {
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
  const err = (code: string, status: number | null) => ({ ok: false as const, error: { code, message: code, status, retryAfterSeconds: null } });
  const intentOk = () => ok({ upload: { uploadKey: KEY, uploadId: ID, signedUrl: "https://proj.supabase.co/up", contentType: "video/mp4", maxBytes: 1, expiresAt: "" } }, 201);
  const view = (status: string) => ({ id: "job_view000001", status, createdAt: T0.toISOString(), startedAt: null, completedAt: null, aspectRatio: "9:16", framing: "fit", requestedClips: 1, credits: { estimated: 5, charged: 0 }, analysis: { highlightMode: "scene_pacing", speechAnalysis: "unavailable", captions: "unavailable", originalAudio: "preserved" }, error: null, clips: [] });

  function ctl(apiOver: Record<string, unknown>, opts: { storage?: Mem; nowMs?: () => number; lock?: any } = {}) {
    const log: string[] = [];
    const sleeps: number[] = [];
    const storage = opts.storage ?? new Mem();
    const api = {
      requestUploadIntent: async (i: any) => (log.push(`intent:${i.uploadId}`), intentOk()),
      completeUpload: async () => ok({ upload: { uploadKey: KEY, sizeBytes: 10, container: "mp4" } }),
      discardUpload: async (t: any) => (log.push(`discard:${typeof t === "string" ? t : `${t.uploadId}|${t.mimeType}`}`), ok({ deleted: true as const })),
      postClipJob: async () => ok({ job: view("COMPLETED"), replayed: false, balance: 0 }, 202),
      getClipJob: async () => ok({ job: view("COMPLETED"), replayed: false, balance: 0 }),
      releasePendingUploads: async () => (log.push("release-pending"), ok({ released: 1, kept: 0 })),
      ...apiOver,
    };
    const c = createClipperController({
      userId: USER,
      storage,
      api: api as any,
      upload: async () => ({ ok: true as const }),
      uploadLock: opts.lock ?? null,
      now: opts.nowMs ?? (() => T0.getTime()),
      sleep: async (ms) => void sleeps.push(ms),
      newKey: () => "clip-testkey000001",
      newUploadId: () => ID,
    });
    return { c, log, sleeps, storage };
  }
  const input = () => ({ file: new Blob(["v"], { type: "video/mp4" }), hints: { durationSeconds: 60 }, options: { aspectRatio: "9:16" as const, framing: "fit" as const, clipCount: 1 } });
  const flush = () => new Promise((r) => setTimeout(r, 10));

  await test("client: the upload id is persisted BEFORE the reservation request is sent", async () => {
    let seen: any = null;
    const { c, storage } = ctl({
      requestUploadIntent: async () => {
        seen = readReservation(storage as any, USER);
        return intentOk();
      },
    });
    await c.startUpload(input());
    assert.equal(seen?.uploadId, ID);
    assert.equal(seen?.mimeType, "video/mp4");
    assert.equal(seen?.uploadKey, undefined, "key not known yet");
  });
  await test("client: lost response (network error ×3) → retries with the SAME id, then releases by id after the safe delay", async () => {
    const ids: string[] = [];
    const { c, log, sleeps, storage } = ctl({ requestUploadIntent: async (i: any) => (ids.push(i.uploadId), err("NETWORK_ERROR", null)) });
    await c.startUpload(input());
    await flush();
    assert.deepEqual(ids, [ID, ID, ID], "same id on every retry");
    assert.equal(c.getState().phase, "failed");
    assert.ok(log.includes(`discard:${ID}|video/mp4`), "released by id");
    assert.ok(sleeps.includes(CLIPPER_UPLOAD_ID_RELEASE_DELAY_MS), "waited the full release delay before releasing");
    assert.equal(readReservation(storage as any, USER), null);
  });
  await test("client: ambiguous first attempt, then success → same reservation used, nothing released", async () => {
    let n = 0;
    const { c, log } = ctl({ requestUploadIntent: async (i: any) => (log.push(`intent:${i.uploadId}`), ++n === 1 ? err("INTERNAL_ERROR", 500) : intentOk()) });
    await c.startUpload(input());
    await flush();
    assert.deepEqual(log.filter((l) => l.startsWith("intent")), [`intent:${ID}`, `intent:${ID}`]);
    assert.ok(!log.some((l) => l.startsWith("discard")));
    assert.equal(c.getState().phase, "completed");
  });
  await test("client: definitive rejection (409 pending exists) → no release call, record cleared", async () => {
    const { c, log, storage } = ctl({ requestUploadIntent: async () => err("UPLOAD_PENDING_EXISTS", 409) });
    await c.startUpload(input());
    await flush();
    assert.ok(!log.some((l) => l.startsWith("discard")));
    assert.equal(readReservation(storage as any, USER), null);
    assert.equal((c.getState() as any).error.code, "UPLOAD_PENDING_EXISTS");
  });
  await test("client: once the key arrives it is added to the record (key-based release from then on)", async () => {
    let seen: any = null;
    const s = new Mem();
    const c2 = ctl({ completeUpload: async () => ((seen = readReservation(s as any, USER)), err("UPLOAD_INVALID_CONTAINER", 415)) }, { storage: s });
    await c2.c.startUpload(input());
    assert.equal(seen?.uploadKey, KEY);
    assert.equal(seen?.uploadId, ID);
    assert.ok(c2.log.includes(`discard:${KEY}`));
  });
  await test("recover: an id-only record (response never arrived) is released by id after the remaining delay", async () => {
    const storage = new Mem();
    const sentAt = T0.getTime() - 10_000;
    writeReservation(storage as any, USER, { v: 1, uploadId: ID, mimeType: "video/mp4", createdAt: sentAt });
    const { c, log, sleeps } = ctl({}, { storage });
    await c.recover();
    await flush();
    assert.deepEqual(sleeps, [CLIPPER_UPLOAD_ID_RELEASE_DELAY_MS - 10_000]);
    assert.deepEqual(log, [`discard:${ID}|video/mp4`]);
    assert.equal(readReservation(storage as any, USER), null);
    assert.equal(c.getState().phase, "idle", "recovery did not block the page");
  });
  await test("recover: an old id-only record is released immediately (no wait)", async () => {
    const storage = new Mem();
    writeReservation(storage as any, USER, { v: 1, uploadId: ID, mimeType: "video/mp4", createdAt: T0.getTime() - 10 * 60_000 });
    const { c, log, sleeps } = ctl({}, { storage });
    await c.recover();
    await flush();
    assert.deepEqual(sleeps, []);
    assert.deepEqual(log, [`discard:${ID}|video/mp4`]);
  });
  await test("recover: an id-only record held by another tab is NOT released", async () => {
    const storage = new Mem();
    writeReservation(storage as any, USER, { v: 1, uploadId: ID, mimeType: "video/mp4", createdAt: T0.getTime() - 10 * 60_000 });
    const { c, log } = ctl({}, { storage, lock: { run: (f: any) => f(), isHeld: async () => true } });
    await c.recover();
    await flush();
    assert.deepEqual(log, []);
    assert.equal(readReservation(storage as any, USER)?.uploadId, ID);
  });
  await test("recover: a failed id release keeps the record for the next load", async () => {
    const storage = new Mem();
    writeReservation(storage as any, USER, { v: 1, uploadId: ID, mimeType: "video/mp4", createdAt: 0 });
    const { c } = ctl({ discardUpload: async () => err("NETWORK_ERROR", null) }, { storage });
    await c.recover();
    await flush();
    assert.equal(readReservation(storage as any, USER)?.uploadId, ID);
  });
  await test("client: releasePending() calls the endpoint and clears the local record", async () => {
    const storage = new Mem();
    writeReservation(storage as any, USER, { v: 1, uploadId: ID, mimeType: "video/mp4", createdAt: 0 });
    const { c, log } = ctl({}, { storage });
    const r = await c.releasePending();
    assert.deepEqual(r, { ok: true, released: 1 });
    assert.deepEqual(log, ["release-pending"]);
    assert.equal(readReservation(storage as any, USER), null);
  });
  await test("client: generated upload ids always match the server format", () => {
    for (let i = 0; i < 50; i++) assert.match(newUploadId(), /^upl_[a-f0-9]{32}$/);
    assert.match(newUploadId(() => "ABC-def"), /^upl_[a-f0-9]{32}$/);
  });

  // =========================================================================
  // 7. Defect found by the isolated browser E2E: readPrefix hung on a tee'd body (Next.js fetch)
  // =========================================================================
  await test("readPrefix returns promptly when the response body is a tee'd branch (Next.js patched fetch)", async () => {
    const { SupabaseClipperStorage } = await import("../src/features/clipper/storage/supabase-clipper");
    const original = globalThis.fetch;
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      const src = new ReadableStream<Uint8Array>({
        start(c) {
          // More bytes than requested and still open (the network body is not finished).
          c.enqueue(new Uint8Array(128).fill(7));
        },
      });
      const [branch] = src.tee(); // the other branch is never read or cancelled, like Next's cache clone
      return new Response(branch, { status: 206 });
    }) as typeof fetch;
    try {
      const client = { storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://proj.supabase.co/x?token=t" }, error: null }) }) } };
      const st = new SupabaseClipperStorage(client as any, "b", "https://proj.supabase.co");
      const result = await Promise.race([st.readPrefix("k", 64), new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 2000))]);
      assert.notEqual(result, "TIMEOUT", "readPrefix must not wait for the tee'd branch to be cancelled");
      assert.equal((result as Buffer).length, 64);
      assert.equal(seen[0].cache, "no-store", "opts out of the Next.js fetch data cache");
    } finally {
      globalThis.fetch = original;
    }
  });

  console.log(`\n  Tests Passed: ${passed}\n  Tests Failed: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Unhandled test error:", e);
  process.exit(1);
});
