/**
 * Stage 9 — Batch 5: Upload workflow, quota (fail-closed + concurrency), clip job API, job view,
 * maintenance cron (stale jobs, cleanup retries, abandoned uploads), worker loop, scene/pacing
 * planner and browser client controller.
 *
 * Offline: ZERO network calls, ZERO database access, ZERO storage mutations. Storage, database,
 * FFmpeg and the browser are all simulated.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";

import * as clipperNs from "../src/features/clipper/index";
import * as clientNs from "../src/features/clipper/client/index";
const clipper = ((clipperNs as any).default ?? clipperNs) as typeof clipperNs;
const client = ((clientNs as any).default ?? clientNs) as typeof clientNs;

const {
  CLIPPER_ANALYSIS_CAPABILITIES,
  CLIPPER_ASPECT_RATIOS,
  EPHEMERAL_UPLOAD_TTL_SECONDS,
  CLIPPER_UPLOAD_USE_MARGIN_SECONDS,
  getClipperMaxUploadBytes,
  listUserUploadsStrict,
  evaluateUploadQuota,
  createUploadIntent,
  verifyUpload,
  discardUpload,
  ClipperUploadError,
  parseClipJobRequest,
  createClipJobFromRequest,
  toClipJobView,
  parseFailureCode,
  createClipperHandlers,
  sweepAbandonedUploads,
  runClipperMaintenance,
  isAuthorizedCronRequest,
  createClipperCronHandler,
  retryClipperPendingCleanups,
  MAX_CLEANUP_ATTEMPTS_PER_KEY,
  planScenePacingClips,
  SPEECH_ANALYSIS_UNAVAILABLE,
  runClipperWorkerLoop,
  isProcessableSettings,
  MockProcessRunner,
  FfmpegClipperEngine,
  JobNotCompletableError,
} = clipper;

const {
  createClipperController,
  readPending,
  writePending,
  pendingKey,
  CLIP_REPLAY_WINDOW_MS,
  uploadToSignedUrl,
} = client;

type ClipperStorage = clipperNs.ClipperStorage;
type StoredObjectInfo = clipperNs.StoredObjectInfo;
type ClipperUploadDeps = clipperNs.ClipperUploadDeps;
type ClipperJobSettings = clipperNs.ClipperJobSettings;
type ClipperWorkerLifecycle = clipperNs.ClipperWorkerLifecycle;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`FAIL  ${name}\n      ${err?.stack ?? err}`);
    failed++;
  }
}

const rejectsCode = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: any) => {
    assert.equal(e?.code, code);
    return true;
  });

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
const USER = "usr_b5user0001";
const OTHER = "usr_b5other001";
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(52)]);
const WEBM_HEAD = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]);

interface FakeObj { size: number | null; createdAt: Date | null; updatedAt: Date | null; head?: Buffer }

function fakeStorage(o: {
  now?: () => Date;
  listError?: boolean | ((prefix: string) => boolean);
  listHang?: boolean;
  placeholderError?: boolean;
  signError?: boolean;
  infoError?: boolean;
  deleteError?: (key: string) => boolean;
  extraFolders?: string[];
} = {}) {
  const objects = new Map<string, FakeObj>();
  const calls: string[] = [];
  const now = o.now ?? (() => new Date());
  const storage: ClipperStorage = {
    async listFolder(prefix, page) {
      calls.push(`list:${prefix}:${page.offset}`);
      if (o.listHang) return new Promise(() => {});
      if (o.listError === true || (typeof o.listError === "function" && o.listError(prefix))) throw new Error("list failed");
      const objs: StoredObjectInfo[] = [];
      const folders = new Set<string>();
      for (const [key, v] of [...objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!key.startsWith(prefix + "/")) continue;
        const rest = key.slice(prefix.length + 1);
        if (rest.includes("/")) folders.add(rest.split("/")[0]);
        else objs.push({ key, sizeBytes: v.size, createdAt: v.createdAt, updatedAt: v.updatedAt });
      }
      for (const f of o.extraFolders ?? []) if (prefix.endsWith("/uploads")) folders.add(f);
      const all = [...[...folders].map((f) => ({ folder: f })), ...objs.map((x) => ({ obj: x }))];
      const slice = all.slice(page.offset, page.offset + page.limit);
      return {
        folders: slice.filter((s): s is { folder: string } => "folder" in s).map((s) => s.folder),
        objects: slice.filter((s): s is { obj: StoredObjectInfo } => "obj" in s).map((s) => s.obj),
      };
    },
    async putPlaceholder(key) {
      calls.push(`placeholder:${key}`);
      if (o.placeholderError) throw new Error("placeholder failed");
      if (objects.has(key)) throw new Error("exists");
      const t = now();
      objects.set(key, { size: 0, createdAt: t, updatedAt: t });
    },
    async createSignedUploadUrl(key) {
      calls.push(`sign-upload:${key}`);
      if (o.signError) throw new Error("sign failed");
      return { signedUrl: `https://proj.supabase.co/storage/v1/object/upload/sign/b/${key}?token=t`, key };
    },
    async info(key) {
      calls.push(`info:${key}`);
      if (o.infoError) throw new Error("info failed");
      const v = objects.get(key);
      return v ? { key, sizeBytes: v.size, createdAt: v.createdAt, updatedAt: v.updatedAt } : null;
    },
    async readPrefix(key, length) {
      calls.push(`read:${key}`);
      return (objects.get(key)?.head ?? Buffer.alloc(0)).subarray(0, length);
    },
    async openDownloadStream(key) {
      calls.push(`download:${key}`);
      return Readable.from([objects.get(key)?.head ?? Buffer.alloc(0)]);
    },
    async createSignedUrl(key) {
      return `https://proj.supabase.co/storage/v1/object/sign/b/${key}?token=x`;
    },
    async putStream(key, stream, options) {
      let n = 0;
      for await (const c of stream as AsyncIterable<Buffer>) n += c.length;
      objects.set(key, { size: n, createdAt: now(), updatedAt: now() });
      return { sizeBytes: options.contentLength };
    },
    async delete(key) {
      calls.push(`delete:${key}`);
      if (o.deleteError?.(key)) throw new Error("delete failed");
      objects.delete(key);
    },
  };
  const put = (key: string, v: Partial<FakeObj> = {}) => {
    const t = now();
    objects.set(key, { size: 1000, createdAt: t, updatedAt: t, head: MP4_HEAD, ...v });
  };
  return { storage, objects, calls, put };
}

/** Real async mutex per user — models the User row lock. */
function mutexLock(activeKeys: () => string[] = () => []) {
  const tails = new Map<string, Promise<void>>();
  let maxConcurrent = 0;
  let current = 0;
  const withUserLock: ClipperUploadDeps["withUserLock"] = async (userId, fn) => {
    const prev = tails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    tails.set(userId, prev.then(() => mine));
    await prev;
    current++;
    maxConcurrent = Math.max(maxConcurrent, current);
    try {
      return await fn({ activeSourceKeys: async () => activeKeys() });
    } finally {
      current--;
      release();
    }
  };
  return { withUserLock, stats: () => ({ maxConcurrent }) };
}

const noLock: ClipperUploadDeps["withUserLock"] = (_u, fn) => fn({ activeSourceKeys: async () => [] });
const tick = () => new Promise((r) => setTimeout(r, 0));

function uploadDeps(s: ReturnType<typeof fakeStorage>, extra: Partial<ClipperUploadDeps> = {}): ClipperUploadDeps {
  return { storage: s.storage, withUserLock: mutexLock().withUserLock, isSourceKeyReferenced: async () => false, storageTimeoutMs: 200, ...extra };
}

const upKey = (id: string, ext = "mp4", user = USER) => `ephemeral/users/${user}/uploads/${id}.${ext}`;

