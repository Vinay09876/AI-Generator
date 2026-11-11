/**
 * Stage 9 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Batch 4: Rendering Pipeline, Framing Filters, Output Validation & Worker Orchestration.
 *
 * Offline: ZERO network calls, ZERO database access, ZERO storage mutations.
 * FFmpeg/FFprobe are simulated with MockProcessRunner; sharp runs for real on generated PNGs.
 * Section 9 runs a REAL FFmpeg encode only if ffmpeg/ffprobe are on PATH; otherwise it is
 * reported as SKIPPED (never counted as passed).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";

// Import everything through the feature index so the test and the modules under test share ONE
// instance of each class (tsx can otherwise load a module twice: ESM from .mts, CJS transitively).
import * as clipperNs from "../src/features/clipper/index";
const clipper = ((clipperNs as any).default ?? clipperNs) as typeof clipperNs;
const {
  CLIPPER_ASPECT_RATIOS,
  getClipperVideoMaxrateKbps,
  MAX_STORED_CLIP_BYTES,
  assertSafeSubprocessArgs,
  MockProcessRunner,
  ProcessExecutionError,
  SystemProcessRunner,
  UnsafeArgumentError,
  buildClipFilterGraph,
  RenderConfigError,
  buildRenderArgs,
  buildThumbnailArgs,
  OutputValidationError,
  validateRenderedClip,
  choosePosterTimestamp,
  ClipThumbnailError,
  extractClipThumbnail,
  ClipRenderError,
  FfmpegClipperEngine,
  TranscriptionUnavailableError,
  MockClipperEngine,
  LeaseKeeper,
  LeaseLostError,
  processClipperJob,
  retryClipperPendingCleanups,
  JobNotCompletableError,
  createLocalFileSource,
  createStorageReferenceSource,
} = clipper;
import type {
  ClipperAspectRatio,
  ClipperFramingMode,
  RunnerOptions,
  ClipperJobCleanupState,
  ClipperWorkerLifecycle,
  ClipperWorkerStorage,
  ClipperCleanupResult,
  CandidateHighlight,
  ClipperJobSettings,
  VideoClipperEngine,
} from "../src/features/clipper/index";
type MockProcessRunner = InstanceType<typeof MockProcessRunner>;

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(name: string, why: string) {
  console.log(`SKIP  ${name} (${why})`);
  skipped++;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper-b4-test-"));
const SOURCE = path.join(ROOT, "source.mp4");
const SILENT_SOURCE = path.join(ROOT, "silent_source.mp4");
const FTYP = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
await fsp.writeFile(SOURCE, Buffer.concat([FTYP, Buffer.alloc(2048, 7)]));
await fsp.writeFile(SILENT_SOURCE, Buffer.concat([FTYP, Buffer.alloc(2048, 7)]));
const PNG = await sharp({ create: { width: 540, height: 960, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();

const USER = "usr_b4user001";
const JOB = "job_b4job00001";
const ASPECTS = Object.keys(CLIPPER_ASPECT_RATIOS) as ClipperAspectRatio[];
const FRAMINGS: ClipperFramingMode[] = ["center_crop", "fit", "pillarbox_blur"];

async function newScratch(): Promise<string> {
  return fsp.mkdtemp(path.join(ROOT, "scratch-"));
}

async function renderDirsIn(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).filter((n) => n.startsWith("clipper-render-"));
  } catch {
    return [];
  }
}

type RenderMode = "ok" | "fail" | "timeout" | "hang" | "nofile" | "huge";

interface FakeFfmpegOptions {
  aspect: ClipperAspectRatio;
  sourceHasAudio?: boolean;
  sourceDuration?: number;
  renderMode?: (renderIndex: number) => RenderMode;
  probeOverride?: (out: any) => any;
  onRender?: (args: string[], options?: RunnerOptions) => void | Promise<void>;
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fakeFfmpeg(opts: FakeFfmpegOptions) {
  const runner = new MockProcessRunner();
  const outputs = new Map<string, { hasAudio: boolean; duration: number }>();
  let renderIndex = 0;
  const canvas = CLIPPER_ASPECT_RATIOS[opts.aspect];

  runner.registerHandler(async (binary, args, options) => {
    const target = args[args.length - 1];
    if (binary === "ffprobe") {
      const out = outputs.get(target);
      if (out) {
        const streams: any[] = [{ index: 0, codec_type: "video", codec_name: "h264", width: canvas.width, height: canvas.height }];
        if (out.hasAudio) streams.push({ index: 1, codec_type: "audio", codec_name: "aac" });
        let json: any = { streams, format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: String(out.duration) } };
        if (opts.probeOverride) json = opts.probeOverride(json);
        return { stdout: JSON.stringify(json), stderr: "", exitCode: 0, durationMs: 1 };
      }
      const silent = target.includes("silent") || opts.sourceHasAudio === false;
      const streams: any[] = [{ index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30000/1001" }];
      if (!silent) streams.push({ index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 });
      const duration = opts.sourceDuration ?? 120;
      return {
        stdout: JSON.stringify({ streams, format: { duration: String(duration), size: "2064", format_name: "mov,mp4" } }),
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    }

    // ffmpeg
    if (target.endsWith(".png")) {
      await fsp.writeFile(target, PNG);
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    }
    if (target.endsWith(".wav")) {
      await fsp.writeFile(target, Buffer.alloc(64));
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    }
    if (target.endsWith(".mp4")) {
      const mode = opts.renderMode?.(renderIndex) ?? "ok";
      renderIndex++;
      await opts.onRender?.(args, options);
      if (mode === "fail") throw new ProcessExecutionError("ffmpeg failed", "PROCESS_EXIT_ERROR", { exitCode: 1, stderr: "boom /secret/path" });
      if (mode === "timeout") throw new ProcessExecutionError("timed out", "PROCESS_TIMEOUT");
      if (mode === "hang") {
        return new Promise((_, reject) => {
          const sig = options?.signal;
          const abort = () => reject(new ProcessExecutionError("aborted", "PROCESS_ABORTED"));
          if (!sig) return reject(new Error("hang requires a signal"));
          if (sig.aborted) return abort();
          sig.addEventListener("abort", abort, { once: true });
        });
      }
      if (mode !== "nofile") {
        const size = mode === "huge" ? MAX_STORED_CLIP_BYTES + 1 : 4096;
        const fh = await fsp.open(target, "wx");
        await fh.write(FTYP, 0, FTYP.length, 0);
        await fh.truncate(size);
        await fh.close();
      }
      const hasAudio = args.includes("[aout]");
      outputs.set(target, { hasAudio, duration: Number(argAfter(args, "-t")) });
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
  });
  return runner;
}

function renderCalls(runner: MockProcessRunner) {
  return runner.callHistory.filter((c) => c.binary === "ffmpeg" && c.args[c.args.length - 1].endsWith(".mp4"));
}

function highlights(n = 3, withWords = true): CandidateHighlight[] {
  const windows = [[5, 35], [40, 70], [80, 110]];
  return windows.slice(0, n).map(([s, e], i) => ({
    id: `h${i}`,
    title: `Clip {\\an8}${i} '; rm -rf /`,
    startTime: s,
    endTime: e,
    durationSeconds: e - s,
    score: 80,
    reason: "test",
    transcriptText: "hello world",
    words: withWords ? [{ word: "hello", start: 0.2, end: 0.6 }, { word: "{\\b1}world", start: 0.7, end: 1.2 }] : [],
    aspectRatio: "9:16",
    framing: "pillarbox_blur",
  }));
}

function settings(overrides: Partial<ClipperJobSettings> = {}): ClipperJobSettings {
  return {
    sourceType: "upload",
    sourceKey: `ephemeral/users/${USER}/uploads/upl_source0001.mp4`,
    sourceDurationSeconds: 120,
    sourceWidth: 1920,
    sourceHeight: 1080,
    isVisualOnly: false,
    targetAspectRatio: "9:16",
    targetFraming: "pillarbox_blur",
    burnSubtitles: true,
    requestedClipsCount: 3,
    engine: "ffmpeg-clipper-engine",
    pendingCleanups: [`ephemeral/users/${USER}/uploads/upl_source0001.mp4`],
    cleanupStatus: "pending",
    cleanupAudit: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake lifecycle (token + expiry semantics mirror the SQL guards) and fake storage
// ---------------------------------------------------------------------------
interface FakeLifecycleOptions {
  renew?: (call: number) => boolean | Promise<boolean>;
  complete?: (p: any, self: FakeLifecycle) => Promise<{ jobId: string; assetIds: string[] }>;
  cleanupState?: () => Promise<ClipperJobCleanupState | null>;
  claim?: boolean;
  failFencedThrows?: boolean;
}

type FakeLifecycle = ClipperWorkerLifecycle & {
  st: {
    status: string;
    token: string | null;
    expiresAt: number;
    refunds: number;
    completions: number;
    assetKeys: string[];
    recorded: ClipperCleanupResult[];
    pending: Set<string>;
    events: string[];
    renewCalls: number;
  };
};

function fakeLifecycle(o: FakeLifecycleOptions = {}, initialPending: string[] = []): FakeLifecycle {
  const st = {
    status: "PENDING",
    token: null as string | null,
    expiresAt: 0,
    refunds: 0,
    completions: 0,
    assetKeys: [] as string[],
    recorded: [] as ClipperCleanupResult[],
    pending: new Set(initialPending),
    events: [] as string[],
    renewCalls: 0,
  };
  const live = (t: string) => st.status === "PROCESSING" && st.token === t && st.expiresAt > Date.now();
  const self: FakeLifecycle = {
    st,
    async markStarted() {
      if (st.status === "PENDING") st.status = "PROCESSING";
      return true;
    },
    async claimLease({ leaseDurationMs }) {
      if (o.claim === false || st.status !== "PROCESSING") return { claimed: false, reason: "already_claimed_or_not_processing" };
      st.token = "tok_live";
      st.expiresAt = Date.now() + leaseDurationMs;
      return { claimed: true, token: st.token, expiresAt: new Date(st.expiresAt) };
    },
    async renewLease({ token, extensionMs }) {
      const n = st.renewCalls++;
      if (o.renew) {
        const ok = await o.renew(n);
        if (!ok) {
          st.token = "tok_other_worker";
          return false;
        }
      }
      if (!live(token)) return false;
      st.expiresAt = Date.now() + extensionMs;
      return true;
    },
    async complete(p) {
      st.events.push("complete");
      if (o.complete) return o.complete(p, self);
      if (!live(p.ingestionToken)) throw new JobNotCompletableError(p.jobId);
      st.status = "COMPLETED";
      st.completions++;
      st.token = null;
      st.assetKeys = p.clips.flatMap((c: any) => [c.storageKey, c.thumbnailKey].filter(Boolean));
      return { jobId: p.jobId, assetIds: p.clips.map((c: any) => c.assetId) };
    },
    async failFenced({ ingestionToken }) {
      st.events.push("failFenced");
      if (o.failFencedThrows) throw new Error("db down");
      if (!live(ingestionToken)) return { settled: false };
      st.status = "FAILED";
      st.refunds++;
      st.token = null;
      return { settled: true };
    },
    async recordCleanup({ results }) {
      st.events.push("recordCleanup");
      for (const r of results) {
        st.recorded.push(r);
        if (r.success) st.pending.delete(r.key);
        else st.pending.add(r.key);
      }
      return true;
    },
    async getCleanupState() {
      if (o.cleanupState) return o.cleanupState();
      return {
        id: JOB,
        userId: USER,
        status: st.status,
        settings: { ...settings(), pendingCleanups: [...st.pending] },
        assetKeys: st.assetKeys,
      };
    },
  };
  return self;
}

function fakeStorage(opts: { failDelete?: (key: string) => boolean; failPut?: (key: string) => boolean } = {}) {
  const objects = new Map<string, { size: number; contentType: string }>();
  const deleted: string[] = [];
  const puts: Array<{ key: string; isBuffer: boolean; contentLength: number; bytes: number }> = [];
  const events: string[] = [];
  const storage: ClipperWorkerStorage = {
    async putStream(key, stream, options) {
      events.push(`put:${key}`);
      const isBuffer = Buffer.isBuffer(stream as unknown);
      let bytes = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) bytes += chunk.length;
      puts.push({ key, isBuffer, contentLength: options.contentLength, bytes });
      if (opts.failPut?.(key)) throw Object.assign(new Error("upload failed"), { code: "UPLOAD_FAILED" });
      assert.equal(bytes, options.contentLength, "contentLength must equal streamed bytes");
      assert.ok(bytes <= options.maxBytes);
      objects.set(key, { size: bytes, contentType: options.contentType });
      return { sizeBytes: bytes };
    },
    async delete(key) {
      events.push(`delete:${key}`);
      if (opts.failDelete?.(key)) throw Object.assign(new Error("delete failed"), { code: "DELETE_FAILED" });
      objects.delete(key);
      deleted.push(key);
    },
  };
  return { storage, objects, deleted, puts, events };
}

function engineFor(runner: MockProcessRunner, extra: Partial<ConstructorParameters<typeof FfmpegClipperEngine>[0]> = {}) {
  return new FfmpegClipperEngine({ runner, allowMockRunner: true, renderTimeoutMs: 20_000, threads: 2, ...extra });
}

const quietLogger = { warn: () => {}, error: () => {} };

// ===========================================================================
async function run() {
  console.log("\n=======================================================");
  console.log("  Stage 9 - Batch 4: Rendering Pipeline & Worker Tests");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------------
  console.log("# 1. Filter graph: 3 aspect ratios x 3 framing modes x audio/visual-only x subtitles");
  for (const aspect of ASPECTS) {
    for (const framing of FRAMINGS) {
      await test(`filter graph ${aspect} ${framing} (audio+subs, visual-only)`, () => {
        const { width: W, height: H } = CLIPPER_ASPECT_RATIOS[aspect];
        const withAudio = buildClipFilterGraph({ aspectRatio: aspect, framing, hasAudio: true, sourceFps: 29.97, subtitleFileName: "subs.ass" });
        assert.equal(withAudio.width, W);
        assert.equal(withAudio.height, H);
        assert.equal(withAudio.audioLabel, "[aout]");
        assert.ok(withAudio.graph.includes("subtitles=filename=subs.ass"));
        assert.ok(withAudio.graph.includes("loudnorm=I=-14"));
        assert.ok(withAudio.graph.includes("[0:a:0]"));
        assert.ok(withAudio.graph.endsWith("[aout]"));
        assert.ok(withAudio.graph.includes("fps=29.97"));
        assert.ok(withAudio.graph.includes("format=yuv420p[vout]"));
        if (framing === "center_crop") assert.ok(withAudio.graph.includes(`crop=${W}:${H}`));
        if (framing === "fit") assert.ok(withAudio.graph.includes(`pad=${W}:${H}:`));
        if (framing === "pillarbox_blur") {
          assert.ok(withAudio.graph.includes("split=2[bgsrc][fgsrc]"));
          assert.ok(withAudio.graph.includes("boxblur="));
          assert.ok(withAudio.graph.includes("overlay=(W-w)/2:(H-h)/2"));
          assert.ok(withAudio.graph.includes(`scale=${W}:${H},setsar=1[bg]`));
        }
        // Single pass: exactly one [vout] sink and the only input referenced is #0.
        assert.equal(withAudio.graph.split("[vout]").length, 2);
        assert.ok(!/\[[1-9]:/.test(withAudio.graph));

        const silent = buildClipFilterGraph({ aspectRatio: aspect, framing, hasAudio: false, sourceFps: 60 });
        assert.equal(silent.audioLabel, null);
        assert.ok(!silent.graph.includes("[0:a"));
        assert.ok(!silent.graph.includes("loudnorm"));
        assert.ok(!silent.graph.includes("subtitles="));
        assert.equal(silent.outputFps, 30, "fps capped at 30");
      });
    }
  }

  await test("blur background canvas uses even dimensions", () => {
    for (const aspect of ASPECTS) {
      const g = buildClipFilterGraph({ aspectRatio: aspect, framing: "pillarbox_blur", hasAudio: false, sourceFps: 30 }).graph;
      const m = /\[bgsrc\]scale=(\d+):(\d+)/.exec(g)!;
      assert.equal(Number(m[1]) % 2, 0);
      assert.equal(Number(m[2]) % 2, 0);
    }
  });

  await test("filter graph rejects unsafe subtitle filenames and unknown modes", () => {
    for (const bad of ["../subs.ass", "C:\\x\\subs.ass", "subs.ass:force_style=x", "subs.srt", "a b.ass", "subs.ass,drawtext=text=x"]) {
      assert.throws(() => buildClipFilterGraph({ aspectRatio: "9:16", framing: "fit", hasAudio: true, sourceFps: 30, subtitleFileName: bad }), RenderConfigError);
    }
    assert.throws(() => buildClipFilterGraph({ aspectRatio: "4:3" as any, framing: "fit", hasAudio: true, sourceFps: 30 }), RenderConfigError);
    assert.throws(() => buildClipFilterGraph({ aspectRatio: "9:16", framing: "zoom" as any, hasAudio: true, sourceFps: 30 }), RenderConfigError);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 2. FFmpeg argument builder");
  const OUT = path.join(ROOT, "x", "clip.mp4");

  await test("render args: safety flags, seek window, codecs, limits, metadata stripping", () => {
    const { args, durationSeconds } = buildRenderArgs({
      inputPath: SOURCE, outputPath: OUT, startTime: 12.5, endTime: 42.5,
      aspectRatio: "9:16", framing: "pillarbox_blur", hasAudio: true, sourceFps: 30, subtitleFileName: "subs.ass", threads: 3,
    });
    assert.equal(durationSeconds, 30);
    for (const f of ["-nostdin", "-n", "-hide_banner", "-sn", "-dn", "-an"].slice(0, 5)) assert.ok(args.includes(f), f);
    assert.ok(!args.includes("-y"), "never overwrite");
    assert.equal(argAfter(args, "-protocol_whitelist"), "file");
    assert.equal(argAfter(args, "-threads"), "3");
    assert.equal(argAfter(args, "-ss"), "12.500");
    assert.equal(argAfter(args, "-t"), "30.000");
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "input seek");
    assert.equal(argAfter(args, "-i"), SOURCE);
    assert.equal(argAfter(args, "-c:v"), "libx264");
    assert.equal(argAfter(args, "-c:a"), "aac");
    assert.equal(argAfter(args, "-pix_fmt"), "yuv420p");
    assert.equal(argAfter(args, "-map_metadata"), "-1");
    assert.equal(argAfter(args, "-fs"), String(MAX_STORED_CLIP_BYTES));
    assert.equal(argAfter(args, "-maxrate"), `${getClipperVideoMaxrateKbps()}k`);
    assert.equal(argAfter(args, "-movflags"), "+faststart");
    assert.equal(argAfter(args, "-f"), "mp4");
    assert.equal(args[args.length - 1], OUT);
    assert.ok(args.includes("[aout]"));
    assertSafeSubprocessArgs(args);
  });

  await test("bitrate ceiling keeps a max-length (60s) clip under the stored-clip limit", () => {
    const kbps = getClipperVideoMaxrateKbps() + 128;
    assert.ok((kbps * 1000 * 60) / 8 < MAX_STORED_CLIP_BYTES);
  });

  await test("visual-only render args omit audio entirely", () => {
    const { args } = buildRenderArgs({ inputPath: SOURCE, outputPath: OUT, startTime: 0, endTime: 10, aspectRatio: "1:1", framing: "fit", hasAudio: false, sourceFps: 25 });
    assert.ok(args.includes("-an"));
    assert.ok(!args.includes("[aout]"));
    assert.ok(!args.includes("-c:a"));
  });

  await test("render args reject relative, URL, option-like and protocol paths", () => {
    const base = { outputPath: OUT, startTime: 0, endTime: 10, aspectRatio: "16:9" as const, framing: "fit" as const, hasAudio: true, sourceFps: 30 };
    for (const inputPath of ["source.mp4", "https://evil.example/a.mp4", "concat:/a.mp4|/b.mp4", "-i", "file:/etc/passwd", "subfile:,,start,0,end,0,,:/x.mp4"]) {
      assert.throws(() => buildRenderArgs({ ...base, inputPath }), RenderConfigError, inputPath);
    }
    assert.throws(() => buildRenderArgs({ ...base, inputPath: SOURCE, outputPath: path.join(ROOT, "clip.mkv") }), RenderConfigError);
    assert.throws(() => buildRenderArgs({ ...base, inputPath: SOURCE, outputPath: SOURCE }), RenderConfigError);
    assert.throws(() => buildRenderArgs({ ...base, inputPath: SOURCE, startTime: 10, endTime: 10 }), RenderConfigError);
    assert.throws(() => buildRenderArgs({ ...base, inputPath: SOURCE, startTime: -1 }), RenderConfigError);
    assert.throws(() => buildRenderArgs({ ...base, inputPath: SOURCE, threads: 0 }), RenderConfigError);
  });

  await test("runner rejects FFmpeg pseudo-protocols and remote URLs", () => {
    for (const a of ["concat:a|b", "subfile:x", "data:video/mp4;base64,AA", "https://x", "rtmp://x", "tee:x", "crypto:x"]) {
      assert.throws(() => assertSafeSubprocessArgs(["-i", a]), UnsafeArgumentError, a);
    }
  });

  await test("thumbnail args: single frame, local PNG, bounded width", () => {
    const args = buildThumbnailArgs({ clipPath: OUT, framePath: path.join(ROOT, "p.png"), atSeconds: 2, width: 540 });
    assert.equal(argAfter(args, "-frames:v"), "1");
    assert.equal(argAfter(args, "-vf"), "scale=540:-2");
    assert.ok(args.includes("-n") && args.includes("-nostdin"));
    assert.throws(() => buildThumbnailArgs({ clipPath: OUT, framePath: path.join(ROOT, "p.jpg"), atSeconds: 2, width: 540 }), RenderConfigError);
    assert.throws(() => buildThumbnailArgs({ clipPath: OUT, framePath: path.join(ROOT, "p.png"), atSeconds: 2, width: 99999 }), RenderConfigError);
    assert.equal(choosePosterTimestamp(30), 3);
    assert.equal(choosePosterTimestamp(4), 1);
    assert.equal(choosePosterTimestamp(0), 0);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 3. Output validation (FFprobe + signature + size)");
  const vdir = await fsp.mkdtemp(path.join(ROOT, "validate-"));
  const goodClip = path.join(vdir, "good.mp4");
  await fsp.writeFile(goodClip, Buffer.concat([FTYP, Buffer.alloc(1000)]));
  const expected = { width: 1080, height: 1920, durationSeconds: 30, hasAudio: true };
  const probeRunner = (json: any | null) => {
    const r = new MockProcessRunner();
    r.registerHandler(() => {
      if (json === null) throw new ProcessExecutionError("probe failed", "PROCESS_EXIT_ERROR");
      return { stdout: JSON.stringify(json), stderr: "", exitCode: 0, durationMs: 1 };
    });
    return r;
  };
  const goodProbe = () => ({
    streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920 }, { codec_type: "audio", codec_name: "aac" }],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "30.02" },
  });

  await test("valid clip passes and reports actual size/duration", async () => {
    const v = await validateRenderedClip(goodClip, expected, probeRunner(goodProbe()));
    assert.equal(v.fileSizeBytes, 1016);
    assert.equal(v.durationSeconds, 30.02);
    assert.equal(v.hasAudio, true);
  });

  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ["missing file", () => validateRenderedClip(path.join(vdir, "nope.mp4"), expected, probeRunner(goodProbe())), "OUTPUT_MISSING"],
    ["empty file", async () => { const p = path.join(vdir, "empty.mp4"); await fsp.writeFile(p, ""); return validateRenderedClip(p, expected, probeRunner(goodProbe())); }, "OUTPUT_EMPTY"],
    ["too large", () => validateRenderedClip(goodClip, { ...expected, maxBytes: 100 }, probeRunner(goodProbe())), "OUTPUT_TOO_LARGE"],
    ["bad signature (extension not trusted)", async () => { const p = path.join(vdir, "fake.mp4"); await fsp.writeFile(p, "not a video at all"); return validateRenderedClip(p, expected, probeRunner(goodProbe())); }, "OUTPUT_BAD_SIGNATURE"],
    ["probe failure", () => validateRenderedClip(goodClip, expected, probeRunner(null)), "OUTPUT_PROBE_FAILED"],
    ["wrong container", () => validateRenderedClip(goodClip, expected, probeRunner({ ...goodProbe(), format: { format_name: "matroska,webm", duration: "30" } })), "OUTPUT_BAD_CONTAINER"],
    ["wrong codec", () => validateRenderedClip(goodClip, expected, probeRunner({ ...goodProbe(), streams: [{ codec_type: "video", codec_name: "hevc", width: 1080, height: 1920 }, { codec_type: "audio", codec_name: "aac" }] })), "OUTPUT_BAD_CODEC"],
    ["wrong dimensions", () => validateRenderedClip(goodClip, expected, probeRunner({ ...goodProbe(), streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1080 }, { codec_type: "audio", codec_name: "aac" }] })), "OUTPUT_BAD_DIMENSIONS"],
    ["duration outside tolerance", () => validateRenderedClip(goodClip, expected, probeRunner({ ...goodProbe(), format: { format_name: "mov,mp4", duration: "28.9" } })), "OUTPUT_BAD_DURATION"],
    ["expected audio missing", () => validateRenderedClip(goodClip, expected, probeRunner({ ...goodProbe(), streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920 }] })), "OUTPUT_AUDIO_MISMATCH"],
    ["visual-only clip with audio", () => validateRenderedClip(goodClip, { ...expected, hasAudio: false }, probeRunner(goodProbe())), "OUTPUT_AUDIO_MISMATCH"],
  ];
  for (const [name, fn, code] of cases) {
    await test(`validation rejects: ${name}`, async () => {
      await assert.rejects(fn, (e: any) => e instanceof OutputValidationError && e.code === code);
    });
  }

  // -------------------------------------------------------------------------
  console.log("\n# 4. Thumbnail extraction (real sharp, mocked FFmpeg frame)");
  await test("poster frame -> WebP file; intermediate PNG removed", async () => {
    const dir = await fsp.mkdtemp(path.join(ROOT, "thumb-"));
    const runner = fakeFfmpeg({ aspect: "9:16" });
    const t = await extractClipThumbnail({ clipPath: goodClip, framePath: path.join(dir, "p.png"), webpPath: path.join(dir, "p.webp"), durationSeconds: 30, runner });
    const meta = await sharp(t.filePath).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(t.sizeBytes, (await fsp.stat(t.filePath)).size);
    await assert.rejects(fsp.stat(path.join(dir, "p.png")));
  });

  await test("thumbnail over size limit is rejected and removed", async () => {
    const dir = await fsp.mkdtemp(path.join(ROOT, "thumb-"));
    const runner = fakeFfmpeg({ aspect: "9:16" });
    await assert.rejects(
      extractClipThumbnail({ clipPath: goodClip, framePath: path.join(dir, "p.png"), webpPath: path.join(dir, "p.webp"), durationSeconds: 30, runner, maxBytes: 10 }),
      (e: any) => e instanceof ClipThumbnailError && e.code === "THUMBNAIL_TOO_LARGE",
    );
    await assert.rejects(fsp.stat(path.join(dir, "p.webp")));
  });

  // -------------------------------------------------------------------------
  console.log("\n# 5. FfmpegClipperEngine (mocked subprocesses)");
  await test("engine refuses the mock runner unless explicitly allowed", () => {
    assert.throws(() => new FfmpegClipperEngine({ runner: new MockProcessRunner() }), (e: any) => e.code === "MOCK_RUNNER_REFUSED");
    assert.throws(() => new FfmpegClipperEngine({} as any), (e: any) => e.code === "RUNNER_REQUIRED");
  });

  for (const aspect of ASPECTS) {
    await test(`renderClip ${aspect}: file paths only, subtitles via cwd, validated, cleanup removes scratch`, async () => {
      const scratch = await newScratch();
      let subsSeen = false;
      const runner = fakeFfmpeg({
        aspect,
        onRender: async (args, options) => {
          assert.ok(options?.cwd, "cwd set to scratch dir");
          if (args.join(" ").includes("subtitles=filename=subs.ass")) {
            const ass = await fsp.readFile(path.join(options!.cwd!, "subs.ass"), "utf8");
            assert.ok(ass.includes(`PlayResX: ${CLIPPER_ASPECT_RATIOS[aspect].width}`));
            assert.ok(!ass.includes("{\\b1}"), "ASS injection sanitized");
            subsSeen = true;
          }
          assert.equal(options?.timeoutMs, 20_000);
        },
      });
      const engine = engineFor(runner);
      const r = await engine.renderClip({
        jobId: JOB, userId: USER, clipIndex: 0, source: createLocalFileSource(SOURCE),
        startTime: 5, endTime: 35, aspectRatio: aspect, framing: "pillarbox_blur", burnSubtitles: true,
        words: highlights()[0].words, scratchDir: scratch,
      });
      assert.ok(subsSeen);
      assert.equal(r.videoBuffer, undefined);
      assert.equal(r.thumbnailBuffer, undefined);
      assert.equal(r.isMockOutput, false);
      assert.equal(r.width, CLIPPER_ASPECT_RATIOS[aspect].width);
      assert.equal(r.height, CLIPPER_ASPECT_RATIOS[aspect].height);
      assert.equal(r.hasAudio, true);
      assert.ok(fs.existsSync(r.videoFilePath!));
      assert.ok(fs.existsSync(r.thumbnailFilePath!));
      assert.equal((await renderDirsIn(scratch)).length, 1);
      await r.cleanup!();
      await r.cleanup!(); // idempotent
      assert.equal((await renderDirsIn(scratch)).length, 0);
    });
  }

  await test("visual-only source: no subtitles even if requested, no audio stream expected", async () => {
    const scratch = await newScratch();
    const runner = fakeFfmpeg({ aspect: "1:1" });
    const r = await engineFor(runner).renderClip({
      jobId: JOB, userId: USER, clipIndex: 0, source: createLocalFileSource(SILENT_SOURCE),
      startTime: 5, endTime: 35, aspectRatio: "1:1", framing: "center_crop", burnSubtitles: true, words: highlights()[0].words, scratchDir: scratch,
    });
    const render = renderCalls(runner)[0];
    assert.ok(render.args.includes("-an"));
    assert.ok(!render.args.join(" ").includes("subtitles="));
    assert.equal(r.hasAudio, false);
    await r.cleanup!();
  });

  await test("no transcript words -> renders without subtitles (not an error)", async () => {
    const scratch = await newScratch();
    const runner = fakeFfmpeg({ aspect: "16:9" });
    const r = await engineFor(runner).renderClip({
      jobId: JOB, userId: USER, clipIndex: 0, source: createLocalFileSource(SOURCE),
      startTime: 5, endTime: 35, aspectRatio: "16:9", framing: "fit", burnSubtitles: true, words: [], scratchDir: scratch,
    });
    assert.ok(!renderCalls(runner)[0].args.join(" ").includes("subtitles="));
    await r.cleanup!();
  });

  await test("process timeout -> RENDER_TIMEOUT and scratch removed (no stderr leaked)", async () => {
    const scratch = await newScratch();
    const runner = fakeFfmpeg({ aspect: "9:16", renderMode: () => "timeout" });
    await assert.rejects(
      engineFor(runner).renderClip({ jobId: JOB, userId: USER, clipIndex: 0, source: createLocalFileSource(SOURCE), startTime: 5, endTime: 35, aspectRatio: "9:16", framing: "fit", burnSubtitles: false, scratchDir: scratch }),
      (e: any) => e instanceof ClipRenderError && e.code === "RENDER_TIMEOUT" && !e.message.includes("/secret"),
    );
    assert.equal((await renderDirsIn(scratch)).length, 0);
  });

  await test("FFmpeg failure / missing output / oversize output all fail closed with scratch removed", async () => {
    for (const [mode, code] of [["fail", "RENDER_FAILED"], ["nofile", "OUTPUT_MISSING"], ["huge", "OUTPUT_TOO_LARGE"]] as const) {
      const scratch = await newScratch();
      const runner = fakeFfmpeg({ aspect: "9:16", renderMode: () => mode });
      await assert.rejects(
        engineFor(runner).renderClip({ jobId: JOB, userId: USER, clipIndex: 0, source: createLocalFileSource(SOURCE), startTime: 5, endTime: 35, aspectRatio: "9:16", framing: "fit", burnSubtitles: false, scratchDir: scratch }),
        (e: any) => e.code === code,
        mode,
      );
      assert.equal((await renderDirsIn(scratch)).length, 0, mode);
    }
  });

  await test("wrong output dimensions from FFmpeg are rejected", async () => {
    const scratch = await newScratch();
    const runner = fakeFfmpeg({ aspect: "9:16", probeOverride: (j) => { j.streams[0].width = 1920; j.streams[0].height = 1080; return j; } });
    await assert.rejects(
      engineFor(runner).renderClip({ jobId: JOB, userId: USER, clipIndex: 0, source: createLocalFileSource(SOURCE), startTime: 5, endTime: 35, aspectRatio: "9:16", framing: "center_crop", burnSubtitles: false, scratchDir: scratch }),
      (e: any) => e.code === "OUTPUT_BAD_DIMENSIONS",
    );
  });

  await test("invalid clip window is rejected before FFmpeg runs", async () => {
    const runner = fakeFfmpeg({ aspect: "9:16" });
    await assert.rejects(
      engineFor(runner).renderClip({ jobId: JOB, userId: USER, clipIndex: 0, source: createLocalFileSource(SOURCE), startTime: 100, endTime: 130, aspectRatio: "9:16", framing: "fit", burnSubtitles: false }),
      ClipRenderError,
    );
    assert.equal(renderCalls(runner).length, 0);
  });

  await test("transcription is never faked: unavailable without a transcriber; visual-only bypasses; injected transcriber used", async () => {
    const runner = fakeFfmpeg({ aspect: "9:16" });
    await assert.rejects(engineFor(runner).transcribeAudio(createLocalFileSource(SOURCE)), TranscriptionUnavailableError);
    const silent = await engineFor(runner).transcribeAudio(createLocalFileSource(SILENT_SOURCE));
    assert.equal(silent.isVisualOnly, true);
    assert.equal(silent.segments.length, 0);
    let wav = "";
    const t = await engineFor(runner, {
      transcriber: async ({ wavPath }) => { wav = wavPath; return { segments: [], fullText: "ok", language: "en", isVisualOnly: false }; },
    }).transcribeAudio(createLocalFileSource(SOURCE));
    assert.equal(t.fullText, "ok");
    assert.ok(wav.endsWith("audio.wav"));
    assert.equal(fs.existsSync(wav), false, "temporary WAV removed");
  });

  // -------------------------------------------------------------------------
  console.log("\n# 6. LeaseKeeper (heartbeat, fencing, abort)");
  await test("heartbeat renews periodically while held", async () => {
    let calls = 0;
    const k = new LeaseKeeper({ leaseMs: 300, intervalMs: 20, renew: async () => { calls++; return true; } });
    k.start();
    await new Promise((r) => setTimeout(r, 90));
    k.stop();
    assert.ok(calls >= 2, `renewed ${calls}x`);
    assert.equal(k.lost, false);
  });

  await test("rejected renewal marks lease lost, aborts signal, fences renewNow", async () => {
    const k = new LeaseKeeper({ leaseMs: 300, intervalMs: 20, renew: async () => false });
    k.start();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(k.lost, true);
    assert.equal(k.signal.aborted, true);
    await assert.rejects(k.renewNow(), LeaseLostError);
    assert.throws(() => k.assertHeld(), LeaseLostError);
  });

  await test("transient renewal error tolerated within validity, lost once the grant runs out", async () => {
    let now = 0;
    const k = new LeaseKeeper({ leaseMs: 1000, intervalMs: 300, safetyMarginMs: 100, now: () => now, renew: async () => { throw new Error("db blip"); } });
    now = 300;
    await assert.rejects(k.renewNow());
    assert.equal(k.lost, false, "still within grant");
    now = 950;
    await assert.rejects(k.renewNow(), LeaseLostError);
    assert.equal(k.lost, true);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 7. Worker orchestration");
  async function runWorker(o: {
    aspect?: ClipperAspectRatio;
    renderMode?: (i: number) => RenderMode;
    lifecycle?: FakeLifecycle;
    storage?: ReturnType<typeof fakeStorage>;
    settingsOverride?: Partial<ClipperJobSettings>;
    hl?: CandidateHighlight[];
    engine?: VideoClipperEngine;
    source?: any;
    materializeOptions?: any;
    heartbeatMs?: number;
    leaseMs?: number;
  } = {}) {
    const scratch = await newScratch();
    const s = settings(o.settingsOverride);
    const runner = fakeFfmpeg({ aspect: s.targetAspectRatio, renderMode: o.renderMode });
    const lifecycle = o.lifecycle ?? fakeLifecycle({}, s.pendingCleanups);
    const store = o.storage ?? fakeStorage();
    const outcome = await processClipperJob(
      { job: { id: JOB, userId: USER, settings: s }, source: o.source ?? createLocalFileSource(SOURCE), highlights: o.hl ?? highlights(s.requestedClipsCount) },
      {
        engine: o.engine ?? engineFor(runner),
        lifecycle,
        storage: store.storage,
        scratchDir: scratch,
        materializeOptions: o.materializeOptions,
        leaseMs: o.leaseMs ?? 60_000,
        heartbeatMs: o.heartbeatMs ?? 5_000,
        logger: quietLogger,
      },
    );
    return { outcome, lifecycle, store, runner, scratch, s };
  }

  const SRC_KEY = `ephemeral/users/${USER}/uploads/upl_source0001.mp4`;

  await test("happy path: 3 clips rendered, streamed with real sizes, completed, then source deleted", async () => {
    const { outcome, lifecycle, store, runner, scratch } = await runWorker();
    assert.equal(outcome.status, "completed");
    if (outcome.status !== "completed") return;
    assert.equal(outcome.assetIds.length, 3);
    assert.equal(outcome.sourceCleanup, "deleted");
    assert.equal(lifecycle.st.status, "COMPLETED");
    assert.equal(lifecycle.st.refunds, 0);
    assert.equal(renderCalls(runner).length, 3);
    assert.equal(store.puts.length, 6, "3 clips + 3 thumbnails");
    for (const p of store.puts) {
      assert.equal(p.isBuffer, false, "streamed, never a Buffer");
      assert.ok(p.contentLength > 0 && p.contentLength === p.bytes);
      assert.ok(p.key.startsWith(`users/${USER}/clips/${JOB}/`));
    }
    assert.deepEqual(store.deleted, [SRC_KEY]);
    const completeAt = lifecycle.st.events.indexOf("complete");
    assert.ok(completeAt >= 0);
    assert.ok(store.events.indexOf(`delete:${SRC_KEY}`) > store.events.lastIndexOf(store.events.find((e) => e.startsWith("put:"))!), "source deleted after uploads");
    assert.ok(lifecycle.st.renewCalls >= 7, `fenced renewals: ${lifecycle.st.renewCalls}`);
    assert.deepEqual(lifecycle.st.pending.size, 0);
    assert.equal((await renderDirsIn(scratch)).length, 0, "scratch cleaned");
    assert.equal(fs.existsSync(SOURCE), true, "caller-owned local source file untouched");
  });

  await test("source is preserved until completion: no delete before complete()", async () => {
    let deletesBeforeComplete = -1;
    const store = fakeStorage();
    const lifecycle = fakeLifecycle({
      complete: async (p, self) => {
        deletesBeforeComplete = store.deleted.length;
        self.st.status = "COMPLETED";
        self.st.assetKeys = p.clips.map((c: any) => c.storageKey);
        return { jobId: p.jobId, assetIds: p.clips.map((c: any) => c.assetId) };
      },
    });
    const { outcome } = await runWorker({ lifecycle, storage: store });
    assert.equal(outcome.status, "completed");
    assert.equal(deletesBeforeComplete, 0);
  });

  await test("render failure on clip 2: uploaded clip-1 objects deleted, fenced FAILED+refund, source then deleted", async () => {
    const { outcome, lifecycle, store, scratch } = await runWorker({ renderMode: (i) => (i === 1 ? "fail" : "ok") });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.code, "RENDER_FAILED");
    assert.equal(lifecycle.st.status, "FAILED");
    assert.equal(lifecycle.st.refunds, 1);
    assert.equal(lifecycle.st.events.includes("complete"), false);
    assert.equal(store.puts.length, 2);
    assert.equal(store.objects.size, 0, "no orphaned clip/thumbnail left");
    assert.ok(store.deleted.includes(SRC_KEY));
    assert.ok(store.events.indexOf(`delete:${SRC_KEY}`) > store.events.findIndex((e) => e.startsWith("delete:users/")), "outputs removed before source");
    assert.equal((await renderDirsIn(scratch)).length, 0);
  });

  await test("lease lost DURING a long render: FFmpeg aborted, no settlement/refund, source preserved, own uploads deleted", async () => {
    const lifecycle = fakeLifecycle({ renew: (n) => n < 3 }); // ok for clip1 fences, then rejected by heartbeat
    const { outcome, store } = await runWorker({ lifecycle, heartbeatMs: 15, renderMode: (i) => (i === 1 ? "hang" : "ok") });
    assert.equal(outcome.status, "lease_lost");
    assert.equal(lifecycle.st.refunds, 0);
    assert.equal(lifecycle.st.events.includes("failFenced"), false, "a worker without the lease never attempts settlement");
    assert.equal(lifecycle.st.events.includes("complete"), false);
    assert.equal(store.deleted.includes(SRC_KEY), false, "source preserved for the new lease owner");
    assert.equal(store.objects.size, 0, "this worker's uploads removed");
  });

  await test("lease rejected at the fence before clip 2: stops immediately, nothing settled", async () => {
    const lifecycle = fakeLifecycle({ renew: (n) => n < 2 });
    const { outcome, runner, store } = await runWorker({ lifecycle });
    assert.equal(outcome.status, "lease_lost");
    assert.equal(renderCalls(runner).length, 1);
    assert.equal(lifecycle.st.refunds, 0);
    assert.equal(store.deleted.includes(SRC_KEY), false);
  });

  await test("completion fenced out (JobNotCompletableError): uploads deleted, NO refund, source kept", async () => {
    const lifecycle = fakeLifecycle({ complete: async (p) => { throw new JobNotCompletableError(p.jobId); } });
    const { outcome, store } = await runWorker({ lifecycle });
    assert.equal(outcome.status, "lease_lost");
    assert.equal(lifecycle.st.refunds, 0);
    assert.equal(lifecycle.st.events.includes("failFenced"), false);
    assert.equal(store.objects.size, 0);
    assert.equal(store.deleted.includes(SRC_KEY), false);
  });

  await test("ambiguous completion that actually committed: treated as completed, assets NOT deleted", async () => {
    const lifecycle = fakeLifecycle({
      complete: async (p, self) => {
        self.st.status = "COMPLETED";
        self.st.assetKeys = p.clips.flatMap((c: any) => [c.storageKey, c.thumbnailKey]);
        throw new Error("connection reset during COMMIT");
      },
    });
    const { outcome, store } = await runWorker({ lifecycle });
    assert.equal(outcome.status, "completed");
    assert.equal(store.objects.size, 6, "registered assets kept");
    assert.deepEqual(store.deleted, [SRC_KEY]);
    assert.equal(lifecycle.st.refunds, 0, "a completed job is never refunded");
  });

  await test("ambiguous completion with unreadable state: delete NOTHING, report settlement_unknown", async () => {
    const lifecycle = fakeLifecycle({
      complete: async () => { throw new Error("socket hang up"); },
      cleanupState: async () => { throw new Error("db unreachable"); },
    });
    const { outcome, store } = await runWorker({ lifecycle });
    assert.equal(outcome.status, "settlement_unknown");
    if (outcome.status === "settlement_unknown") assert.equal(outcome.uploadedKeys.length, 6);
    assert.equal(store.deleted.length, 0);
    assert.equal(lifecycle.st.refunds, 0);
  });

  await test("ambiguous completion that rolled back: uploads deleted, fenced FAILED+refund, source deleted", async () => {
    const lifecycle = fakeLifecycle({ complete: async () => { throw new Error("serialization failure"); } });
    const { outcome, store } = await runWorker({ lifecycle });
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.equal(outcome.code, "COMPLETION_FAILED");
    assert.equal(lifecycle.st.refunds, 1);
    assert.equal(store.objects.size, 0);
    assert.ok(store.deleted.includes(SRC_KEY));
  });

  await test("failed deletions are recorded for retry (outputs + source) and never affect settlement", async () => {
    const store = fakeStorage({ failDelete: () => true });
    const { outcome, lifecycle } = await runWorker({ storage: store, renderMode: (i) => (i === 2 ? "fail" : "ok") });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.sourceCleanup, "pending_retry");
    assert.equal(outcome.pendingCleanupKeys.length, 5, "4 outputs + source");
    assert.equal(lifecycle.st.refunds, 1, "refund happened exactly once regardless of cleanup failures");
    const failedKeys = lifecycle.st.recorded.filter((r) => !r.success).map((r) => r.key);
    assert.equal(failedKeys.length, 5);
    for (const k of outcome.pendingCleanupKeys) assert.ok(lifecycle.st.pending.has(k));
  });

  await test("source deletion failure after success is recorded; job stays COMPLETED", async () => {
    const store = fakeStorage({ failDelete: (k) => k === SRC_KEY });
    const { outcome, lifecycle } = await runWorker({ storage: store });
    assert.equal(outcome.status, "completed");
    if (outcome.status === "completed") assert.equal(outcome.sourceCleanup, "pending_retry");
    assert.equal(lifecycle.st.status, "COMPLETED");
    assert.ok(lifecycle.st.pending.has(SRC_KEY));
  });

  await test("upload failure mid-stream: partial key tracked and deleted, job failed+refunded", async () => {
    const store = fakeStorage({ failPut: (k) => k.endsWith("-thumb.webp") });
    const { outcome, lifecycle } = await runWorker({ storage: store });
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.equal(outcome.code, "UPLOAD_FAILED");
    assert.equal(lifecycle.st.refunds, 1);
    const thumbKey = store.puts.find((p) => p.key.endsWith("-thumb.webp"))!.key;
    assert.ok(store.deleted.includes(thumbKey), "possibly-created partial object is deleted");
  });

  await test("platform_asset source (user's own generated video) is NEVER deleted", async () => {
    const platformKey = `users/${USER}/videos/vid_asset0001.mp4`;
    for (const mode of ["ok", "fail"] as const) {
      const { outcome, store } = await runWorker({
        settingsOverride: { sourceType: "platform_asset", sourceKey: platformKey, pendingCleanups: [] },
        renderMode: () => mode,
      });
      assert.equal(store.deleted.includes(platformKey), false, mode);
      if (outcome.status === "completed" || outcome.status === "failed") assert.equal(outcome.sourceCleanup, "retained_platform_asset");
    }
  });

  await test("fenced failure not settled (lease taken over): no source deletion, reported lease_lost", async () => {
    const lifecycle = fakeLifecycle();
    const orig = lifecycle.failFenced;
    lifecycle.failFenced = async (p) => { lifecycle.st.token = "tok_other_worker"; return orig(p); };
    const { outcome, store } = await runWorker({ lifecycle, renderMode: () => "fail" });
    assert.equal(outcome.status, "lease_lost");
    assert.equal(lifecycle.st.refunds, 0);
    assert.equal(store.deleted.includes(SRC_KEY), false);
  });

  await test("settlement error leaves outcome unknown and source untouched", async () => {
    const lifecycle = fakeLifecycle({ failFencedThrows: true });
    const { outcome, store } = await runWorker({ lifecycle, renderMode: () => "fail" });
    assert.equal(outcome.status, "settlement_unknown");
    assert.equal(store.deleted.includes(SRC_KEY), false);
  });

  await test("not claimed: worker does nothing (no materialize, no render, no storage)", async () => {
    let materialized = 0;
    const source = { kind: "local_file", identifier: "x", materialize: async () => { materialized++; throw new Error("should not run"); }, dispose: async () => {} };
    const { outcome, store, runner } = await runWorker({ lifecycle: fakeLifecycle({ claim: false }), source });
    assert.equal(outcome.status, "not_claimed");
    assert.equal(materialized, 0);
    assert.equal(runner.callHistory.length, 0);
    assert.equal(store.events.length, 0);
  });

  await test("engine returning buffers (MockClipperEngine) is refused: nothing stored, job failed+refunded", async () => {
    const { outcome, store, lifecycle } = await runWorker({ engine: new MockClipperEngine() });
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.equal(outcome.code, "ENGINE_OUTPUT_NOT_FILE");
    assert.equal(store.puts.length, 0);
    assert.equal(lifecycle.st.refunds, 1);
  });

  await test("fewer highlights than paid-for clips: fails with refund before any render", async () => {
    const { outcome, runner, lifecycle } = await runWorker({ hl: highlights(2) });
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.equal(outcome.code, "INSUFFICIENT_HIGHLIGHTS");
    assert.equal(renderCalls(runner).length, 0);
    assert.equal(lifecycle.st.refunds, 1);
  });

  await test("visual-only job: clips rendered without audio or subtitles", async () => {
    const scratch = await newScratch();
    const s = settings({ isVisualOnly: true, burnSubtitles: false, requestedClipsCount: 1, targetAspectRatio: "16:9" });
    const runner = fakeFfmpeg({ aspect: "16:9", sourceHasAudio: false });
    const store = fakeStorage();
    const outcome = await processClipperJob(
      { job: { id: JOB, userId: USER, settings: s }, source: createLocalFileSource(SILENT_SOURCE), highlights: highlights(1) },
      { engine: engineFor(runner), lifecycle: fakeLifecycle(), storage: store.storage, scratchDir: scratch, logger: quietLogger },
    );
    assert.equal(outcome.status, "completed");
    const args = renderCalls(runner)[0].args;
    assert.ok(args.includes("-an"));
    assert.ok(!args.join(" ").includes("subtitles="));
  });

  await test("storage-reference source is downloaded ONCE and its scratch copy removed", async () => {
    let downloads = 0;
    const src = createStorageReferenceSource(SRC_KEY, { fileSizeBytes: 2064 });
    const { outcome, scratch } = await runWorker({
      source: src,
      materializeOptions: {
        downloadStreamProvider: async () => { downloads++; return fs.createReadStream(SOURCE); },
      },
    });
    assert.equal(outcome.status, "completed");
    assert.equal(downloads, 1);
    const leftovers = (await fsp.readdir(scratch)).filter((n) => n.startsWith("clipper_src_"));
    assert.equal(leftovers.length, 0);
  });

  await test("planClips runs on the materialized local source under the lease", async () => {
    const scratch = await newScratch();
    const runner = fakeFfmpeg({ aspect: "9:16" });
    let sawKind = "";
    const outcome = await processClipperJob(
      {
        job: { id: JOB, userId: USER, settings: settings({ requestedClipsCount: 1 }) },
        source: createLocalFileSource(SOURCE),
        planClips: async ({ source, metadata, signal }) => {
          sawKind = source.kind;
          assert.equal(metadata.hasAudio, true);
          assert.equal(signal.aborted, false);
          return highlights(1);
        },
      },
      { engine: engineFor(runner), lifecycle: fakeLifecycle(), storage: fakeStorage().storage, scratchDir: scratch, logger: quietLogger },
    );
    assert.equal(outcome.status, "completed");
    assert.equal(sawKind, "local_file");
  });

  await test("no complete video is ever read into memory (readFile on .mp4 forbidden during a run)", async () => {
    const origReadFile = fsp.readFile;
    const origReadFileSync = fs.readFileSync;
    const guard = (p: unknown) => {
      if (String(p).toLowerCase().endsWith(".mp4")) throw new Error(`forbidden full read of ${String(p)}`);
    };
    (fsp as any).readFile = async (p: any, ...rest: any[]) => { guard(p); return (origReadFile as any)(p, ...rest); };
    (fs as any).readFileSync = (p: any, ...rest: any[]) => { guard(p); return (origReadFileSync as any)(p, ...rest); };
    try {
      const { outcome } = await runWorker();
      assert.equal(outcome.status, "completed");
    } finally {
      (fsp as any).readFile = origReadFile;
      (fs as any).readFileSync = origReadFileSync;
    }
  });

  // -------------------------------------------------------------------------
  console.log("\n# 8. Retryable cleanup sweep");
  await test("retry deletes only eligible keys of a terminal job; skips registered assets and foreign keys", async () => {
    const registered = `users/${USER}/clips/${JOB}/clip_registered1.mp4`;
    const orphan = `users/${USER}/clips/${JOB}/clip_orphan00001.mp4`;
    const otherJob = `users/${USER}/clips/job_otherjob01/clip_orphan00002.mp4`;
    const foreign = `users/usr_someoneelse/clips/${JOB}/clip_orphan00003.mp4`;
    const lifecycle = fakeLifecycle({
      cleanupState: async () => ({
        id: JOB, userId: USER, status: "COMPLETED",
        settings: { ...settings(), pendingCleanups: [registered, orphan, otherJob, foreign, SRC_KEY] },
        assetKeys: [registered],
      }),
    });
    const store = fakeStorage();
    const res = await retryClipperPendingCleanups(JOB, { lifecycle, storage: store.storage });
    assert.deepEqual(store.deleted.sort(), [orphan, SRC_KEY].sort());
    assert.deepEqual(res.skipped.sort(), [registered, otherJob, foreign].sort());
    assert.equal(res.deleted, 2);
  });

  await test("retry does nothing for non-terminal jobs and never deletes platform-asset sources", async () => {
    const store = fakeStorage();
    const active = fakeLifecycle({ cleanupState: async () => ({ id: JOB, userId: USER, status: "PROCESSING", settings: settings(), assetKeys: [] }) });
    assert.equal((await retryClipperPendingCleanups(JOB, { lifecycle: active, storage: store.storage })).attempted, 0);
    const platformKey = `users/${USER}/videos/vid_asset0001.mp4`;
    const done = fakeLifecycle({
      cleanupState: async () => ({ id: JOB, userId: USER, status: "FAILED", settings: settings({ sourceType: "platform_asset", sourceKey: platformKey, pendingCleanups: [platformKey] }), assetKeys: [] }),
    });
    await retryClipperPendingCleanups(JOB, { lifecycle: done, storage: store.storage });
    assert.equal(store.deleted.length, 0);
  });

  // -------------------------------------------------------------------------
  console.log("\n# 9. Real FFmpeg encode (only when ffmpeg + ffprobe are installed)");
  const sys = new SystemProcessRunner();
  const realAvailable = (await sys.isAvailable("ffmpeg")) && (await sys.isAvailable("ffprobe"));
  if (!realAvailable) {
    for (const name of ["real encode 9:16 pillarbox_blur + subtitles + loudnorm", "real encode 1:1 center_crop visual-only", "real encode 16:9 fit + thumbnail"]) {
      skip(name, "ffmpeg/ffprobe not found on PATH");
    }
  } else {
    const realDir = await fsp.mkdtemp(path.join(ROOT, "real-"));
    const realSrc = path.join(realDir, "real_source.mp4");
    const realSilent = path.join(realDir, "real_silent.mp4");
    await sys.execute("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", realSrc], { timeoutMs: 120_000 });
    await sys.execute("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", realSilent], { timeoutMs: 120_000 });
    const real = new FfmpegClipperEngine({ runner: sys, renderTimeoutMs: 300_000 });
    const realCase = async (file: string, aspect: ClipperAspectRatio, framing: ClipperFramingMode, subs: boolean) => {
      const r = await real.renderClip({
        jobId: JOB, userId: USER, clipIndex: 0, source: createLocalFileSource(file), startTime: 2, endTime: 9,
        aspectRatio: aspect, framing, burnSubtitles: subs, words: highlights()[0].words, scratchDir: realDir,
      });
      try {
        assert.equal(r.width, CLIPPER_ASPECT_RATIOS[aspect].width);
        assert.equal(r.height, CLIPPER_ASPECT_RATIOS[aspect].height);
        assert.ok(Math.abs(r.durationSeconds - 7) <= 0.5);
        assert.equal((await sharp(r.thumbnailFilePath!).metadata()).format, "webp");
      } finally {
        await r.cleanup!();
      }
    };
    await test("REAL encode 9:16 pillarbox_blur + subtitles + loudnorm", () => realCase(realSrc, "9:16", "pillarbox_blur", true));
    await test("REAL encode 1:1 center_crop visual-only", () => realCase(realSilent, "1:1", "center_crop", false));
    await test("REAL encode 16:9 fit + thumbnail", () => realCase(realSrc, "16:9", "fit", false));
  }

  await fsp.rm(ROOT, { recursive: true, force: true });

  console.log("\n=======================================================");
  console.log(`  Tests Passed:  ${passed}`);
  console.log(`  Tests Failed:  ${failed}`);
  console.log(`  Tests Skipped: ${skipped}${skipped ? " (real FFmpeg encode NOT verified)" : ""}`);
  console.log("=======================================================\n");
  if (failed > 0) process.exit(1);
}

run().catch(async (err) => {
  console.error("Unhandled test execution error:", err);
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
