// Stage 9 Batch 7: REAL FFmpeg orientation suite. Generates fixtures locally with lavfi (no
// network, no storage, no database) and runs the production metadata, scene, silence, planning and
// render code against them. Requires ffmpeg + ffprobe on PATH; otherwise every case is reported as
// SKIPPED (never passed). Run: npm run test:clipper-ffmpeg
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import * as clipperNs from "../src/features/clipper/index";
const clipper = ((clipperNs as any).default ?? clipperNs) as typeof clipperNs;
const {
  SystemProcessRunner,
  FfmpegClipperEngine,
  createLocalFileSource,
  validateSourceMetadata,
  sourceOrientation,
  planScenePacingClips,
  CLIPPER_ASPECT_RATIOS,
} = clipper;
type ClipperAspectRatio = clipperNs.ClipperAspectRatio;
type ClipperFramingMode = clipperNs.ClipperFramingMode;

let passed = 0;
let failed = 0;
let skipped = 0;
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

const JOB = "job_realffmpeg01";
const USER = "usr_realffmpeg01";
const sys = new SystemProcessRunner();

/** 30 s fixture: five visually distinct 6 s segments (scene cuts at 6/12/18/24 s) + a tone with
 *  two silent gaps (6–8 s and 18–20 s). */
async function makeFixture(file: string, w: number, h: number) {
  const seg = `s=${w}x${h}:r=30:d=6`;
  const filter =
    `color=c=red:${seg}[a];` +
    `testsrc2=${seg}[b];` +
    `color=c=blue:${seg}[c];` +
    `smptebars=${seg}[d];` +
    `color=c=green:${seg}[e];` +
    "[a][b][c][d][e]concat=n=5:v=1:a=0,format=yuv420p[v];" +
    "sine=frequency=440:duration=30,volume=enable='between(t,6,8)+between(t,18,20)':volume=0[au]";
  await sys.execute(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-filter_complex", filter, "-map", "[v]", "-map", "[au]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", file],
    { timeoutMs: 300_000 },
  );
}

async function probeStreams(file: string) {
  const r = await sys.execute("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: 30_000 });
  return JSON.parse(r.stdout) as { streams: any[]; format: any };
}

/** Decodes one frame (with FFmpeg's default autorotate) and returns RGB at (x%, y%). */
async function sampleFrame(file: string, at: number, points: Array<[number, number]>) {
  const png = `${file}.${at}.png`;
  await sys.execute("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1", png], { timeoutMs: 60_000 });
  const buf = await fsp.readFile(png);
  const img = sharp(buf);
  const { width, height } = await img.metadata();
  const raw = await img.removeAlpha().raw().toBuffer();
  await fsp.rm(png, { force: true });
  return {
    width: width!,
    height: height!,
    colors: points.map(([px, py]) => {
      const x = Math.min(width! - 1, Math.floor((px / 100) * width!));
      const y = Math.min(height! - 1, Math.floor((py / 100) * height!));
      const i = (y * width! + x) * 3;
      return [raw[i], raw[i + 1], raw[i + 2]] as [number, number, number];
    }),
  };
}
const isRed = ([r, g, b]: number[]) => r > 180 && g < 80 && b < 80;
const isBlue = ([r, g, b]: number[]) => b > 180 && r < 80 && g < 80;

