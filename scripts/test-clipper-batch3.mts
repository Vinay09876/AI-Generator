/**
 * Stage 9 — Batch 3: Video Analysis, Audio Processing & Highlight Detection Test Suite.
 *
 * Verifies all Batch 3 components offline with ZERO network calls, ZERO database mutations,
 * and ZERO external API usage:
 * 1. Safe subprocess runner & security boundary (argument validation, URL/SSRF rejection, mock runner).
 * 2. Video metadata extraction via FFprobe abstraction (fractional FPS, visual-only detection, bounds check).
 * 3. Audio stream extraction & silence detection (visual-only bypass, silencedetect stderr parsing).
 * 4. Visual scene cut detection (monotonic ordering, de-bouncing, origin fallback).
 * 5. Whisper transcript parser (JSON with/without word timestamps, WebVTT, SRT, interpolation safeguard).
 * 6. Deterministic highlight scoring engine (speech density, hook detection, silence penalty, scene snap, visual-only).
 * 7. ASS & SRT subtitle generator (resolution styles, karaoke centisecond tags, injection sanitization).
 */

import assert from "node:assert/strict";
import {
  assertSafeSubprocessArgs,
  MockProcessRunner,
  ProcessExecutionError,
  UnsafeArgumentError,
} from "../src/features/clipper/analysis/runner";
import {
  extractVideoMetadata,
  parseFfprobeJson,
  parseFpsFraction,
  MetadataExtractionError,
} from "../src/features/clipper/analysis/metadata";
import {
  extractAudioTrack,
  detectAudioSilence,
  parseFfmpegSilenceOutput,
} from "../src/features/clipper/analysis/audio";
import {
  detectSceneCuts,
  parseFfmpegSceneOutput,
} from "../src/features/clipper/analysis/scene";
import {
  parseSrtTranscript,
  parseTranscriptAuto,
  parseVttTranscript,
  parseWhisperJson,
  parseTimestampToSeconds,
  interpolateSegmentWords,
} from "../src/features/clipper/analysis/transcription";
import {
  scoreCandidateHighlights,
} from "../src/features/clipper/analysis/highlight";
import {
  chunkWords,
  formatAssTimestamp,
  formatSrtTimestamp,
  generateAssSubtitles,
  generateSrtSubtitles,
  sanitizeAssText,
} from "../src/features/clipper/subtitles/ass-generator";
import { createLocalFileSource } from "../src/features/clipper/source";
import type { CandidateHighlight, TranscriptResult, VideoMetadata } from "../src/features/clipper/types";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`FAIL  ${name}: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    failed++;
  }
}

async function run() {
  console.log("\n=======================================================");
  console.log("  Stage 9 — Batch 3: Video Analysis & Subtitle Tests   ");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------------
  // 1. Safe Subprocess Runner & Security Boundaries
  // -------------------------------------------------------------------------
  console.log("# 1. Subprocess Runner & Security Boundaries");

  await test("assertSafeSubprocessArgs accepts valid filesystem paths and flags", () => {
    assert.doesNotThrow(() => {
      assertSafeSubprocessArgs([
        "-v",
        "quiet",
        "-i",
        "C:\\scratch\\temp-video.mp4",
        "-filter:v",
        "select='gt(scene,0.3)'",
      ]);
    });
  });

  await test("assertSafeSubprocessArgs strictly blocks external network URLs (SSRF prevention)", () => {
    const dangerousUrls = [
      "http://attacker.com/malicious.mp4",
      "https://storage.evil.org/payload.mov",
      "ftp://192.168.1.1/exploit",
      "rtmp://live.stream/test",
      "smb://fileserver/share",
      "gopher://ancient.service",
    ];

    for (const url of dangerousUrls) {
      assert.throws(
        () => assertSafeSubprocessArgs(["-i", url]),
        (err: any) => err instanceof UnsafeArgumentError && err.code === "UNSAFE_SUBPROCESS_ARGUMENT",
      );
    }
  });

  await test("assertSafeSubprocessArgs rejects null bytes in arguments", () => {
    assert.throws(
      () => assertSafeSubprocessArgs(["-i", "video.mp4\0.exe"]),
      (err: any) => err instanceof UnsafeArgumentError,
    );
  });

  await test("MockProcessRunner records call history and returns default probe JSON", async () => {
    const runner = new MockProcessRunner();
    const result = await runner.execute("ffprobe", ["-v", "quiet", "local.mp4"]);

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('"codec_type":"video"'));
    assert.equal(runner.callHistory.length, 1);
    assert.equal(runner.callHistory[0].binary, "ffprobe");
  });

  await test("MockProcessRunner allows custom command handler overrides", async () => {
    const runner = new MockProcessRunner();
    runner.registerHandler(async (bin, args) => {
      if (bin === "ffmpeg" && args.includes("silencedetect")) {
        return {
          stdout: "",
          stderr: "[silencedetect @ 0x1] silence_start: 5.2\n[silencedetect @ 0x1] silence_end: 8.5 | silence_duration: 3.3",
          exitCode: 0,
          durationMs: 12,
        };
      }
      return null as any;
    });

    const res = await runner.execute("ffmpeg", ["-i", "test.mp4", "-af", "silencedetect"]);
    assert.ok(res.stderr.includes("silence_start: 5.2"));
  });

  // -------------------------------------------------------------------------
  // 2. Video Metadata Extraction via FFprobe Abstraction
  // -------------------------------------------------------------------------
  console.log("\n# 2. Video Metadata Extraction via FFprobe");

  await test("parseFpsFraction parses standard, fractional, and fallback rates", () => {
    assert.equal(parseFpsFraction("30/1"), 30.0);
    assert.equal(parseFpsFraction("24/1"), 24.0);
    assert.equal(parseFpsFraction("30000/1001"), 29.97);
    assert.equal(parseFpsFraction("60/1"), 60.0);
    assert.equal(parseFpsFraction("0/0"), 30.0); // Fallback
    assert.equal(parseFpsFraction(undefined), 30.0);
  });

  await test("parseFfprobeJson parses standard 1080p video with audio", () => {
    const sampleJson = JSON.stringify({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          r_frame_rate: "30/1",
          duration: "45.500000",
          bit_rate: "5000000",
        },
        {
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "48000",
          channels: 2,
          duration: "45.500000",
        },
      ],
      format: {
        duration: "45.500000",
        size: "28400000",
      },
    });

    const meta = parseFfprobeJson(sampleJson);
    assert.equal(meta.width, 1920);
    assert.equal(meta.height, 1080);
    assert.equal(meta.fps, 30.0);
    assert.equal(meta.videoCodec, "h264");
    assert.equal(meta.hasAudio, true);
    assert.equal(meta.audioCodec, "aac");
    assert.equal(meta.sampleRate, 48000);
    assert.equal(meta.channels, 2);
    assert.equal(meta.durationSeconds, 45.5);
    assert.equal(meta.fileSizeBytes, 28400000);
  });

  await test("parseFfprobeJson accurately detects visual-only / silent video", () => {
    const silentJson = JSON.stringify({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1280,
          height: 720,
          r_frame_rate: "24/1",
          duration: "20.000000",
        },
      ],
      format: {
        duration: "20.000000",
        size: "10000000",
      },
    });

    const meta = parseFfprobeJson(silentJson);
    assert.equal(meta.hasAudio, false);
    assert.equal(meta.audioCodec, null);
    assert.equal(meta.sampleRate, null);
    assert.equal(meta.channels, null);
  });

  await test("parseFfprobeJson rejects corrupt JSON or missing video stream", () => {
    assert.throws(
      () => parseFfprobeJson("not-json"),
      (err: any) => err instanceof MetadataExtractionError && err.code === "INVALID_PROBE_JSON",
    );

    assert.throws(
      () => parseFfprobeJson(JSON.stringify({ streams: [] })),
      (err: any) => err instanceof MetadataExtractionError && err.code === "NO_VIDEO_STREAM",
    );
  });

  await test("extractVideoMetadata orchestrator executes ffprobe and returns validated metadata", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_meta_"));
    const testFile = path.join(tempDir, "sample.mp4");
    await fsp.writeFile(testFile, "dummy video bytes");

    try {
      const source = createLocalFileSource(testFile, { fileSizeBytes: 10000000 });
      const runner = new MockProcessRunner(); // uses default 1080p probe JSON (60s duration)

      const meta = await extractVideoMetadata(source, runner);
      assert.equal(meta.width, 1920);
      assert.equal(meta.height, 1080);
      assert.equal(meta.durationSeconds, 60.0);
      assert.equal(meta.hasAudio, true);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // 3. Audio Stream Extraction & Silence Detection
  // -------------------------------------------------------------------------
  console.log("\n# 3. Audio Stream Extraction & Silence Detection");

  await test("parseFfmpegSilenceOutput parses start, end, and duration accurately", () => {
    const sampleStderr = `