// ===========================================================================
async function run() {
  console.log("\n=======================================================");
  console.log("  Stage 9 - Batch 5: Upload, API, Maintenance & Worker");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------------
  console.log("# 1. Quota listing fails CLOSED");
  await test("empty folder lists as zero objects (complete listing)", async () => {
    const s = fakeStorage();
    assert.deepEqual(await listUserUploadsStrict(s.storage, USER, { timeoutMs: 100 }), []);
  });
  await test("listing error -> QUOTA_UNVERIFIABLE (never zero usage)", async () => {
    await rejectsCode(listUserUploadsStrict(fakeStorage({ listError: true }).storage, USER, { timeoutMs: 100 }), "QUOTA_UNVERIFIABLE");
  });
  await test("listing timeout -> QUOTA_UNVERIFIABLE", async () => {
    await rejectsCode(listUserUploadsStrict(fakeStorage({ listHang: true }).storage, USER, { timeoutMs: 30 }), "QUOTA_UNVERIFIABLE");
  });
  await test("missing object size -> QUOTA_UNVERIFIABLE", async () => {
    const s = fakeStorage();
    s.put(upKey("upl_nosize0001"), { size: null });
    await rejectsCode(listUserUploadsStrict(s.storage, USER, { timeoutMs: 100 }), "QUOTA_UNVERIFIABLE");
  });
  await test("unexpected sub-folder -> QUOTA_UNVERIFIABLE", async () => {
    await rejectsCode(listUserUploadsStrict(fakeStorage({ extraFolders: ["nested"] }).storage, USER, { timeoutMs: 100 }), "QUOTA_UNVERIFIABLE");
  });
  await test("reaching the object ceiling (completeness unprovable) -> QUOTA_UNVERIFIABLE", async () => {
    const s = fakeStorage();
    for (let i = 0; i < 5; i++) s.put(upKey(`upl_many000${i}`));
    await rejectsCode(listUserUploadsStrict(s.storage, USER, { timeoutMs: 100, maxObjects: 5, pageSize: 2 }), "QUOTA_UNVERIFIABLE");
  });
  await test("multi-page listing is followed to completion", async () => {
    const s = fakeStorage();
    for (let i = 0; i < 5; i++) s.put(upKey(`upl_page0000${i}`));
    const objs = await listUserUploadsStrict(s.storage, USER, { timeoutMs: 100, maxObjects: 20, pageSize: 2 });
    assert.equal(objs.length, 5);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 2. Quota evaluation");
  const MAX = getClipperMaxUploadBytes();
  await test("one pending upload blocks another", () => {
    assert.throws(
      () => evaluateUploadQuota({ objects: [{ key: upKey("upl_pending001"), sizeBytes: 10, createdAt: null, updatedAt: null }], activeSourceKeys: [], declaredSizeBytes: 10 }),
      (e: any) => e.code === "UPLOAD_PENDING_EXISTS",
    );
  });
  await test("upload attached to an active job is not 'pending' but still counts toward bytes", () => {
    const k = upKey("upl_active0001");
    const r = evaluateUploadQuota({ objects: [{ key: k, sizeBytes: 100, createdAt: null, updatedAt: null }], activeSourceKeys: [k], declaredSizeBytes: 10 });
    assert.deepEqual(r.pendingKeys, []);
    assert.equal(r.reservedBytes, 100);
  });
  await test("empty placeholder reserves the maximum upload size", () => {
    const k = upKey("upl_placehold1");
    const r = evaluateUploadQuota({ objects: [{ key: k, sizeBytes: 0, createdAt: null, updatedAt: null }], activeSourceKeys: [k], declaredSizeBytes: 1 });
    assert.equal(r.reservedBytes, MAX);
  });
  await test("staging byte quota enforced", () => {
    const k = upKey("upl_big000001");
    assert.throws(
      () => evaluateUploadQuota({ objects: [{ key: k, sizeBytes: 190 * 1024 * 1024, createdAt: null, updatedAt: null }], activeSourceKeys: [k], declaredSizeBytes: 20 * 1024 * 1024 }),
      (e: any) => e.code === "STAGING_QUOTA_EXCEEDED",
    );
  });

  // -------------------------------------------------------------------------
  console.log("\n# 3. Upload intent (reservation + signed URL)");
  await test("validates type and size (50 MB default limit)", async () => {
    const s = fakeStorage();
    assert.equal(MAX, 50 * 1024 * 1024);
    await rejectsCode(createUploadIntent(uploadDeps(s), { userId: USER, input: { mimeType: "image/png", sizeBytes: 10 } }), "INVALID_INPUT");
    await rejectsCode(createUploadIntent(uploadDeps(s), { userId: USER, input: { mimeType: "video/mp4", sizeBytes: MAX + 1 } }), "UPLOAD_TOO_LARGE");
    await rejectsCode(createUploadIntent(uploadDeps(s), { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 0 } }), "INVALID_INPUT");
    assert.equal(s.objects.size, 0);
  });
  await test("success: placeholder written inside the lock, then a URL bound to an owned key", async () => {
    const s = fakeStorage();
    const intent = await createUploadIntent(uploadDeps(s), { userId: USER, input: { mimeType: "video/webm", sizeBytes: 1000 } });
    assert.ok(intent.uploadKey.startsWith(`ephemeral/users/${USER}/uploads/upl_`));
    assert.ok(intent.uploadKey.endsWith(".webm"));
    assert.equal(s.objects.get(intent.uploadKey)?.size, 0);
    assert.ok(s.calls.indexOf(`placeholder:${intent.uploadKey}`) < s.calls.indexOf(`sign-upload:${intent.uploadKey}`));
    assert.equal(intent.maxBytes, MAX);
  });
  await test("listing failure: fails closed, no placeholder, no URL", async () => {
    const s = fakeStorage({ listError: true });
    await rejectsCode(createUploadIntent(uploadDeps(s), { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 10 } }), "QUOTA_UNVERIFIABLE");
    assert.equal(s.calls.some((c) => c.startsWith("placeholder") || c.startsWith("sign-upload")), false);
  });
  await test("placeholder failure -> STORAGE_UNAVAILABLE, no URL issued", async () => {
    const s = fakeStorage({ placeholderError: true });
    await rejectsCode(createUploadIntent(uploadDeps(s), { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 10 } }), "STORAGE_UNAVAILABLE");
    assert.equal(s.calls.some((c) => c.startsWith("sign-upload")), false);
  });
  await test("signed-URL failure releases the reservation", async () => {
    const s = fakeStorage({ signError: true });
    await rejectsCode(createUploadIntent(uploadDeps(s), { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 10 } }), "STORAGE_UNAVAILABLE");
    assert.equal(s.objects.size, 0);
  });
  await test("a second (sequential) intent sees the first reservation and is rejected", async () => {
    const s = fakeStorage();
    const deps = uploadDeps(s);
    await createUploadIntent(deps, { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 10 } });
    await rejectsCode(createUploadIntent(deps, { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 10 } }), "UPLOAD_PENDING_EXISTS");
  });
  await test("CONCURRENT intents under the per-user lock: exactly one succeeds", async () => {
    const s = fakeStorage();
    const lock = mutexLock();
    const deps = uploadDeps(s, { withUserLock: lock.withUserLock });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createUploadIntent(deps, { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 10 } })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results.filter((r) => r.status === "rejected")) assert.equal((r as PromiseRejectedResult).reason.code, "UPLOAD_PENDING_EXISTS");
    assert.equal(lock.stats().maxConcurrent, 1);
    assert.equal([...s.objects.keys()].length, 1);
  });
  await test("control: WITHOUT the lock, concurrent intents would bypass the limit (lock is load-bearing)", async () => {
    const s = fakeStorage();
    const slowList = s.storage.listFolder.bind(s.storage);
    s.storage.listFolder = async (p, pg) => {
      const r = await slowList(p, pg);
      await tick();
      return r;
    };
    const deps = uploadDeps(s, { withUserLock: noLock });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => createUploadIntent(deps, { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 10 } })),
    );
    assert.ok(results.filter((r) => r.status === "fulfilled").length > 1);
  });
  await test("different users do not block each other", async () => {
    const s = fakeStorage();
    const deps = uploadDeps(s);
    await createUploadIntent(deps, { userId: USER, input: { mimeType: "video/mp4", sizeBytes: 10 } });
    await createUploadIntent(deps, { userId: OTHER, input: { mimeType: "video/mp4", sizeBytes: 10 } });
    assert.equal(s.objects.size, 2);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 4. Upload verification & discard");
  const NOW = new Date("2026-11-11T12:00:00Z");
  const clock = () => NOW;
  const vdeps = (s: ReturnType<typeof fakeStorage>) => ({ storage: s.storage, now: clock, storageTimeoutMs: 100 });
  await test("valid MP4 upload verifies with real size and container", async () => {
    const s = fakeStorage({ now: clock });
    s.put(upKey("upl_valid00001"), { size: 5000 });
    const v = await verifyUpload(vdeps(s), { userId: USER, uploadKey: upKey("upl_valid00001") });
    assert.equal(v.sizeBytes, 5000);
    assert.equal(v.container, "mp4");
  });
  const verifyCases: Array<[string, (s: ReturnType<typeof fakeStorage>) => unknown, string]> = [
    ["another user's key", (s) => (s.put(upKey("upl_other0001", "mp4", OTHER)), upKey("upl_other0001", "mp4", OTHER)), "UPLOAD_NOT_FOUND"],
    ["traversal / malformed key", () => `ephemeral/users/${USER}/uploads/../../x.mp4`, "UPLOAD_NOT_FOUND"],
    ["missing object", () => upKey("upl_missing001"), "UPLOAD_NOT_FOUND"],
    ["placeholder not yet uploaded", (s) => (s.put(upKey("upl_empty0001"), { size: 0 }), upKey("upl_empty0001")), "UPLOAD_INCOMPLETE"],
    ["oversize object", (s) => (s.put(upKey("upl_huge00001"), { size: MAX + 1 }), upKey("upl_huge00001")), "UPLOAD_TOO_LARGE"],
    ["expired (past TTL minus margin)", (s) => (s.put(upKey("upl_old000001"), { createdAt: new Date(NOW.getTime() - (EPHEMERAL_UPLOAD_TTL_SECONDS - CLIPPER_UPLOAD_USE_MARGIN_SECONDS + 1) * 1000) }), upKey("upl_old000001")), "UPLOAD_EXPIRED"],
    ["missing timestamps fail closed", (s) => (s.put(upKey("upl_notime001"), { createdAt: null, updatedAt: null }), upKey("upl_notime001")), "STORAGE_UNAVAILABLE"],
    ["not a video (extension not trusted)", (s) => (s.put(upKey("upl_text00001"), { head: Buffer.from("#!/bin/sh\nrm -rf /\n".padEnd(64)) }), upKey("upl_text00001")), "UPLOAD_INVALID_CONTAINER"],
    ["container/extension mismatch (.webm holding MP4)", (s) => (s.put(upKey("upl_mism00001", "webm")), upKey("upl_mism00001", "webm")), "UPLOAD_INVALID_CONTAINER"],
  ];
  for (const [name, setup, code] of verifyCases) {
    await test(`verify rejects: ${name}`, async () => {
      const s = fakeStorage({ now: clock });
      const key = setup(s);
      await rejectsCode(verifyUpload(vdeps(s), { userId: USER, uploadKey: key }), code);
    });
  }
  await test("verify accepts WebM in a .webm key", async () => {
    const s = fakeStorage({ now: clock });
    s.put(upKey("upl_webm00001", "webm"), { head: WEBM_HEAD });
    assert.equal((await verifyUpload(vdeps(s), { userId: USER, uploadKey: upKey("upl_webm00001", "webm") })).container, "webm");
  });
  await test("storage info failure -> STORAGE_UNAVAILABLE (fail closed)", async () => {
    const s = fakeStorage({ now: clock, infoError: true });
    await rejectsCode(verifyUpload(vdeps(s), { userId: USER, uploadKey: upKey("upl_any000001") }), "STORAGE_UNAVAILABLE");
  });
  await test("discard: refuses an upload used by an active job; deletes an idle one; rejects foreign keys", async () => {
    const s = fakeStorage();
    const k = upKey("upl_discard01");
    s.put(k);
    await rejectsCode(discardUpload(uploadDeps(s, { withUserLock: mutexLock(() => [k]).withUserLock }), { userId: USER, uploadKey: k }), "UPLOAD_IN_USE");
    assert.ok(s.objects.has(k));
    await discardUpload(uploadDeps(s), { userId: USER, uploadKey: k });
    assert.equal(s.objects.has(k), false);
    await rejectsCode(discardUpload(uploadDeps(s), { userId: OTHER, uploadKey: k }), "UPLOAD_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  console.log("\n# 5. Clip job request parsing & creation");
  const goodBody = (uploadKey: string) => ({ source: { type: "upload", uploadKey }, aspectRatio: "9:16", framing: "pillarbox_blur", clipCount: 2, hints: { durationSeconds: 120, width: 1920, height: 1080 } });
  await test("captions requested -> CAPTIONS_UNAVAILABLE (explicit, not silently ignored)", () => {
    assert.throws(() => parseClipJobRequest({ ...goodBody(upKey("upl_x0000001")), burnSubtitles: true }), (e: any) => e.code === "CAPTIONS_UNAVAILABLE");
  });
  await test("strict validation: aspect, framing, clip count, duration hint", () => {
    const b = goodBody(upKey("upl_x0000001"));
    for (const [patch, code] of [
      [{ aspectRatio: "4:3" }, "INVALID_INPUT"],
      [{ framing: "zoom" }, "INVALID_INPUT"],
      [{ clipCount: 4 }, "INVALID_INPUT"],
      [{ clipCount: 1.5 }, "INVALID_INPUT"],
      [{ hints: { durationSeconds: 5 } }, "SOURCE_DURATION_OUT_OF_RANGE"],
      [{ hints: {} }, "INVALID_INPUT"],
      [{ source: { type: "url", url: "https://youtube.com/x" } }, "INVALID_INPUT"],
    ] as const) {
      assert.throws(() => parseClipJobRequest({ ...b, ...patch }), (e: any) => e.code === code, JSON.stringify(patch));
    }
  });

  function jobDeps(s: ReturnType<typeof fakeStorage>, over: Partial<clipperNs.ClipJobDeps> = {}) {
    const created: any[] = [];
    const deps: clipperNs.ClipJobDeps = {
      uploads: { storage: s.storage, now: clock, storageTimeoutMs: 100, isSourceKeyReferenced: async () => false },
      loadPlatformVideoAsset: async () => null,
      findJobByIdempotencyKey: async () => null,
      createJob: async (input, overrides) => {
        created.push({ input, overrides });
        return { job: { id: "job_created0001" } as any, replayed: false };
      },
      ...over,
    };
    return { deps, created };
  }

  await test("upload source: verified, captions off, audio decided by worker, capabilities persisted", async () => {
    const s = fakeStorage({ now: clock });
    const k = upKey("upl_job000001");
    s.put(k, { size: 4321 });
    const { deps, created } = jobDeps(s);
    await createClipJobFromRequest(deps, { userId: USER, idempotencyKey: "idem-key-0001", body: goodBody(k) });
    const { input, overrides } = created[0];
    assert.equal(input.sourceType, "upload");
    assert.equal(input.burnSubtitles, false);
    assert.equal(input.isVisualOnly, false);
    assert.equal(input.requestedClipsCount, 2);
    assert.equal(overrides.extraSettings.sourceMetadataOrigin, "client_hint");
    assert.equal(overrides.extraSettings.sourceSizeBytes, 4321);
    assert.deepEqual(overrides.extraSettings.analysis, CLIPPER_ANALYSIS_CAPABILITIES);
  });
  await test("an upload already used by another job is rejected", async () => {
    const s = fakeStorage({ now: clock });
    const k = upKey("upl_used00001");
    s.put(k);
    const { deps, created } = jobDeps(s);
    deps.uploads.isSourceKeyReferenced = async () => true;
    await rejectsCode(createClipJobFromRequest(deps, { userId: USER, idempotencyKey: "idem-key-0002", body: goodBody(k) }), "UPLOAD_ALREADY_USED");
    assert.equal(created.length, 0);
  });
  await test("idempotent replay skips source verification (source may be cleaned up already)", async () => {
    const s = fakeStorage({ now: clock, infoError: true });
    const { deps, created } = jobDeps(s, { findJobByIdempotencyKey: async () => ({ id: "job_existing01" }) });
    await createClipJobFromRequest(deps, { userId: USER, idempotencyKey: "idem-key-0003", body: goodBody(upKey("upl_gone00001")) });
    assert.equal(created.length, 1);
    assert.equal(s.calls.filter((c) => c.startsWith("info:")).length, 0);
  });
  await test("platform asset: unknown -> SOURCE_NOT_FOUND; 5 s Stage 8 video -> out of range; valid -> asset metadata", async () => {
    const s = fakeStorage();
    const body = { source: { type: "platform_asset", assetId: "ast_video0001" }, aspectRatio: "1:1", framing: "fit", clipCount: 1 };
    await rejectsCode(createClipJobFromRequest(jobDeps(s).deps, { userId: USER, idempotencyKey: "idem-key-0004", body }), "SOURCE_NOT_FOUND");
    const short = jobDeps(s, { loadPlatformVideoAsset: async () => ({ storageKey: `users/${USER}/videos/v.mp4`, durationSeconds: 5, width: 1280, height: 720, sizeBytes: 100 }) });
    await rejectsCode(createClipJobFromRequest(short.deps, { userId: USER, idempotencyKey: "idem-key-0005", body }), "SOURCE_DURATION_OUT_OF_RANGE");
    const ok = jobDeps(s, { loadPlatformVideoAsset: async () => ({ storageKey: `users/${USER}/videos/v.mp4`, durationSeconds: 60, width: 1280, height: 720, sizeBytes: 100 }) });
    await createClipJobFromRequest(ok.deps, { userId: USER, idempotencyKey: "idem-key-0006", body });
    assert.equal(ok.created[0].input.sourceType, "platform_asset");
    assert.equal(ok.created[0].input.sourceDurationSeconds, 60);
    assert.equal(ok.created[0].overrides.extraSettings.sourceMetadataOrigin, "asset_record");
  });

  // -------------------------------------------------------------------------
  console.log("\n# 6. HTTP handlers");
  const ORIGIN = "http://localhost:3000";
  const req = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  const completedRecord = (): clipperNs.ClipJobRecord => ({
    id: "job_view000001",
    status: "COMPLETED",
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    errorMessage: null,
    estimatedCredits: 10,
    chargedCredits: 10,
    settings: {
      sourceKey: upKey("upl_secret001"),
      targetAspectRatio: "9:16",
      targetFraming: "fit",
      requestedClipsCount: 2,
      pendingCleanups: [upKey("upl_secret001")],
      renderedClips: [{ clipId: "c1", assetId: "ast_clip00001", storageKey: `users/${USER}/clips/job_view000001/c1.mp4`, title: "Scene 1" }],
    },
    assets: [
      { id: "ast_clip00001", thumbnailKey: `users/${USER}/clips/job_view000001/c1-thumb.webp`, width: 1080, height: 1920, durationSeconds: 30 },
      { id: "ast_clip00002", thumbnailKey: null, width: 1080, height: 1920, durationSeconds: 25 },
    ],
  });
  function handlers(over: Partial<clipperNs.ClipperHttpDeps> = {}) {
    const s = fakeStorage({ now: clock });
    const limiter = { calls: 0 };
    const h = createClipperHandlers({
      getUserId: async () => USER,
      trustedOrigins: () => [ORIGIN],
      checkRateLimit: () => (limiter.calls++, { allowed: true, retryAfterSeconds: 0 }),
      uploads: uploadDeps(s),
      jobs: jobDeps(s).deps,
      loadJob: async () => ({ ...completedRecord(), status: "PENDING" }),
      loadBalance: async () => 90,
      signAsset: async (_u, id, kind) => `https://proj.supabase.co/sign/${id}-${kind}?token=z`,
      // Batch 6 deps (not exercised by Batch 5 tests)
      submissionsEnabled: () => true,
      cancelJob: async () => ({ outcome: "not_found" as const }),
      signDownload: async () => null,
      log: { error: () => {} },
      ...over,
    });
    return { h, s, limiter };
  }
  await test("state-changing routes reject foreign origin (403) and anonymous users (401)", async () => {
    const { h } = handlers();
    assert.equal((await h.postUploadIntent(req("/api/clipper/uploads", {}, { origin: "https://evil.example" }))).status, 403);
    assert.equal((await h.postClipJob(req("/api/generations/clip", {}, { origin: "https://evil.example" }))).status, 403);
    const anon = handlers({ getUserId: async () => null }).h;
    assert.equal((await anon.postUploadIntent(req("/api/clipper/uploads", {}))).status, 401);
    assert.equal((await anon.getClipJob(new Request(`${ORIGIN}/x`), "job_view000001")).status, 401);
  });
  await test("rate limit -> 429 with Retry-After", async () => {
    const { h } = handlers({ checkRateLimit: () => ({ allowed: false, retryAfterSeconds: 7 }) });
    const res = await h.postUploadIntent(req("/api/clipper/uploads", { mimeType: "video/mp4", sizeBytes: 10 }));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7");
  });
  await test("upload intent -> 201 with signed URL; quota failure -> 503", async () => {
    const { h } = handlers();
    const res = await h.postUploadIntent(req("/api/clipper/uploads", { mimeType: "video/mp4", sizeBytes: 10 }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.upload.signedUrl.startsWith("https://"));
    const failing = handlers({ uploads: uploadDeps(fakeStorage({ listError: true })) }).h;
    const res2 = await failing.postUploadIntent(req("/api/clipper/uploads", { mimeType: "video/mp4", sizeBytes: 10 }));
    assert.equal(res2.status, 503);
    assert.equal((await res2.json()).error.code, "QUOTA_UNVERIFIABLE");
  });
  await test("clip job requires a valid Idempotency-Key", async () => {
    const { h } = handlers();
    const res = await h.postClipJob(req("/api/generations/clip", goodBody(upKey("upl_x0000001"))));
    assert.equal(res.status, 400);
  });
  await test("clip job created -> 202 + Location + Retry-After; view leaks no storage keys", async () => {
    const s = fakeStorage({ now: clock });
    const k = upKey("upl_http00001");
    s.put(k);
    const { h } = handlers({ jobs: jobDeps(s).deps });
    const res = await h.postClipJob(req("/api/generations/clip", goodBody(k), { "idempotency-key": "idem-key-http01" }));
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("location"), "/api/generations/clip/job_created0001");
    assert.ok(res.headers.get("retry-after"));
    const text = await res.text();
    assert.ok(!text.includes("ephemeral/") && !text.includes("users/"), "no storage keys in response");
    const body = JSON.parse(text);
    assert.deepEqual(body.job.analysis, CLIPPER_ANALYSIS_CAPABILITIES);
    assert.equal(body.job.analysis.captions, "unavailable");
  });
  await test("accounting errors map to statuses (insufficient credits 402, active job 409)", async () => {
    const s = fakeStorage({ now: clock });
    const k = upKey("upl_acct00001");
    s.put(k);
    for (const [code, status] of [["INSUFFICIENT_CREDITS", 402], ["ACTIVE_JOB_EXISTS", 409], ["DAILY_LIMIT_REACHED", 429]] as const) {
      const { h } = handlers({
        jobs: jobDeps(s, { createJob: async () => { throw Object.assign(new Error("x"), { name: "AccountingError", code }); } }).deps,
      });
      const res = await h.postClipJob(req("/api/generations/clip", goodBody(k), { "idempotency-key": "idem-key-acct01" }));
      assert.equal(res.status, status, code);
    }
  });
  await test("completed job: clips with short-lived signed URLs, titles, and no keys", async () => {
    const { h } = handlers({ loadJob: async () => completedRecord() });
    const res = await h.getClipJob(new Request(`${ORIGIN}/x`), "job_view000001");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("users/") && !text.includes("ephemeral/") && !text.includes("pendingCleanups"));
    const body = JSON.parse(text);
    assert.equal(body.job.clips.length, 2);
    assert.equal(body.job.clips[0].title, "Scene 1");
    assert.ok(body.job.clips[0].videoUrl.includes("ast_clip00001-video"));
    assert.ok(body.job.clips[0].thumbnailUrl.includes("thumbnail"));
    assert.equal(body.job.clips[1].thumbnailUrl, null);
  });
  await test("signing failure degrades to null URLs (not a 500)", async () => {
    const { h } = handlers({ loadJob: async () => completedRecord(), signAsset: async () => { throw new Error("sign"); } });
    const res = await h.getClipJob(new Request(`${ORIGIN}/x`), "job_view000001");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).job.clips[0].videoUrl, null);
  });
  await test("malformed or foreign job id -> 404", async () => {
    const { h } = handlers({ loadJob: async () => null });
    assert.equal((await h.getClipJob(new Request(`${ORIGIN}/x`), "../etc")).status, 404);
    assert.equal((await h.getClipJob(new Request(`${ORIGIN}/x`), "job_someone01")).status, 404);
  });
  await test("failed job view exposes only a public code + refund message", () => {
    const v = toClipJobView({ ...completedRecord(), status: "FAILED", errorMessage: "Video clipping failed (RENDER_TIMEOUT).", assets: [] });
    assert.deepEqual(v.error?.code, "RENDER_TIMEOUT");
    assert.ok(v.error?.message.includes("refunded"));
    assert.equal(parseFailureCode("ffmpeg stderr /tmp/x"), null);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 7. Abandoned-upload sweep & maintenance");
  const old = new Date(NOW.getTime() - (EPHEMERAL_UPLOAD_TTL_SECONDS + 60) * 1000);
  await test("sweep deletes only expired, unreferenced, well-formed uploads", async () => {
    const s = fakeStorage({ now: clock });
    const expired = upKey("upl_expired01");
    const young = upKey("upl_young0001");
    const inUse = upKey("upl_inuse0001");
    const noTime = upKey("upl_notime002");
    s.put(expired, { createdAt: old, updatedAt: old });
    s.put(young);
    s.put(inUse, { createdAt: old, updatedAt: old });
    s.put(noTime, { createdAt: null, updatedAt: null });
    s.put(`ephemeral/users/${USER}/uploads/notes.txt`, { createdAt: old, updatedAt: old });
    const r = await sweepAbandonedUploads({ storage: s.storage, now: clock, isUploadKeyInActiveJob: async (k) => k === inUse }, { timeoutMs: 100 });
    assert.equal(r.deleted, 1);
    assert.ok(!s.objects.has(expired));
    for (const k of [young, inUse, noTime, `ephemeral/users/${USER}/uploads/notes.txt`]) assert.ok(s.objects.has(k), k);
  });
  await test("sweep keeps uploads when the active-job check errors (cannot prove unused)", async () => {
    const s = fakeStorage({ now: clock });
    s.put(upKey("upl_dberr0001"), { createdAt: old, updatedAt: old });
    const r = await sweepAbandonedUploads({ storage: s.storage, now: clock, isUploadKeyInActiveJob: async () => { throw new Error("db"); } }, { timeoutMs: 100 });
    assert.equal(r.deleted, 0);
    assert.equal(s.objects.size, 1);
  });
  await test("sweep is bounded (maxDeletes) and tolerates per-user listing errors", async () => {
    const s = fakeStorage({ now: clock, listError: (p) => p.includes(OTHER) });
    for (let i = 0; i < 5; i++) s.put(upKey(`upl_bound000${i}`), { createdAt: old, updatedAt: old });
    s.put(upKey("upl_otherusr1", "mp4", OTHER), { createdAt: old, updatedAt: old });
    const r = await sweepAbandonedUploads({ storage: s.storage, now: clock, isUploadKeyInActiveJob: async () => false }, { timeoutMs: 100, maxDeletes: 3 });
    assert.equal(r.deleted, 3);
    assert.equal(r.truncated, true);
    assert.ok(r.listingErrors >= 0);
  });
  await test("maintenance phases are isolated: one failing phase does not stop the others", async () => {
    const s = fakeStorage({ now: clock });
    s.put(upKey("upl_maint0001"), { createdAt: old, updatedAt: old });
    const summary = await runClipperMaintenance({
      reconcileStale: async () => { throw new Error("db down"); },
      findJobsWithPendingCleanups: async () => [],
      lifecycle: { getCleanupState: async () => null, recordCleanup: async () => true },
      storage: s.storage,
      isUploadKeyInActiveJob: async () => false,
      now: clock,
      log: { error: () => {} },
    });
    assert.ok("error" in summary.stale);
    assert.deepEqual(summary.cleanupRetries, { jobs: 0, deleted: 0, abandoned: 0 });
    assert.equal((summary.abandonedUploads as any).deleted, 1);
  });
  await test("stale reconciliation uses the 30-minute queue-wait threshold", async () => {
    let threshold = 0;
    await runClipperMaintenance({
      reconcileStale: async (p) => ((threshold = p.pendingThresholdMs), { checked: 0, settled: 0 }),
      findJobsWithPendingCleanups: async () => [],
      lifecycle: { getCleanupState: async () => null, recordCleanup: async () => true },
      storage: fakeStorage().storage,
      isUploadKeyInActiveJob: async () => false,
      log: { error: () => {} },
    });
    assert.equal(threshold, 30 * 60 * 1000);
  });
  await test("cron auth: production without CRON_SECRET fails CLOSED; wrong/absent bearer 401; correct 200", async () => {
    const r = (h?: string) => new Request(`${ORIGIN}/api/cron/clipper`, { headers: h ? { authorization: h } : {} });
    assert.equal(isAuthorizedCronRequest(r("Bearer x"), { NODE_ENV: "production" }), false);
    assert.equal(isAuthorizedCronRequest(r(), { NODE_ENV: "development" }), true);
    assert.equal(isAuthorizedCronRequest(r("Bearer wrong-secret-0"), { NODE_ENV: "production", CRON_SECRET: "right-secret-00" }), false);
    assert.equal(isAuthorizedCronRequest(r(), { NODE_ENV: "production", CRON_SECRET: "right-secret-00" }), false);
    assert.equal(isAuthorizedCronRequest(r("Bearer right-secret-00"), { NODE_ENV: "production", CRON_SECRET: "right-secret-00" }), true);
    let ran = 0;
    const handler = createClipperCronHandler({
      env: () => ({ NODE_ENV: "production" }),
      maintenance: () => { ran++; throw new Error("must not run"); },
    });
    assert.equal((await handler(r("Bearer anything"))).status, 401);
    assert.equal(ran, 0);
    const okHandler = createClipperCronHandler({
      env: () => ({ NODE_ENV: "production", CRON_SECRET: "right-secret-00" }),
      maintenance: () => ({
        reconcileStale: async () => ({ checked: 1, settled: 1 }),
        findJobsWithPendingCleanups: async () => [],
        lifecycle: { getCleanupState: async () => null, recordCleanup: async () => true },
        storage: fakeStorage().storage,
        isUploadKeyInActiveJob: async () => false,
      }),
    });
    const res = await okHandler(r("Bearer right-secret-00"));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 8. Cleanup retry hardening");
  const JOB = "job_retry00001";
  const state = (over: any) => ({ id: JOB, userId: USER, status: "COMPLETED", assetKeys: [], settings: { sourceType: "upload", sourceKey: upKey("upl_src000001"), ...over } });
  await test("stale 'pending' status with an empty list is finalized (no infinite reselection)", async () => {
    const recorded: any[] = [];
    await retryClipperPendingCleanups(JOB, {
      lifecycle: { getCleanupState: async () => state({ pendingCleanups: [], cleanupStatus: "pending" }) as any, recordCleanup: async (p) => (recorded.push(p), true) },
      storage: { delete: async () => {} },
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].finalize, true);
  });
  await test(`keys failing ${MAX_CLEANUP_ATTEMPTS_PER_KEY}x are abandoned to review; ineligible keys abandoned, never deleted`, async () => {
    const src = upKey("upl_src000001");
    const foreign = `users/${OTHER}/clips/${JOB}/c1.mp4`;
    const audit = Array.from({ length: MAX_CLEANUP_ATTEMPTS_PER_KEY }, () => ({ key: src, action: "delete", timestamp: "", success: false }));
    const recorded: any[] = [];
    const deleted: string[] = [];
    const r = await retryClipperPendingCleanups(JOB, {
      lifecycle: { getCleanupState: async () => state({ pendingCleanups: [src, foreign], cleanupAudit: audit }) as any, recordCleanup: async (p) => (recorded.push(p), true) },
      storage: { delete: async (k) => void deleted.push(k) },
    });
    assert.deepEqual(deleted, []);
    assert.deepEqual(r.abandoned.sort(), [foreign, src].sort());
    assert.deepEqual(recorded[0].abandonKeys.map((a: any) => a.reason).sort(), ["ATTEMPT_CAP", "INELIGIBLE"]);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 9. Scene/pacing planner (no speech, no fake transcript)");
  const scratchRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper-b5-"));
  const srcFile = path.join(scratchRoot, "src.mp4");
  await fsp.writeFile(srcFile, Buffer.concat([MP4_HEAD, Buffer.alloc(2000)]));
  const PNG = await sharp({ create: { width: 540, height: 960, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();

  function fakeRunner(opts: { hasAudio?: boolean; hangRender?: boolean } = {}) {
    const runner = new MockProcessRunner();
    const outputs = new Map<string, { hasAudio: boolean; duration: number }>();
    runner.registerHandler(async (binary, args, options) => {
      const target = args[args.length - 1];
      if (binary === "ffprobe") {
        const out = outputs.get(target);
        if (out) {
          const c = CLIPPER_ASPECT_RATIOS["9:16"];
          const streams: any[] = [{ codec_type: "video", codec_name: "h264", width: c.width, height: c.height }];
          if (out.hasAudio) streams.push({ codec_type: "audio", codec_name: "aac" });
          return { stdout: JSON.stringify({ streams, format: { format_name: "mov,mp4", duration: String(out.duration) } }), stderr: "", exitCode: 0, durationMs: 1 };
        }
        const streams: any[] = [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1" }];
        if (opts.hasAudio !== false) streams.push({ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 });
        return { stdout: JSON.stringify({ streams, format: { duration: "120", size: "2064" } }), stderr: "", exitCode: 0, durationMs: 1 };
      }
      if (args.some((a) => a.includes("gt(scene"))) {
        const lines = [10, 24, 38, 52, 66, 80, 94, 108].map((t, i) => `frame:${i} pts:${t * 1000} pts_time:${t}\nlavfi.scene_score=0.6`).join("\n");
        return { stdout: lines, stderr: "", exitCode: 0, durationMs: 1 };
      }
      if (args.some((a) => a.startsWith("silencedetect"))) {
        return { stdout: "", stderr: "[silencedetect] silence_start: 40\n[silencedetect] silence_end: 44 | silence_duration: 4", exitCode: 0, durationMs: 1 };
      }
      if (target.endsWith(".png")) {
        await fsp.writeFile(target, PNG);
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
      }
      if (target.endsWith(".mp4")) {
        if (opts.hangRender) {
          return new Promise((_, reject) => {
            const abort = () => reject(Object.assign(new Error("aborted"), { name: "ProcessExecutionError", code: "PROCESS_ABORTED" }));
            if (options?.signal?.aborted) return abort();
            options?.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        await fsp.writeFile(target, Buffer.concat([MP4_HEAD, Buffer.alloc(3000)]));
        const i = args.indexOf("-t");
        outputs.set(target, { hasAudio: args.includes("[aout]"), duration: Number(args[i + 1]) });
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    });
    return runner;
  }

  await test("planner: scene + acoustic silence only; words/transcript always empty; speech marked unavailable", async () => {
    const runner = fakeRunner();
    const engine = new FfmpegClipperEngine({ runner, allowMockRunner: true });
    const src = clipper.createLocalFileSource(srcFile);
    const metadata = await engine.extractMetadata(src);
    const plan = await planScenePacingClips(
      { engine, source: src, metadata, signal: new AbortController().signal },
      { requestedClipsCount: 3, targetAspectRatio: "9:16", targetFraming: "fit" },
    );
    assert.ok(plan.length >= 1);
    for (const h of plan) {
      assert.deepEqual(h.words, []);
      assert.equal(h.transcriptText, "");
    }
    assert.ok(runner.callHistory.some((c) => c.args.some((a) => a.startsWith("silencedetect"))), "acoustic silence used for audio sources");
    assert.equal(SPEECH_ANALYSIS_UNAVAILABLE.segments.length, 0);
    assert.ok(!runner.callHistory.some((c) => c.args.some((a) => a.includes("whisper"))));
  });
  await test("planner: visual-only source skips silence detection", async () => {
    const runner = fakeRunner({ hasAudio: false });
    const engine = new FfmpegClipperEngine({ runner, allowMockRunner: true });
    const src = clipper.createLocalFileSource(srcFile);
    const metadata = await engine.extractMetadata(src);
    await planScenePacingClips({ engine, source: src, metadata, signal: new AbortController().signal }, { requestedClipsCount: 1, targetAspectRatio: "9:16", targetFraming: "fit" });
    assert.ok(!runner.callHistory.some((c) => c.args.some((a) => a.startsWith("silencedetect"))));
  });

  // -------------------------------------------------------------------------
  console.log("\n# 10. Worker loop (pickup, exclusivity, shutdown)");
  const SRC_KEY = upKey("upl_wsrc00001");
  const workerSettings = (over: Partial<ClipperJobSettings> = {}): ClipperJobSettings => ({
    sourceType: "upload",
    sourceKey: SRC_KEY,
    sourceDurationSeconds: 120,
    sourceWidth: 1920,
    sourceHeight: 1080,
    isVisualOnly: false,
    targetAspectRatio: "9:16",
    targetFraming: "fit",
    burnSubtitles: false,
    requestedClipsCount: 1,
    engine: "ffmpeg-clipper-engine",
    pendingCleanups: [SRC_KEY],
    cleanupStatus: "pending",
    cleanupAudit: [],
    ...over,
  });

  function sharedLifecycle() {
    const st = { status: "PENDING", token: null as string | null, expiresAt: 0, refunds: 0, completions: 0, failReasons: [] as string[] };
    const live = (t: string) => st.status === "PROCESSING" && st.token === t && st.expiresAt > Date.now();
    let n = 0;
    const lc: ClipperWorkerLifecycle = {
      async markStarted() {
        await tick();
        if (st.status === "PENDING") { st.status = "PROCESSING"; return true; }
        return false;
      },
      async claimLease({ leaseDurationMs }) {
        await tick();
        if (st.status !== "PROCESSING" || (st.token && st.expiresAt > Date.now())) return { claimed: false, reason: "already_claimed_or_not_processing" };
        st.token = `tok_${++n}`;
        st.expiresAt = Date.now() + leaseDurationMs;
        return { claimed: true, token: st.token };
      },
      async renewLease({ token, extensionMs }) {
        if (!live(token)) return false;
        st.expiresAt = Date.now() + extensionMs;
        return true;
      },
      async complete(p) {
        if (!live(p.ingestionToken)) throw new JobNotCompletableError(p.jobId);
        st.status = "COMPLETED";
        st.completions++;
        return { jobId: p.jobId, assetIds: p.clips.map((c) => c.assetId!) };
      },
      async failFenced({ ingestionToken, reason }) {
        if (!live(ingestionToken)) return { settled: false };
        st.status = "FAILED";
        st.refunds++;
        st.failReasons.push(reason);
        return { settled: true };
      },
      async recordCleanup() { return true; },
      async getCleanupState() { return null; },
    };
    return { lc, st };
  }

  function loopDeps(o: { runner: InstanceType<typeof MockProcessRunner>; lc: ClipperWorkerLifecycle; s: ReturnType<typeof fakeStorage>; jobs: () => any[] }) {
    return {
      findPendingJobs: async () => o.jobs(),
      processDeps: {
        engine: new FfmpegClipperEngine({ runner: o.runner, allowMockRunner: true, renderTimeoutMs: 10_000 }),
        lifecycle: o.lc,
        storage: o.s.storage,
        scratchDir: scratchRoot,
        leaseMs: 60_000,
        heartbeatMs: 10_000,
        logger: { warn: () => {}, error: () => {} },
      },
      storage: o.s.storage,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  }

  await test("--once: picks up the pending job, downloads the source once, completes, deletes source", async () => {
    const s = fakeStorage();
    s.put(SRC_KEY, { head: Buffer.concat([MP4_HEAD, Buffer.alloc(2000)]), size: 2064 });
    const { lc, st } = sharedLifecycle();
    const res = await runClipperWorkerLoop(
      loopDeps({ runner: fakeRunner(), lc, s, jobs: () => (st.status === "PENDING" ? [{ id: "job_loop000001", userId: USER, settings: workerSettings() }] : []) }),
      { once: true },
    );
    assert.deepEqual(res.outcomes.map((o) => o.status), ["completed"]);
    assert.equal(st.completions, 1);
    assert.equal(s.calls.filter((c) => c.startsWith("download:")).length, 1);
    assert.ok(!s.objects.has(SRC_KEY), "source deleted after completion");
  });

  await test("two workers racing for the same job: exactly one processes it", async () => {
    const s = fakeStorage();
    s.put(SRC_KEY, { head: Buffer.concat([MP4_HEAD, Buffer.alloc(2000)]), size: 2064 });
    const { lc, st } = sharedLifecycle();
    const job = { id: "job_race000001", userId: USER, settings: workerSettings() };
    const [a, b] = await Promise.all([
      runClipperWorkerLoop(loopDeps({ runner: fakeRunner(), lc, s, jobs: () => [job] }), { once: true }),
      runClipperWorkerLoop(loopDeps({ runner: fakeRunner(), lc, s, jobs: () => [job] }), { once: true }),
    ]);
    const statuses = [...a.outcomes, ...b.outcomes].map((o) => o.status).sort();
    assert.deepEqual(statuses, ["completed", "not_claimed"]);
    assert.equal(st.completions, 1);
    assert.equal(st.refunds, 0);
  });

  await test("unprocessable settings are skipped (left for reconciliation), never crash the loop", async () => {
    const s = fakeStorage();
    const { lc } = sharedLifecycle();
    const res = await runClipperWorkerLoop(
      loopDeps({ runner: fakeRunner(), lc, s, jobs: () => [{ id: "job_bad0000001", userId: USER, settings: { foo: 1 } }, { id: "../x", userId: USER, settings: workerSettings() }] }),
      { once: true },
    );
    assert.deepEqual(res.outcomes.map((o) => o.status), ["invalid_settings", "invalid_settings"]);
    assert.equal(isProcessableSettings(workerSettings()), true);
  });

  await test("graceful stop: a stop signal before the next pickup ends the loop without starting work", async () => {
    const s = fakeStorage();
    const { lc } = sharedLifecycle();
    const stop = new AbortController();
    stop.abort();
    let queried = 0;
    const res = await runClipperWorkerLoop({ ...loopDeps({ runner: fakeRunner(), lc, s, jobs: () => [] }), findPendingJobs: async () => (queried++, []) }, { stopSignal: stop.signal });
    assert.equal(res.iterations, 0);
    assert.equal(queried, 0);
  });

  await test("hard abort mid-render: FFmpeg killed, job settled FAILED (WORKER_SHUTDOWN) + refunded under the lease, source cleaned", async () => {
    const s = fakeStorage();
    s.put(SRC_KEY, { head: Buffer.concat([MP4_HEAD, Buffer.alloc(2000)]), size: 2064 });
    const { lc, st } = sharedLifecycle();
    const abort = new AbortController();
    const runner = fakeRunner({ hangRender: true });
    const origExec = runner.execute.bind(runner);
    runner.execute = async (bin, args, opts) => {
      if (bin === "ffmpeg" && args[args.length - 1].endsWith(".mp4")) setTimeout(() => abort.abort(), 10);
      return origExec(bin, args, opts);
    };
    const res = await runClipperWorkerLoop(
      loopDeps({ runner, lc, s, jobs: () => (st.status === "PENDING" ? [{ id: "job_abort00001", userId: USER, settings: workerSettings() }] : []) }),
      { once: true, abortSignal: abort.signal },
    );
    assert.deepEqual(res.outcomes.map((o) => o.status), ["failed"]);
    assert.equal(st.status, "FAILED");
    assert.equal(st.refunds, 1);
    assert.ok(st.failReasons[0].includes("WORKER_SHUTDOWN"));
    assert.ok(!s.objects.has(SRC_KEY));
  });

  await fsp.rm(scratchRoot, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  console.log("\n# 11. Browser client: pending store, upload, controller");
  function memStorage() {
    const m = new Map<string, string>();
    return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
  }
  const T0 = 1_800_000_000_000;

  await test("pending store: validates schema, expires after 24 h, survives corrupt data", () => {
    const { m, s } = memStorage();
    const rec = { v: 1 as const, idempotencyKey: "clip-abcdef123456", source: { type: "upload" as const, uploadKey: upKey("upl_p0000001") }, options: { aspectRatio: "9:16" as const, framing: "fit" as const, clipCount: 1 }, createdAt: T0 };
    writePending(s, USER, rec);
    assert.deepEqual(readPending(s, USER, T0 + 1000), rec);
    assert.equal(readPending(s, USER, T0 + 25 * 3600_000), null);
    m.set(pendingKey(USER), "{not json");
    assert.equal(readPending(s, USER, T0), null);
    m.set(pendingKey(USER), JSON.stringify({ ...rec, idempotencyKey: "bad key with spaces" }));
    assert.equal(readPending(s, USER, T0), null);
  });

  await test("uploadToSignedUrl: PUT with content-type + x-upsert, progress, success / rejection / abort", async () => {
    const mk = (status: number, behaviour: "load" | "error" | "hang" = "load") => {
      const x: any = {
        headers: {} as Record<string, string>, status: 0, upload: { onprogress: null }, onload: null, onerror: null, onabort: null,
        open(m: string, u: string) { x.method = m; x.url = u; },
        setRequestHeader(k: string, v: string) { x.headers[k] = v; },
        send() {
          setTimeout(() => {
            x.upload.onprogress?.({ loaded: 50, total: 100, lengthComputable: true });
            if (behaviour === "load") { x.status = status; x.onload?.(); }
            if (behaviour === "error") x.onerror?.();
          }, 0);
        },
        abort() { x.onabort?.(); },
      };
      return x;
    };
    const progress: number[] = [];
    let xhr: any;
    const ok = await uploadToSignedUrl({ signedUrl: "https://p.supabase.co/u", file: new Blob(["x"]), contentType: "video/mp4", onProgress: (p) => progress.push(p), createXhr: () => (xhr = mk(200)) });
    assert.deepEqual(ok, { ok: true });
    assert.equal(xhr.method, "PUT");
    assert.equal(xhr.headers["Content-Type"], "video/mp4");
    assert.equal(xhr.headers["x-upsert"], "true");
    assert.deepEqual(progress, [0.5]);
    assert.deepEqual(await uploadToSignedUrl({ signedUrl: "u", file: new Blob(["x"]), contentType: "video/mp4", createXhr: () => mk(413) }), { ok: false, code: "UPLOAD_REJECTED", status: 413 });
    assert.equal((await uploadToSignedUrl({ signedUrl: "u", file: new Blob(["x"]), contentType: "video/mp4", createXhr: () => mk(0, "error") }) as any).code, "NETWORK_ERROR");
    const ac = new AbortController();
    const p = uploadToSignedUrl({ signedUrl: "u", file: new Blob(["x"]), contentType: "video/mp4", signal: ac.signal, createXhr: () => mk(0, "hang") });
    ac.abort();
    assert.equal((await p as any).code, "ABORTED");
  });

  const jobBody = (status: string, extra: any = {}) => ({
    job: { id: "job_client0001", status, clips: [], analysis: CLIPPER_ANALYSIS_CAPABILITIES, error: null, ...extra },
    replayed: false,
    balance: 90,
  });

  function fakeApi(o: { postResults?: any[]; getResults?: any[]; storageRef?: { s: any } } = {}) {
    const calls: Array<{ fn: string; args: any }> = [];
    const posts = [...(o.postResults ?? [{ ok: true, status: 202, data: jobBody("PENDING") }])];
    const gets = [...(o.getResults ?? [{ ok: true, status: 200, data: jobBody("COMPLETED") }])];
    const api = {
      requestUploadIntent: async (args: any) => (calls.push({ fn: "intent", args }), { ok: true as const, status: 201, data: { upload: { uploadKey: upKey("upl_client001"), uploadId: "upl_client001", signedUrl: "https://p.supabase.co/u", contentType: "video/mp4", maxBytes: MAX, expiresAt: "" } } }),
      completeUpload: async (args: any) => (calls.push({ fn: "complete", args }), { ok: true as const, status: 200, data: { upload: { uploadKey: args, sizeBytes: 10, container: "mp4" } } }),
      discardUpload: async (args: any) => (calls.push({ fn: "discard", args }), { ok: true as const, status: 200, data: { deleted: true as const } }),
      postClipJob: async (args: any) => {
        calls.push({ fn: "post", args: { ...args, persisted: o.storageRef ? readPending(o.storageRef.s, USER, T0) : null } });
        return posts.length > 1 ? posts.shift() : posts[0];
      },
      getClipJob: async (args: any) => (calls.push({ fn: "get", args }), gets.length > 1 ? gets.shift() : gets[0]),
    };
    return { api: api as any, calls };
  }
  const file = new Blob(["video"], { type: "video/mp4" });
  const startInput = { file, hints: { durationSeconds: 60 }, options: { aspectRatio: "9:16" as const, framing: "fit" as const, clipCount: 1 } };
  const ctl = (api: any, s: any, over: any = {}) =>
    createClipperController({ userId: USER, storage: s, api, upload: async () => ({ ok: true }), now: () => T0, sleep: async () => {}, newKey: () => "clip-key-0000000001", ...over });

  await test("happy path: upload → verify → submit (key persisted BEFORE POST) → poll → completed, pending cleared", async () => {
    const { s } = memStorage();
    const { api, calls } = fakeApi({ storageRef: { s } });
    const c = ctl(api, s);
    const phases: string[] = [];
    c.subscribe((st) => phases.push(st.phase));
    await c.startUpload(startInput);
    assert.equal(c.getState().phase, "completed");
    const post = calls.find((x) => x.fn === "post")!;
    assert.equal(post.args.idempotencyKey, "clip-key-0000000001");
    assert.equal(post.args.persisted?.idempotencyKey, "clip-key-0000000001", "persisted before POST");
    assert.equal(readPending(s, USER, T0), null);
    for (const p of ["uploading", "verifying", "submitting", "processing", "completed"]) assert.ok(phases.includes(p), p);
  });

  await test("ambiguous POST (network / 5xx) is retried with the SAME key, never a new one", async () => {
    const { s } = memStorage();
    let keys = 0;
    const { api, calls } = fakeApi({
      postResults: [
        { ok: false, error: { code: "NETWORK_ERROR", message: "", status: null, retryAfterSeconds: null } },
        { ok: false, error: { code: "INTERNAL_ERROR", message: "", status: 500, retryAfterSeconds: null } },
        { ok: true, status: 202, data: jobBody("PENDING") },
      ],
    });
    const c = ctl(api, s, { newKey: () => `clip-key-${String(++keys).padStart(10, "0")}` });
    await c.startUpload(startInput);
    const postKeys = calls.filter((x) => x.fn === "post").map((x) => x.args.idempotencyKey);
    assert.equal(postKeys.length, 3);
    assert.equal(new Set(postKeys).size, 1);
    assert.equal(keys, 1);
    assert.equal(c.getState().phase, "completed");
  });

  await test("definitive rejection: pending cleared, upload reservation released, no retry", async () => {
    const { s } = memStorage();
    const { api, calls } = fakeApi({ postResults: [{ ok: false, error: { code: "INSUFFICIENT_CREDITS", message: "Not enough credits.", status: 402, retryAfterSeconds: null } }] });
    const c = ctl(api, s);
    await c.startUpload(startInput);
    assert.equal(c.getState().phase, "failed");
    assert.equal(calls.filter((x) => x.fn === "post").length, 1);
    assert.ok(calls.some((x) => x.fn === "discard"));
    assert.equal(readPending(s, USER, T0), null);
  });

  await test("upload failure releases the reservation and never submits", async () => {
    const { s } = memStorage();
    const { api, calls } = fakeApi();
    const c = ctl(api, s, { upload: async () => ({ ok: false, code: "NETWORK_ERROR", status: null }) });
    await c.startUpload(startInput);
    assert.equal(c.getState().phase, "failed");
    assert.ok(calls.some((x) => x.fn === "discard"));
    assert.ok(!calls.some((x) => x.fn === "post"));
  });

  await test("recover: known job → polls only (no POST); unconfirmed within window → replays SAME key; too old → expired, no POST", async () => {
    const base = { v: 1 as const, idempotencyKey: "clip-recover00001", source: { type: "upload" as const, uploadKey: upKey("upl_rec000001") }, options: { aspectRatio: "9:16" as const, framing: "fit" as const, clipCount: 1 } };
    {
      const { s } = memStorage();
      writePending(s, USER, { ...base, createdAt: T0 - 1000, jobId: "job_client0001" });
      const { api, calls } = fakeApi();
      const c = ctl(api, s);
      await c.recover();
      assert.equal(calls.filter((x) => x.fn === "post").length, 0);
      assert.equal(c.getState().phase, "completed");
    }
    {
      const { s } = memStorage();
      writePending(s, USER, { ...base, createdAt: T0 - 60_000 });
      const { api, calls } = fakeApi();
      const c = ctl(api, s, { newKey: () => { throw new Error("must not create a key during recovery"); } });
      await c.recover();
      assert.deepEqual(calls.filter((x) => x.fn === "post").map((x) => x.args.idempotencyKey), ["clip-recover00001"]);
    }
    {
      const { s } = memStorage();
      writePending(s, USER, { ...base, createdAt: T0 - CLIP_REPLAY_WINDOW_MS - 1 });
      const { api, calls } = fakeApi();
      const c = ctl(api, s);
      await c.recover();
      assert.equal(calls.filter((x) => x.fn === "post").length, 0);
      assert.equal(c.getState().phase, "expired");
    }
    {
      const { s } = memStorage();
      const { api, calls } = fakeApi();
      await ctl(api, s).recover();
      assert.equal(calls.length, 0, "nothing pending → nothing happens");
    }
  });

  await test("job failure surfaces the public code and clears the pending record", async () => {
    const { s } = memStorage();
    const { api } = fakeApi({ getResults: [{ ok: true, status: 200, data: jobBody("FAILED", { error: { code: "INSUFFICIENT_HIGHLIGHTS", message: "refunded" } }) }] });
    const c = ctl(api, s);
    await c.startUpload(startInput);
    const st = c.getState();
    assert.equal(st.phase, "failed");
    assert.equal((st as any).error.code, "INSUFFICIENT_HIGHLIGHTS");
    assert.equal(readPending(s, USER, T0), null);
  });

  await test("a second start while busy is ignored (no duplicate submissions)", async () => {
    const { s } = memStorage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { api, calls } = fakeApi();
    const c = ctl(api, s, { upload: async () => (await gate, { ok: true }) });
    const first = c.startUpload(startInput);
    await tick();
    await c.startUpload(startInput);
    release();
    await first;
    assert.equal(calls.filter((x) => x.fn === "intent").length, 1);
    assert.equal(calls.filter((x) => x.fn === "post").length, 1);
  });

  console.log("\n=======================================================");
  console.log(`  Tests Passed: ${passed}`);
  console.log(`  Tests Failed: ${failed}`);
  console.log("=======================================================\n");
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Unhandled test execution error:", err);
  process.exit(1);
});