async function run() {
  const available = (await sys.isAvailable("ffmpeg")) && (await sys.isAvailable("ffprobe"));
  const names = [
    "fixtures: portrait/landscape/square generated",
    "portrait 1080x1920: metadata, scenes, silence, planning, 3 renders",
    "landscape 1920x1080: metadata, scenes, silence, planning, 3 renders",
    "square 1080x1080: metadata, scenes, silence, planning, 3 renders",
    "rotated phone file: coded landscape + rotation → display portrait, rendered upright",
    "4K portrait is rejected by real metadata validation",
    "framing modes on a portrait source keep the requested canvas",
  ];
  if (!available) {
    for (const n of names) {
      console.log(`SKIP  ${n} (ffmpeg/ffprobe not found on PATH)`);
      skipped++;
    }
    return summary();
  }
  const version = (await sys.execute("ffmpeg", ["-hide_banner", "-version"], { timeoutMs: 10_000 })).stdout.split("\n")[0];
  console.log(`# Using ${version.trim()}`);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper-real-"));
  const engine = new FfmpegClipperEngine({ runner: sys, renderTimeoutMs: 300_000, threads: 2 });
  const fixtures: Record<string, { file: string; w: number; h: number }> = {
    portrait: { file: path.join(dir, "portrait.mp4"), w: 1080, h: 1920 },
    landscape: { file: path.join(dir, "landscape.mp4"), w: 1920, h: 1080 },
    square: { file: path.join(dir, "square.mp4"), w: 1080, h: 1080 },
  };

  try {
    await test(names[0], async () => {
      for (const f of Object.values(fixtures)) {
        await makeFixture(f.file, f.w, f.h);
        const p = await probeStreams(f.file);
        const v = p.streams.find((s) => s.codec_type === "video");
        assert.deepEqual([v.width, v.height], [f.w, f.h]);
        assert.ok(p.streams.some((s) => s.codec_type === "audio"));
      }
    });

    const orientationCase = (label: "portrait" | "landscape" | "square", idx: number) =>
      test(names[idx], async () => {
        const f = fixtures[label];
        const source = createLocalFileSource(f.file);
        const meta = await engine.extractMetadata(source);
        assert.deepEqual([meta.width, meta.height], [f.w, f.h]);
        assert.equal(meta.rotationDegrees, 0);
        assert.equal(sourceOrientation(meta.width, meta.height), label);
        assert.ok(Math.abs(meta.durationSeconds - 30) < 0.6, `duration ${meta.durationSeconds}`);
        const v = validateSourceMetadata(meta);
        assert.equal(v.valid, true, JSON.stringify(v));

        const cuts = await engine.detectScenes(source);
        const times = cuts.map((c) => c.timestampSeconds);
        for (const expected of [6, 12, 18, 24]) {
          assert.ok(times.some((t) => Math.abs(t - expected) < 0.6), `scene cut near ${expected}s in [${times.map((t) => t.toFixed(2)).join(", ")}]`);
        }

        const silences = await engine.detectSilence(source);
        for (const [s, e] of [[6, 8], [18, 20]]) {
          assert.ok(
            silences.some((x) => Math.abs(x.start - s) < 0.6 && Math.abs(x.end - e) < 0.6),
            `silence ${s}-${e}s in ${JSON.stringify(silences)}`,
          );
        }

        const plan = await planScenePacingClips(
          { engine, source, metadata: meta, signal: new AbortController().signal } as any,
          { requestedClipsCount: 2, targetAspectRatio: "9:16", targetFraming: "pillarbox_blur" },
        );
        assert.ok(plan.length >= 1 && plan.length <= 2, `planned ${plan.length}`);
        for (const h of plan) {
          assert.ok(h.startTime >= 0 && h.endTime <= meta.durationSeconds + 0.01 && h.endTime - h.startTime >= 5);
          assert.deepEqual(h.words, [], "no fabricated words");
        }

        const framing: ClipperFramingMode = label === "landscape" ? "center_crop" : label === "square" ? "fit" : "pillarbox_blur";
        for (const aspect of ["9:16", "1:1", "16:9"] as ClipperAspectRatio[]) {
          const r = await engine.renderClip({
            jobId: JOB,
            userId: USER,
            clipIndex: 0,
            source,
            startTime: 3,
            endTime: 10,
            aspectRatio: aspect,
            framing,
            burnSubtitles: false,
            sourceMetadata: meta,
            scratchDir: dir,
          });
          try {
            assert.deepEqual([r.width, r.height], [CLIPPER_ASPECT_RATIOS[aspect].width, CLIPPER_ASPECT_RATIOS[aspect].height], `${label}→${aspect}`);
            const out = await probeStreams(r.videoFilePath!);
            const ov = out.streams.find((s) => s.codec_type === "video");
            assert.deepEqual([ov.width, ov.height], [CLIPPER_ASPECT_RATIOS[aspect].width, CLIPPER_ASPECT_RATIOS[aspect].height], "probed output size");
            assert.equal(ov.codec_name, "h264");
            assert.ok(out.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac"), "original audio kept");
            assert.ok(Math.abs(Number(out.format.duration) - 7) <= 0.5, `duration ${out.format.duration}`);
            assert.equal((await sharp(await fsp.readFile(r.thumbnailFilePath!)).metadata()).format, "webp");
          } finally {
            await r.cleanup!();
          }
        }
      });
    await orientationCase("portrait", 1);
    await orientationCase("landscape", 2);
    await orientationCase("square", 3);

    await test(names[4], async () => {
      // Upright portrait content: top half red, bottom half blue (display orientation).
      const upright = path.join(dir, "upright.mp4");
      await sys.execute(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-filter_complex",
          "color=c=red:s=1080x960:r=30:d=20[t];color=c=blue:s=1080x960:r=30:d=20[b];[t][b]vstack=inputs=2,format=yuv420p[v];sine=frequency=330:duration=20[a]",
          "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", upright],
        { timeoutMs: 120_000 },
      );
      // Phone-style storage: frames turned into landscape (coded 1920x1080) + a display rotation
      // that turns them back upright. Try both rotation signs and keep the one FFmpeg decodes upright.
      const coded = path.join(dir, "coded.mp4");
      await sys.execute("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", upright, "-vf", "transpose=1", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "copy", coded], { timeoutMs: 120_000 });
      let phone = "";
      for (const rot of ["90", "-90"]) {
        const candidate = path.join(dir, `phone_${rot}.mp4`);
        await sys.execute("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-display_rotation", rot, "-i", coded, "-c", "copy", candidate], { timeoutMs: 60_000 });
        const s = await sampleFrame(candidate, 1, [[50, 10], [50, 90]]);
        if (s.width === 1080 && s.height === 1920 && isRed(s.colors[0]) && isBlue(s.colors[1])) {
          phone = candidate;
          break;
        }
      }
      assert.ok(phone, "constructed a rotated phone-style fixture that FFmpeg decodes upright");
      const raw = (await probeStreams(phone)).streams.find((s) => s.codec_type === "video");
      assert.deepEqual([raw.width, raw.height], [1920, 1080], "coded frames are landscape");

      const source = createLocalFileSource(phone);
      const meta = await engine.extractMetadata(source);
      assert.deepEqual([meta.width, meta.height], [1080, 1920], "display dimensions reported");
      assert.deepEqual([meta.codedWidth, meta.codedHeight], [1920, 1080]);
      assert.ok(meta.rotationDegrees === 90 || meta.rotationDegrees === 270, `rotation ${meta.rotationDegrees}`);
      assert.equal(validateSourceMetadata(meta).valid, true);

      const r = await engine.renderClip({ jobId: JOB, userId: USER, clipIndex: 0, source, startTime: 2, endTime: 9, aspectRatio: "9:16", framing: "fit", burnSubtitles: false, sourceMetadata: meta, scratchDir: dir });
      try {
        const out = await sampleFrame(r.videoFilePath!, 2, [[50, 20], [50, 80]]);
        assert.deepEqual([out.width, out.height], [1080, 1920]);
        assert.ok(isRed(out.colors[0]) && isBlue(out.colors[1]), `rendered upright (top red, bottom blue): ${JSON.stringify(out.colors)}`);
        const ov = (await probeStreams(r.videoFilePath!)).streams.find((s) => s.codec_type === "video");
        const sideRot = (ov.side_data_list ?? []).find((d: any) => d.rotation !== undefined)?.rotation;
        assert.ok(!sideRot || Number(sideRot) === 0, "output carries no residual rotation");
      } finally {
        await r.cleanup!();
      }
    });

    await test(names[5], async () => {
      const big = path.join(dir, "portrait4k.mp4");
      await sys.execute(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=2160x3840:r=2:d=16", "-f", "lavfi", "-i", "sine=duration=16", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", big],
        { timeoutMs: 300_000 },
      );
      // Production metadata extraction validates domain limits itself and refuses the file.
      await assert.rejects(() => engine.extractMetadata(createLocalFileSource(big)), (e: any) => e.code === "RESOLUTION_TOO_HIGH");
      const raw = (await probeStreams(big)).streams.find((x) => x.codec_type === "video");
      assert.deepEqual([raw.width, raw.height], [2160, 3840], "fixture really is 4K portrait");
    });

    await test(names[6], async () => {
      const source = createLocalFileSource(fixtures.portrait.file);
      const meta = await engine.extractMetadata(source);
      for (const framing of ["center_crop", "fit"] as ClipperFramingMode[]) {
        const r = await engine.renderClip({ jobId: JOB, userId: USER, clipIndex: 1, source, startTime: 13, endTime: 19, aspectRatio: "16:9", framing, burnSubtitles: false, sourceMetadata: meta, scratchDir: dir });
        try {
          assert.deepEqual([r.width, r.height], [1920, 1080], framing);
        } finally {
          await r.cleanup!();
        }
      }
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return summary();
}

function summary() {
  console.log(`\n  Tests Passed:  ${passed}\n  Tests Failed:  ${failed}\n  Tests Skipped: ${skipped}${skipped ? " (real FFmpeg NOT verified)" : ""}\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Unhandled test error:", e);
  process.exit(1);
});