[silencedetect @ 0x7fa] silence_start: 12.500
[silencedetect @ 0x7fa] silence_end: 15.750 | silence_duration: 3.250
[silencedetect @ 0x7fa] silence_start: 35.000
[silencedetect @ 0x7fa] silence_end: 37.000 | silence_duration: 2.000
`;

    const intervals = parseFfmpegSilenceOutput(sampleStderr);
    assert.equal(intervals.length, 2);
    assert.equal(intervals[0].start, 12.5);
    assert.equal(intervals[0].end, 15.75);
    assert.equal(intervals[0].duration, 3.25);
    assert.equal(intervals[1].start, 35.0);
    assert.equal(intervals[1].end, 37.0);
    assert.equal(intervals[1].duration, 2.0);
  });

  await test("parseFfmpegSilenceOutput handles trailing silence up to media duration", () => {
    const trailingStderr = `
[silencedetect @ 0x7fa] silence_start: 40.000
`;

    const intervals = parseFfmpegSilenceOutput(trailingStderr, 45.0);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].start, 40.0);
    assert.equal(intervals[0].end, 45.0);
    assert.equal(intervals[0].duration, 5.0);
  });

  await test("extractAudioTrack orchestrator cleanly bypasses visual-only videos without running ffmpeg", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_audio_"));
    const testFile = path.join(tempDir, "silent.mp4");
    const outWav = path.join(tempDir, "out.wav");
    await fsp.writeFile(testFile, "dummy silent video");

    try {
      const source = createLocalFileSource(testFile);
      const runner = new MockProcessRunner();
      // Probe output has no audio stream
      runner.registerHandler(async (bin) => {
        if (bin === "ffprobe") {
          return {
            stdout: JSON.stringify({
              streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720, r_frame_rate: "30/1", duration: "30.0" }],
              format: { duration: "30.0", size: "10000000" },
            }),
            stderr: "",
            exitCode: 0,
            durationMs: 5,
          };
        }
        return null as any;
      });

      const res = await extractAudioTrack(source, outWav, runner);
      assert.equal(res.hasAudio, false);
      assert.equal(res.audioPath, null);
      // FFmpeg audio extraction was NEVER called
      assert.equal(runner.callHistory.some((c) => c.binary === "ffmpeg"), false);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("extractAudioTrack orchestrator extracts audio track for audio-enabled videos", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_audio2_"));
    const testFile = path.join(tempDir, "audio.mp4");
    const outWav = path.join(tempDir, "out.wav");
    await fsp.writeFile(testFile, "dummy video with audio");

    try {
      const source = createLocalFileSource(testFile);
      const runner = new MockProcessRunner();

      const res = await extractAudioTrack(source, outWav, runner);
      assert.equal(res.hasAudio, true);
      assert.equal(res.audioPath, outWav);
      assert.equal(res.sampleRate, 16000);
      assert.equal(res.channels, 1);
      // Verify ffmpeg was invoked
      const ffmpegCall = runner.callHistory.find((c) => c.binary === "ffmpeg");
      assert.ok(ffmpegCall);
      assert.ok(ffmpegCall.args.includes("-vn"));
      assert.ok(ffmpegCall.args.includes("pcm_s16le"));
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("detectAudioSilence orchestrator runs silencedetect filter and returns intervals", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_sil_"));
    const testFile = path.join(tempDir, "audio.mp4");
    await fsp.writeFile(testFile, "dummy video");

    try {
      const source = createLocalFileSource(testFile);
      const runner = new MockProcessRunner();
      runner.registerHandler(async (bin, args) => {
        if (bin === "ffmpeg" && args.some((a) => a.includes("silencedetect"))) {
          return {
            stdout: "",
            stderr: "[silencedetect @ 0x1] silence_start: 10.0\n[silencedetect @ 0x1] silence_end: 14.5 | silence_duration: 4.5",
            exitCode: 0,
            durationMs: 10,
          };
        }
        return null as any;
      });

      const intervals = await detectAudioSilence(source, undefined, runner);
      assert.equal(intervals.length, 1);
      assert.equal(intervals[0].start, 10.0);
      assert.equal(intervals[0].end, 14.5);
      assert.equal(intervals[0].duration, 4.5);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // 4. Visual Scene Cut Detection
  // -------------------------------------------------------------------------
  console.log("\n# 4. Visual Scene Cut Detection");

  await test("parseFfmpegSceneOutput parses monotonic cuts and de-bounces close transitions", () => {
    const sampleOutput = `
frame:30  pts:30030  pts_time:1.001
lavfi.scene_score=0.452100
frame:35  pts:35035  pts_time:1.168
lavfi.scene_score=0.380000
frame:150 pts:150150 pts_time:5.005
lavfi.scene_score=0.621000
frame:300 pts:300300 pts_time:10.010
lavfi.scene_score=0.512000
`;

    // minDuration = 1.0s (should drop frame 35 at 1.168s)
    const cuts = parseFfmpegSceneOutput(sampleOutput, 1.0);
    assert.ok(cuts.length >= 3);

    // Origin cut at 0s guaranteed
    assert.equal(cuts[0].timestampSeconds, 0);

    const nonOriginCuts = cuts.filter((c) => c.timestampSeconds > 0);
    assert.equal(nonOriginCuts[0].timestampSeconds, 1.001);
    assert.equal(nonOriginCuts[1].timestampSeconds, 5.005);
    assert.equal(nonOriginCuts[2].timestampSeconds, 10.01);
  });

  await test("detectSceneCuts orchestrator runs scene select filter and returns cuts", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_cut_"));
    const testFile = path.join(tempDir, "video.mp4");
    await fsp.writeFile(testFile, "dummy video bytes");

    try {
      const source = createLocalFileSource(testFile);
      const runner = new MockProcessRunner();
      runner.registerHandler(async (bin, args) => {
        if (bin === "ffmpeg" && args.some((a) => a.includes("select='gt(scene"))) {
          return {
            stdout: "frame:60 pts:60060 pts_time:2.002\nlavfi.scene_score=0.420000\nframe:240 pts:240240 pts_time:8.008\nlavfi.scene_score=0.550000",
            stderr: "",
            exitCode: 0,
            durationMs: 15,
          };
        }
        return null as any;
      });

      const cuts = await detectSceneCuts(source, undefined, runner);
      assert.ok(cuts.length >= 2);
      assert.equal(cuts[0].timestampSeconds, 0); // origin fallback
      assert.equal(cuts[1].timestampSeconds, 2.002);
      assert.equal(cuts[2].timestampSeconds, 8.008);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // 5. Whisper Transcription Parser (JSON, VTT, SRT)
  // -------------------------------------------------------------------------
  console.log("\n# 5. Whisper Transcription Parser (JSON, VTT, SRT)");

  await test("parseTimestampToSeconds parses VTT and SRT timestamps accurately", () => {
    assert.equal(parseTimestampToSeconds("00:01:23.450"), 83.45);
    assert.equal(parseTimestampToSeconds("00:01:23,450"), 83.45);
    assert.equal(parseTimestampToSeconds("02:10.500"), 130.5);
    assert.equal(parseTimestampToSeconds("5.2"), 5.2);
  });

  await test("interpolateSegmentWords marks words with isInterpolated: true (safeguard)", () => {
    const words = interpolateSegmentWords("Hello world from test", 10.0, 14.0);
    assert.equal(words.length, 4);
    assert.equal(words[0].word, "Hello");
    assert.equal(words[0].start, 10.0);
    assert.equal(words[0].isInterpolated, true); // Crucial safeguard
    assert.equal(words[3].word, "test");
    assert.equal(words[3].end, 14.0);
    assert.equal(words[3].isInterpolated, true);
  });

  await test("parseWhisperJson parses acoustic word timestamps when present", () => {
    const jsonWithWords = {
      text: "This is a breakthrough product",
      language: "en",
      segments: [
        {
          id: 0,
          start: 0.0,
          end: 2.5,
          text: "This is a breakthrough product",
          words: [
            { word: "This", start: 0.0, end: 0.3, probability: 0.98 },
            { word: "is", start: 0.35, end: 0.5, probability: 0.99 },
            { word: "a", start: 0.55, end: 0.65, probability: 0.95 },
            { word: "breakthrough", start: 0.7, end: 1.6, probability: 0.92 },
            { word: "product", start: 1.65, end: 2.4, probability: 0.96 },
          ],
        },
      ],
    };

    const res = parseWhisperJson(jsonWithWords);
    assert.equal(res.segments.length, 1);
    assert.equal(res.segments[0].hasWordLevelAlignment, true);
    assert.equal(res.segments[0].words.length, 5);
    assert.equal(res.segments[0].words[0].isInterpolated, false);
    assert.equal(res.segments[0].words[3].word, "breakthrough");
  });

  await test("parseWhisperJson falls back to linear interpolation when words array is absent", () => {
    const jsonWithoutWords = {
      text: "Segment timing only without word alignment",
      language: "en",
      segments: [
        {
          id: 1,
          start: 5.0,
          end: 10.0,
          text: "Segment timing only without word alignment",
        },
      ],
    };

    const res = parseWhisperJson(jsonWithoutWords);
    assert.equal(res.segments.length, 1);
    assert.equal(res.segments[0].hasWordLevelAlignment, false); // Safeguard: not word-level
    assert.ok(res.segments[0].words.length >= 5);
    assert.equal(res.segments[0].words[0].isInterpolated, true); // Safeguard: flagged as interpolated
  });

  await test("parseVttTranscript parses WebVTT cues into segments", () => {
    const vtt = `WEBVTT - Sample Cue

00:00:01.000 --> 00:00:04.500
First line of speech

00:00:05.200 --> 00:00:09.800
Second phrase with <b>bold</b> tag
`;

    const res = parseVttTranscript(vtt);
    assert.equal(res.segments.length, 2);
    assert.equal(res.segments[0].start, 1.0);
    assert.equal(res.segments[0].end, 4.5);
    assert.equal(res.segments[0].text, "First line of speech");
    assert.equal(res.segments[1].text, "Second phrase with bold tag");
    assert.equal(res.segments[1].hasWordLevelAlignment, false);
  });

  await test("parseSrtTranscript parses SubRip blocks into segments", () => {
    const srt = `1
00:00:02,000 --> 00:00:06,500
Stop making this mistake today.

2
00:00:07,000 --> 00:00:11,200
Here is why it matters.
`;

    const res = parseSrtTranscript(srt);
    assert.equal(res.segments.length, 2);
    assert.equal(res.segments[0].start, 2.0);
    assert.equal(res.segments[0].end, 6.5);
    assert.equal(res.segments[0].text, "Stop making this mistake today.");
    assert.equal(res.segments[0].hasWordLevelAlignment, false);
  });

  await test("parseTranscriptAuto handles visual-only empty payload without failing", () => {
    const empty = parseTranscriptAuto("");
    assert.equal(empty.isVisualOnly, true);
    assert.equal(empty.segments.length, 0);

    const visualObj = parseTranscriptAuto({ isVisualOnly: true });
    assert.equal(visualObj.isVisualOnly, true);
  });

  // -------------------------------------------------------------------------
  // 6. Deterministic Highlight Scoring Engine
  // -------------------------------------------------------------------------
  console.log("\n# 6. Highlight Scoring Engine");

  await test("scoreCandidateHighlights detects hooks and awards high score to question & triggers", () => {
    const transcript: TranscriptResult = {
      fullText: "Why is nobody talking about this secret? This breakthrough changes everything.",
      language: "en",
      isVisualOnly: false,
      segments: [
        {
          id: "seg-1",
          text: "Why is nobody talking about this secret? This breakthrough changes everything.",
          start: 0.0,
          end: 15.0,
          hasWordLevelAlignment: false,
          words: interpolateSegmentWords(
            "Why is nobody talking about this secret? This breakthrough changes everything.",
            0.0,
            15.0,
          ),
        },
      ],
    };

    const highlights = scoreCandidateHighlights({
      sourceDurationSeconds: 60,
      sceneCuts: [{ timestampSeconds: 0, score: 1.0 }, { timestampSeconds: 15, score: 0.5 }],
      transcript,
      requestedClipsCount: 1,
      targetClipDurationSeconds: 15,
    });

    assert.equal(highlights.length, 1);
    assert.ok(highlights[0].score >= 40);
    assert.ok(highlights[0].reason.includes("Hook:"));
    assert.equal(highlights[0].words[0].start, 0); // Re-indexed relative to clip start
  });

  await test("scoreCandidateHighlights penalizes long silences", () => {
    const transcript: TranscriptResult = {
      fullText: "A few words here and dead air.",
      language: "en",
      isVisualOnly: false,
      segments: [
        {
          id: "s1",
          text: "A few words here and dead air.",
          start: 0,
          end: 5,
          words: interpolateSegmentWords("A few words here and dead air.", 0, 5),
        },
      ],
    };

    // 15 seconds of dead air in a 20s window (75% silence)
    const highlights = scoreCandidateHighlights({
      sourceDurationSeconds: 60,
      sceneCuts: [{ timestampSeconds: 0, score: 1.0 }],
      transcript,
      silenceIntervals: [{ start: 5, end: 20, duration: 15 }],
      requestedClipsCount: 1,
      targetClipDurationSeconds: 20,
    });

    assert.equal(highlights.length, 1);
    // Score should be very low due to silence penalty
    assert.ok(highlights[0].score < 30);
  });

  await test("scoreCandidateHighlights supports visual-only video without failing", () => {
    const visualTranscript: TranscriptResult = {
      fullText: "",
      language: "en",
      isVisualOnly: true,
      segments: [],
    };

    const sceneCuts = [
      { timestampSeconds: 0, score: 1.0 },
      { timestampSeconds: 5, score: 0.8 },
      { timestampSeconds: 12, score: 0.6 },
      { timestampSeconds: 25, score: 0.7 },
    ];

    const highlights = scoreCandidateHighlights({
      sourceDurationSeconds: 40,
      sceneCuts,
      transcript: visualTranscript,
      requestedClipsCount: 2,
      targetClipDurationSeconds: 15,
    });

    assert.equal(highlights.length, 2);
    assert.ok(highlights[0].title.includes("Visual Scene"));
    assert.ok(highlights[0].reason.includes("Visual pacing"));
    assert.equal(highlights[0].words.length, 0);
  });

  await test("scoreCandidateHighlights enforces non-overlapping selection for multiple clips", () => {
    const transcript: TranscriptResult = {
      fullText: "Lots of continuous speech happening across the entire video timeline for testing.",
      language: "en",
      isVisualOnly: false,
      segments: [
        {
          id: "s1",
          text: "First section with exciting ideas and secrets.",
          start: 0,
          end: 15,
          words: interpolateSegmentWords("First section with exciting ideas and secrets.", 0, 15),
        },
        {
          id: "s2",
          text: "Second section with key mistakes and rules.",
          start: 20,
          end: 35,
          words: interpolateSegmentWords("Second section with key mistakes and rules.", 20, 35),
        },
        {
          id: "s3",
          text: "Third section with final conclusion and steps.",
          start: 40,
          end: 55,
          words: interpolateSegmentWords("Third section with final conclusion and steps.", 40, 55),
        },
      ],
    };

    const highlights = scoreCandidateHighlights({
      sourceDurationSeconds: 60,
      sceneCuts: [
        { timestampSeconds: 0, score: 1.0 },
        { timestampSeconds: 20, score: 0.8 },
        { timestampSeconds: 40, score: 0.8 },
      ],
      transcript,
      requestedClipsCount: 3,
      targetClipDurationSeconds: 15,
    });

    assert.equal(highlights.length, 3);
    // Verify clips do not significantly overlap
    for (let i = 0; i < highlights.length; i++) {
      for (let j = i + 1; j < highlights.length; j++) {
        const overlapStart = Math.max(highlights[i].startTime, highlights[j].startTime);
        const overlapEnd = Math.min(highlights[i].endTime, highlights[j].endTime);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        assert.ok(overlap < 5.0, "Highlights must not substantially overlap");
      }
    }
  });

  // -------------------------------------------------------------------------
  // 7. ASS & SRT Subtitle Generator
  // -------------------------------------------------------------------------
  console.log("\n# 7. ASS & SRT Subtitle Generator");

  await test("sanitizeAssText strips curly braces, backslashes and control characters", () => {
    assert.equal(
      sanitizeAssText("Normal text with {\\clip(0,0,10,10)} injection"),
      "Normal text with (/clip(0,0,10,10)) injection",
    );
    assert.equal(sanitizeAssText("Line\0with\x07nulls"), "Linewithnulls");
  });

  await test("formatAssTimestamp and formatSrtTimestamp format timestamps accurately", () => {
    assert.equal(formatAssTimestamp(0), "0:00:00.00");
    assert.equal(formatAssTimestamp(65.432), "0:01:05.43");
    assert.equal(formatAssTimestamp(3661.05), "1:01:01.05");

    assert.equal(formatSrtTimestamp(0), "00:00:00,000");
    assert.equal(formatSrtTimestamp(65.432), "00:01:05,432");
  });

  await test("chunkWords groups words into concise mobile-friendly phrases", () => {
    const words = [
      { word: "This", start: 0.0, end: 0.4 },
      { word: "is", start: 0.5, end: 0.8 },
      { word: "a", start: 0.9, end: 1.1 },
      { word: "phrase.", start: 1.2, end: 1.6 },
      { word: "Next", start: 1.7, end: 2.0 },
      { word: "sentence", start: 2.1, end: 2.5 },
    ];

    const chunks = chunkWords(words, 4);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].words.length, 4); // "phrase." ends with period
    assert.equal(chunks[1].words.length, 2);
  });

  await test("generateAssSubtitles generates conforming ASS script with karaoke tags", () => {
    const mockClip: CandidateHighlight = {
      id: "hl-1",
      title: "Viral Hook",
      startTime: 0,
      endTime: 5,
      durationSeconds: 5,
      score: 85,
      reason: "High hook score",
      transcriptText: "This is truly amazing",
      aspectRatio: "9:16",
      framing: "pillarbox_blur",
      words: [
        { word: "This", start: 0.0, end: 0.5 },
        { word: "is", start: 0.6, end: 0.9 },
        { word: "truly", start: 1.0, end: 1.7 },
        { word: "amazing", start: 1.8, end: 2.5 },
      ],
    };

    const ass = generateAssSubtitles(mockClip);
    assert.ok(ass.includes("[Script Info]"));
    assert.ok(ass.includes("PlayResX: 1080"));
    assert.ok(ass.includes("PlayResY: 1920"));
    assert.ok(ass.includes("[V4+ Styles]"));
    assert.ok(ass.includes("Style: Default,Inter,52"));
    assert.ok(ass.includes("[Events]"));
    assert.ok(ass.includes("Dialogue: 0,0:00:00.00,0:00:02.50,Default,,0,0,0,,{\\k50}This {\\k30}is {\\k70}truly {\\k70}amazing"));
  });

  await test("generateAssSubtitles prevents ASS injection when text contains curly braces", () => {
    const maliciousClip: CandidateHighlight = {
      id: "hl-inject",
      title: "Attack",
      startTime: 0,
      endTime: 5,
      durationSeconds: 5,
      score: 50,
      reason: "Security test",
      transcriptText: "{\\b1}Exploit{\\b0}",
      aspectRatio: "16:9",
      framing: "fit",
      words: [
        { word: "{\\b1}Exploit", start: 0.0, end: 1.0 },
        { word: "{\\b0}Test", start: 1.0, end: 2.0 },
      ],
    };

    const ass = generateAssSubtitles(maliciousClip);
    // Ensure raw malicious override tag was defanged
    assert.ok(!ass.includes("{\\b1}"));
    assert.ok(ass.includes("(/b1)Exploit"));
  });

  await test("generateSrtSubtitles produces valid SubRip caption format", () => {
    const mockClip: CandidateHighlight = {
      id: "hl-srt",
      title: "SRT Test",
      startTime: 0,
      endTime: 4,
      durationSeconds: 4,
      score: 75,
      reason: "Test",
      transcriptText: "Clean subtitle export",
      aspectRatio: "1:1",
      framing: "pillarbox_blur",
      words: [
        { word: "Clean", start: 0.0, end: 0.8 },
        { word: "subtitle", start: 0.9, end: 1.8 },
        { word: "export", start: 1.9, end: 2.8 },
      ],
    };

    const srt = generateSrtSubtitles(mockClip);
    assert.ok(srt.includes("1\n00:00:00,000 --> 00:00:02,800\nClean subtitle export"));
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`  Tests Passed: ${passed}`);
  console.log(`  Tests Failed: ${failed}`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Unhandled test runner failure:", err);
  process.exit(1);
});
