/**
 * Stage 9 — Batch 1: Comprehensive Offline Test Suite
 *
 * Covers:
 * 1. Domain Configuration & Environment Overrides.
 * 2. Safe Identifier Validation & Path Traversal Defense.
 * 3. User-Isolated Storage Key Helpers & Ownership Verification.
 * 4. Container Magic Bytes & Header Inspection.
 * 5. MIME Type & File Size Validation.
 * 6. Metadata Bounds & Visual-Only Path Resolution.
 * 7. Clip Window Boundary Validation.
 * 8. Aspect Ratio & Framing Mode Validation.
 * 9. VideoSource Abstraction & Memory-Safe Resource Lifecycle.
 * 10. MockClipperEngine Implementation & Contract Conformance.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";

import {
  CLIPPER_ASPECT_RATIOS,
  CLIPPER_FRAMING_MODES,
  DEFAULT_MAX_UPLOAD_SIZE_BYTES,
  DEFAULT_MIN_SOURCE_DURATION_SECONDS,
  DEFAULT_MAX_SOURCE_DURATION_SECONDS,
  DEFAULT_CREDIT_COST_PER_CLIP,
  DEFAULT_DAILY_USER_CLIP_LIMIT,
  ALLOWED_CLIPPER_MIME_TYPES,
  SUBTITLE_DEFAULTS,
  getClipperMaxUploadBytes,
  getClipperMinSourceDurationSeconds,
  getClipperMaxSourceDurationSeconds,
  getClipperMaxClipsPerJob,
  getClipperCreditCost,
  getDailyUserClipLimit,
} from "../src/features/clipper/config";

import {
  assertSafeIdentifier,
  sanitizeExtension,
  ClipperStorageKeyError,
  buildEphemeralUploadKey,
  buildClipStorageKey,
  buildClipThumbnailKey,
  isEphemeralUploadKeyOwnedBy,
  isClipKeyOwnedBy,
  isClipThumbnailKeyOwnedBy,
  isClipperKeyOwnedBy,
  parseEphemeralUploadKey,
  parseClipStorageKey,
} from "../src/features/clipper/storage/keys";

import {
  inspectContainerMagicBytes,
  validateUploadMimeType,
  validateUploadSizeBytes,
  validateSourceMetadata,
  validateClipWindow,
  validateAspectRatio,
  validateFramingMode,
  validateIdentifier,
} from "../src/features/clipper/validation";

import {
  LocalFileVideoSource,
  StorageReferenceVideoSource,
  createLocalFileSource,
  createStorageReferenceSource,
} from "../src/features/clipper/source";

import {
  MockClipperEngine,
} from "../src/features/clipper/engine/mock-engine";
import { MOCK_CLIPPER_ENGINE } from "../src/features/clipper/config";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      await res;
    }
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}:`, err);
  }
}

async function run() {
  console.log("\n=======================================================");
  console.log("  Stage 9 — Batch 1: AI Video Clipper Offline Test Suite");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------------
  // 1. Domain Configuration & Environment Overrides
  // -------------------------------------------------------------------------
  console.log("# 1. Domain Configuration & Thresholds");

  await test("Default constants match architectural bounds", () => {
    // Batch 5 owner decision: 50 MB default (Supabase Free per-object cap).
    assert.equal(DEFAULT_MAX_UPLOAD_SIZE_BYTES, 50 * 1024 * 1024);
    assert.equal(DEFAULT_MIN_SOURCE_DURATION_SECONDS, 15);
    assert.equal(DEFAULT_MAX_SOURCE_DURATION_SECONDS, 300);
    assert.equal(DEFAULT_CREDIT_COST_PER_CLIP, 5);
    assert.equal(DEFAULT_DAILY_USER_CLIP_LIMIT, 2);
    assert.deepEqual(Array.from(ALLOWED_CLIPPER_MIME_TYPES), [
      "video/mp4",
      "video/quicktime",
      "video/webm",
    ]);
  });

  await test("Aspect ratios define 9:16, 1:1, and 16:9 dimensions accurately", () => {
    assert.equal(CLIPPER_ASPECT_RATIOS["9:16"].width, 1080);
    assert.equal(CLIPPER_ASPECT_RATIOS["9:16"].height, 1920);
    assert.equal(CLIPPER_ASPECT_RATIOS["1:1"].width, 1080);
    assert.equal(CLIPPER_ASPECT_RATIOS["1:1"].height, 1080);
    assert.equal(CLIPPER_ASPECT_RATIOS["16:9"].width, 1920);
    assert.equal(CLIPPER_ASPECT_RATIOS["16:9"].height, 1080);
  });

  await test("Framing modes support pillarbox_blur, center_crop, and fit", () => {
    assert.ok(CLIPPER_FRAMING_MODES.pillarbox_blur);
    assert.ok(CLIPPER_FRAMING_MODES.center_crop);
    assert.ok(CLIPPER_FRAMING_MODES.fit);
  });

  await test("Dynamic getters respect environment overrides with fallback", () => {
    const originalEnv = process.env.CLIPPER_MAX_UPLOAD_BYTES;
    try {
      delete process.env.CLIPPER_MAX_UPLOAD_BYTES;
      assert.equal(getClipperMaxUploadBytes(), DEFAULT_MAX_UPLOAD_SIZE_BYTES);

      process.env.CLIPPER_MAX_UPLOAD_BYTES = "52428800"; // 50MB
      assert.equal(getClipperMaxUploadBytes(), 52428800);

      // Malformed or negative values fail closed to default
      process.env.CLIPPER_MAX_UPLOAD_BYTES = "-100";
      assert.equal(getClipperMaxUploadBytes(), DEFAULT_MAX_UPLOAD_SIZE_BYTES);

      process.env.CLIPPER_MAX_UPLOAD_BYTES = "invalid_string";
      assert.equal(getClipperMaxUploadBytes(), DEFAULT_MAX_UPLOAD_SIZE_BYTES);
    } finally {
      if (originalEnv) process.env.CLIPPER_MAX_UPLOAD_BYTES = originalEnv;
      else delete process.env.CLIPPER_MAX_UPLOAD_BYTES;
    }
  });

  await test("getClipperCreditCost scales by requested clips count and clamps to max", () => {
    assert.equal(getClipperCreditCost(), 5); // default 1 clip
    assert.equal(getClipperCreditCost({ clipsCount: 1 }), 5);
    assert.equal(getClipperCreditCost({ clipsCount: 2 }), 10);
    assert.equal(getClipperCreditCost({ clipsCount: 3 }), 15);
    assert.equal(getClipperCreditCost({ clipsCount: 10 }), 15); // capped at max 3
    assert.equal(getClipperCreditCost({ clipsCount: 0 }), 5); // clamped to min 1
    assert.equal(getClipperCreditCost({ clipsCount: -5 }), 5); // clamped to min 1
  });

  await test("getDailyUserClipLimit resolves tiers accurately with fail-closed default", () => {
    assert.equal(getDailyUserClipLimit("promotional"), 2);
    assert.equal(getDailyUserClipLimit("qa"), 10);
    assert.equal(getDailyUserClipLimit("paid"), 50);
    assert.equal(getDailyUserClipLimit("unknown_tier"), 2);
    assert.equal(getDailyUserClipLimit(null), 2);
    assert.equal(getDailyUserClipLimit(undefined), 2);
  });

  await test("Subtitle defaults define high-contrast styling and karaoke params", () => {
    assert.equal(SUBTITLE_DEFAULTS.fontName, "Inter");
    assert.equal(SUBTITLE_DEFAULTS.primaryColor, "&H00FFFFFF"); // White
    assert.equal(SUBTITLE_DEFAULTS.secondaryColor, "&H0000FFFF"); // Gold/Yellow
    assert.equal(SUBTITLE_DEFAULTS.bold, true);
    assert.ok(SUBTITLE_DEFAULTS.outlineWidth >= 3);
  });

  // -------------------------------------------------------------------------
  // 2. Safe Identifier Validation & Path Traversal Defense
  // -------------------------------------------------------------------------
  console.log("\n# 2. Safe Identifier Validation & Path Traversal Defense");

  await test("assertSafeIdentifier accepts valid CUIDs, UUIDs, and safe tokens", () => {
    assert.doesNotThrow(() => assertSafeIdentifier("userId", "usr_12345678"));
    assert.doesNotThrow(() => assertSafeIdentifier("uploadId", "upl-87654321"));
    assert.doesNotThrow(() => assertSafeIdentifier("jobId", "cmw9a961x0000m0j7u24x8qwr"));
    assert.doesNotThrow(() => assertSafeIdentifier("clipId", "550e8400-e29b-41d4-a716-446655440000"));
  });

  await test("assertSafeIdentifier strictly rejects path traversal and malicious inputs", () => {
    const malicious = [
      "../traversal",
      "..\\windows_traversal",
      "/absolute/path",
      "user/subpath",
      "null\0byte",
      "with spaces",
      "short", // < 8 chars
      "a".repeat(65), // > 64 chars
      "user$injection",
      "user;rm -rf",
      "",
    ];

    for (const input of malicious) {
      assert.throws(
        () => assertSafeIdentifier("testId", input),
        (err) => err instanceof ClipperStorageKeyError && err.code === "INVALID_IDENTIFIER",
        `Expected rejection for input: '${input}'`,
      );
    }
  });

  await test("validateIdentifier wraps safe identifier validation in result envelope", () => {
    const valid = validateIdentifier("userId", "usr_12345678");
    assert.equal(valid.valid, true);
    if (valid.valid) assert.equal(valid.data, "usr_12345678");

    const invalid = validateIdentifier("userId", "../bad_id");
    assert.equal(invalid.valid, false);
    if (!invalid.valid) {
      assert.equal(invalid.code, "INVALID_IDENTIFIER");
      assert.match(invalid.error, /Invalid userId/);
    }
  });

  await test("sanitizeExtension normalizes extensions and rejects dangerous formats", () => {
    assert.equal(sanitizeExtension("mp4"), "mp4");
    assert.equal(sanitizeExtension(".mp4"), "mp4");
    assert.equal(sanitizeExtension(".MOV"), "mov");
    assert.equal(sanitizeExtension(".webm"), "webm");

    assert.throws(() => sanitizeExtension(".exe"), ClipperStorageKeyError);
    assert.throws(() => sanitizeExtension(".tar.gz"), ClipperStorageKeyError);
    assert.throws(() => sanitizeExtension(""), ClipperStorageKeyError);
    assert.throws(() => sanitizeExtension("mp4; rm -rf"), ClipperStorageKeyError);
  });

  // -------------------------------------------------------------------------
  // 3. User-Isolated Storage Key Helpers & Ownership Verification
  // -------------------------------------------------------------------------
  console.log("\n# 3. User-Isolated Storage Key Helpers");

  await test("buildEphemeralUploadKey constructs correct ephemeral prefix", () => {
    const key = buildEphemeralUploadKey({
      userId: "usr_alice123",
      uploadId: "upl_source999",
      extension: "mp4",
    });
    assert.equal(key, "ephemeral/users/usr_alice123/uploads/upl_source999.mp4");
  });

  await test("buildClipStorageKey constructs correct permanent clip key", () => {
    const key = buildClipStorageKey({
      userId: "usr_alice123",
      jobId: "job_clip5555",
      clipId: "clip_highlight1",
      extension: "mp4",
    });
    assert.equal(key, "users/usr_alice123/clips/job_clip5555/clip_highlight1.mp4");
  });

  await test("buildClipThumbnailKey constructs correct poster thumbnail key", () => {
    const key = buildClipThumbnailKey({
      userId: "usr_alice123",
      jobId: "job_clip5555",
      clipId: "clip_highlight1",
      extension: "webp",
    });
    assert.equal(key, "users/usr_alice123/clips/job_clip5555/clip_highlight1-thumb.webp");
  });

  await test("Ownership functions accurately verify matching user prefix", () => {
    const ephemKey = "ephemeral/users/usr_alice123/uploads/upl_source999.mp4";
    const clipKey = "users/usr_alice123/clips/job_clip5555/clip_highlight1.mp4";
    const thumbKey = "users/usr_alice123/clips/job_clip5555/clip_highlight1-thumb.webp";

    assert.equal(isEphemeralUploadKeyOwnedBy(ephemKey, "usr_alice123"), true);
    assert.equal(isEphemeralUploadKeyOwnedBy(ephemKey, "usr_bob99999"), false);

    assert.equal(isClipKeyOwnedBy(clipKey, "usr_alice123"), true);
    assert.equal(isClipKeyOwnedBy(clipKey, "usr_bob99999"), false);

    assert.equal(isClipThumbnailKeyOwnedBy(thumbKey, "usr_alice123"), true);
    assert.equal(isClipThumbnailKeyOwnedBy(thumbKey, "usr_bob99999"), false);

    assert.equal(isClipperKeyOwnedBy(ephemKey, "usr_alice123"), true);
    assert.equal(isClipperKeyOwnedBy(clipKey, "usr_alice123"), true);
    assert.equal(isClipperKeyOwnedBy(thumbKey, "usr_alice123"), true);
    assert.equal(isClipperKeyOwnedBy(clipKey, "usr_bob99999"), false);
  });

  await test("parseEphemeralUploadKey correctly parses valid keys and rejects invalid", () => {
    const parsed = parseEphemeralUploadKey("ephemeral/users/usr_alice123/uploads/upl_source999.mp4");
    assert.ok(parsed);
    assert.equal(parsed.userId, "usr_alice123");
    assert.equal(parsed.uploadId, "upl_source999");
    assert.equal(parsed.extension, "mp4");

    assert.equal(parseEphemeralUploadKey("ephemeral/users/usr_alice123/wrong/upl_source999.mp4"), null);
    assert.equal(parseEphemeralUploadKey("users/usr_alice123/clips/job_12345678/clip_12345678.mp4"), null);
  });

  await test("parseClipStorageKey parses video clips and poster thumbnails", () => {
    const clipParsed = parseClipStorageKey("users/usr_alice123/clips/job_clip5555/clip_highlight1.mp4");
    assert.ok(clipParsed);
    assert.equal(clipParsed.userId, "usr_alice123");
    assert.equal(clipParsed.jobId, "job_clip5555");
    assert.equal(clipParsed.clipId, "clip_highlight1");
    assert.equal(clipParsed.extension, "mp4");
    assert.equal(clipParsed.isThumbnail, false);

    const thumbParsed = parseClipStorageKey("users/usr_alice123/clips/job_clip5555/clip_highlight1-thumb.webp");
    assert.ok(thumbParsed);
    assert.equal(thumbParsed.userId, "usr_alice123");
    assert.equal(thumbParsed.jobId, "job_clip5555");
    assert.equal(thumbParsed.clipId, "clip_highlight1");
    assert.equal(thumbParsed.extension, "webp");
    assert.equal(thumbParsed.isThumbnail, true);

    assert.equal(parseClipStorageKey("invalid/key/structure"), null);
  });

  // -------------------------------------------------------------------------
  // 4. Binary Magic Bytes & Container Inspection
  // -------------------------------------------------------------------------
  console.log("\n# 4. Binary Magic Bytes & Container Inspection");

  await test("inspectContainerMagicBytes detects valid MP4 ftyp with major brand", () => {
    // 0x00, 0x00, 0x00, 0x18 (24 bytes), "ftyp", "isom", 0x00, 0x02, 0x00, 0x00, "isommp41"
    const mp4Header = Buffer.from([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x69, 0x73, 0x6f, 0x6d, // "isom"
      0x00, 0x00, 0x02, 0x00,
      0x69, 0x73, 0x6f, 0x6d,
      0x6d, 0x70, 0x34, 0x31,
    ]);

    const res = inspectContainerMagicBytes(mp4Header);
    assert.equal(res.valid, true);
    if (res.valid) {
      assert.equal(res.data.format, "mp4");
      assert.equal(res.data.majorBrand, "isom");
      assert.equal(res.data.hasFtypBox, true);
    }
  });

  await test("inspectContainerMagicBytes detects QuickTime qt brand", () => {
    const qtHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x14,
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x71, 0x74, 0x20, 0x20, // "qt  "
      0x20, 0x05, 0x03, 0x00,
      0x71, 0x74, 0x20, 0x20,
    ]);

    const res = inspectContainerMagicBytes(qtHeader);
    assert.equal(res.valid, true);
    if (res.valid) {
      assert.equal(res.data.format, "quicktime");
      assert.equal(res.data.majorBrand, "qt  ");
    }
  });

  await test("inspectContainerMagicBytes detects WebM EBML header", () => {
    const webmHeader = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, // EBML ID
      0x9f, 0x42, 0x86, 0x81,
      0x01, 0x42, 0xf7, 0x81,
      0x01, 0x42, 0xf2, 0x81,
    ]);

    const res = inspectContainerMagicBytes(webmHeader);
    assert.equal(res.valid, true);
    if (res.valid) {
      assert.equal(res.data.format, "webm");
    }
  });

  await test("inspectContainerMagicBytes rejects text, truncated data, and executables", () => {
    const textHeader = Buffer.from("Hello World, this is not a video file!");
    const resText = inspectContainerMagicBytes(textHeader);
    assert.equal(resText.valid, false);
    if (!resText.valid) assert.equal(resText.code, "UNSUPPORTED_CONTAINER");

    const truncated = Buffer.from([0x00, 0x00, 0x00]);
    const resTrunc = inspectContainerMagicBytes(truncated);
    assert.equal(resTrunc.valid, false);
    if (!resTrunc.valid) assert.equal(resTrunc.code, "BUFFER_TOO_SHORT");

    const exeHeader = Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00");
    const resExe = inspectContainerMagicBytes(exeHeader);
    assert.equal(resExe.valid, false);
  });

  // -------------------------------------------------------------------------
  // 5. MIME Type & File Size Validation
  // -------------------------------------------------------------------------
  console.log("\n# 5. MIME Type & File Size Validation");

  await test("validateUploadMimeType accepts allowed video MIME types", () => {
    for (const mime of ALLOWED_CLIPPER_MIME_TYPES) {
      const res = validateUploadMimeType(mime);
      assert.equal(res.valid, true);
      if (res.valid) assert.equal(res.data, mime);
    }
  });

  await test("validateUploadMimeType rejects unsupported or malformed MIME types", () => {
    const badMimes = ["image/jpeg", "text/plain", "video/x-msvideo", "application/octet-stream", 123, null];
    for (const bad of badMimes) {
      const res = validateUploadMimeType(bad);
      assert.equal(res.valid, false);
    }
  });

  await test("validateUploadSizeBytes enforces positive bounds up to max upload limit", () => {
    const valid = validateUploadSizeBytes(50 * 1024 * 1024);
    assert.equal(valid.valid, true);

    const zero = validateUploadSizeBytes(0);
    assert.equal(zero.valid, false);

    const negative = validateUploadSizeBytes(-500);
    assert.equal(negative.valid, false);

    const tooLarge = validateUploadSizeBytes(150 * 1024 * 1024);
    assert.equal(tooLarge.valid, false);
    if (!tooLarge.valid) assert.equal(tooLarge.code, "FILE_TOO_LARGE");
  });

  // -------------------------------------------------------------------------
  // 6. Metadata Bounds & Visual-Only Path Resolution
  // -------------------------------------------------------------------------
  console.log("\n# 6. Metadata Bounds & Visual-Only Path");

  await test("validateSourceMetadata accepts valid standard video with audio", () => {
    const res = validateSourceMetadata({
      durationSeconds: 120.0,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
      sampleRate: 44100,
      channels: 2,
      bitrate: 5000000,
      fileSizeBytes: 20000000,
    });

    assert.equal(res.valid, true);
    if (res.valid) {
      assert.equal(res.data.isVisualOnly, false);
      assert.equal(res.data.hasAudio, true);
      assert.equal(res.data.durationSeconds, 120.0);
    }
  });

  await test("validateSourceMetadata accepts silent video and flags isVisualOnly = true", () => {
    const res = validateSourceMetadata({
      durationSeconds: 45.0,
      width: 1280,
      height: 720,
      fps: 24,
      videoCodec: "h264",
      audioCodec: null,
      hasAudio: false,
      sampleRate: null,
      channels: null,
      bitrate: 3000000,
      fileSizeBytes: 10000000,
    });

    assert.equal(res.valid, true);
    if (res.valid) {
      assert.equal(res.data.isVisualOnly, true);
      assert.equal(res.data.hasAudio, false);
    }
  });

  await test("validateSourceMetadata rejects duration shorter than 15s or longer than 300s", () => {
    const tooShort = validateSourceMetadata({
      durationSeconds: 10.0,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
      sampleRate: 44100,
      channels: 2,
      bitrate: 5000000,
      fileSizeBytes: 5000000,
    });
    assert.equal(tooShort.valid, false);
    if (!tooShort.valid) assert.equal(tooShort.code, "DURATION_TOO_SHORT");

    const tooLong = validateSourceMetadata({
      durationSeconds: 350.0,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
      sampleRate: 44100,
      channels: 2,
      bitrate: 5000000,
      fileSizeBytes: 50000000,
    });
    assert.equal(tooLong.valid, false);
    if (!tooLong.valid) assert.equal(tooLong.code, "DURATION_TOO_LONG");
  });

  await test("validateSourceMetadata rejects 4K resolution exceeding 1080p limit", () => {
    const res = validateSourceMetadata({
      durationSeconds: 60.0,
      width: 3840,
      height: 2160,
      fps: 60,
      videoCodec: "hevc",
      audioCodec: "aac",
      hasAudio: true,
      sampleRate: 48000,
      channels: 2,
      bitrate: 20000000,
      fileSizeBytes: 80000000,
    });
    assert.equal(res.valid, false);
    if (!res.valid) assert.equal(res.code, "RESOLUTION_TOO_HIGH");
  });

  // -------------------------------------------------------------------------
  // 7. Clip Window Boundary Validation
  // -------------------------------------------------------------------------
  console.log("\n# 7. Clip Window Boundary Validation");

  await test("validateClipWindow accepts valid window within source duration", () => {
    const res = validateClipWindow({
      startTime: 10.0,
      endTime: 40.0,
      sourceDurationSeconds: 120.0,
    });
    assert.equal(res.valid, true);
    if (res.valid) {
      assert.equal(res.data.duration, 30.0);
    }
  });

  await test("validateClipWindow rejects invalid start, inverted range, or out-of-bounds", () => {
    // Negative start
    const negStart = validateClipWindow({ startTime: -5, endTime: 20, sourceDurationSeconds: 60 });
    assert.equal(negStart.valid, false);
    if (!negStart.valid) assert.equal(negStart.code, "INVALID_START_TIME");

    // Inverted range
    const inverted = validateClipWindow({ startTime: 30, endTime: 20, sourceDurationSeconds: 60 });
    assert.equal(inverted.valid, false);
    if (!inverted.valid) assert.equal(inverted.code, "INVALID_END_TIME");

    // Exceeds total source duration
    const exceeds = validateClipWindow({ startTime: 40, endTime: 75, sourceDurationSeconds: 60 });
    assert.equal(exceeds.valid, false);
    if (!exceeds.valid) assert.equal(exceeds.code, "CLIP_EXCEEDS_SOURCE");

    // Clip too short (< 5s)
    const tooShort = validateClipWindow({ startTime: 10, endTime: 13, sourceDurationSeconds: 60 });
    assert.equal(tooShort.valid, false);
    if (!tooShort.valid) assert.equal(tooShort.code, "CLIP_TOO_SHORT");

    // Clip too long (> 60s)
    const tooLong = validateClipWindow({ startTime: 0, endTime: 70, sourceDurationSeconds: 120 });
    assert.equal(tooLong.valid, false);
    if (!tooLong.valid) assert.equal(tooLong.code, "CLIP_TOO_LONG");
  });

  // -------------------------------------------------------------------------
  // 8. Aspect Ratio & Framing Mode Validation
  // -------------------------------------------------------------------------
  console.log("\n# 8. Aspect Ratio & Framing Mode Validation");

  await test("validateAspectRatio accepts supported ratios and rejects invalid", () => {
    assert.equal(validateAspectRatio("9:16").valid, true);
    assert.equal(validateAspectRatio("1:1").valid, true);
    assert.equal(validateAspectRatio("16:9").valid, true);
    assert.equal(validateAspectRatio("4:3").valid, false);
    assert.equal(validateAspectRatio(123).valid, false);
  });

  await test("validateFramingMode accepts supported modes and rejects invalid", () => {
    assert.equal(validateFramingMode("pillarbox_blur").valid, true);
    assert.equal(validateFramingMode("center_crop").valid, true);
    assert.equal(validateFramingMode("fit").valid, true);
    assert.equal(validateFramingMode("stretch").valid, false);
  });

  // -------------------------------------------------------------------------
  // 9. VideoSource Abstraction & Memory-Safe Resource Lifecycle
  // -------------------------------------------------------------------------
  console.log("\n# 9. VideoSource Abstraction & Controlled Resource Management");

  await test("LocalFileVideoSource materializes existing file and executes cleanup", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_test_"));
    const testFile = path.join(tempDir, "sample_input.mp4");
    await fsp.writeFile(testFile, Buffer.from("dummy video bytes"));

    try {
      const source = createLocalFileSource(testFile, { fileSizeBytes: 17, mimeType: "video/mp4" });
      assert.equal(source.kind, "local_file");
      assert.equal(source.fileSizeBytes, 17);

      const mat = await source.materialize();
      assert.equal(mat.localPath, testFile);
      assert.equal(fs.existsSync(mat.localPath), true);

      // Caller cleanup
      await mat.cleanup();
      assert.equal(fs.existsSync(testFile), true); // caller-owned, not deleted yet

      // Auto-cleanup on dispose
      const autoSource = createLocalFileSource(testFile, { autoCleanup: true });
      await autoSource.dispose();
      assert.equal(fs.existsSync(testFile), false); // unlinked upon disposal
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("LocalFileVideoSource throws if target file does not exist", async () => {
    const source = createLocalFileSource("/non_existent/path/video.mp4");
    await assert.rejects(
      async () => await source.materialize(),
      /Local video source file not accessible/,
    );
  });

  await test("StorageReferenceVideoSource materializes stream into scratch file with bounded check", async () => {
    const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_scratch_"));
    try {
      const source = createStorageReferenceSource("ephemeral/users/u1/uploads/up1.mp4", {
        fileSizeBytes: 100,
      });

      assert.equal(source.kind, "storage_reference");

      // Mock stream provider
      const downloadStreamProvider = async () => {
        return Readable.from([Buffer.from("streamed video chunk 1"), Buffer.from("streamed video chunk 2")]);
      };

      const mat = await source.materialize({ scratchDir, downloadStreamProvider });
      assert.ok(fs.existsSync(mat.localPath));
      const content = await fsp.readFile(mat.localPath, "utf-8");
      assert.equal(content, "streamed video chunk 1streamed video chunk 2");

      // Execute explicit cleanup
      await mat.cleanup();
      assert.equal(fs.existsSync(mat.localPath), false);
    } finally {
      await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("StorageReferenceVideoSource aborts and cleans up if stream exceeds maxBytes", async () => {
    const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_scratch_"));
    try {
      const source = createStorageReferenceSource("ephemeral/users/u1/uploads/big.mp4");

      // Stream that produces 200 bytes
      const bigChunk = Buffer.alloc(100, "A");
      const downloadStreamProvider = async () => {
        return Readable.from([bigChunk, bigChunk]);
      };

      // Cap at 150 bytes
      await assert.rejects(
        async () => await source.materialize({ scratchDir, maxBytes: 150, downloadStreamProvider }),
        /Streamed storage source exceeded maximum size limit/,
      );

      // Verify no leaked temporary files remained in scratchDir
      const remaining = await fsp.readdir(scratchDir);
      assert.equal(remaining.length, 0);
    } finally {
      await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // 10. MockClipperEngine Implementation & Contract Conformance
  // -------------------------------------------------------------------------
  console.log("\n# 10. MockClipperEngine Contract Conformance");

  await test("MockClipperEngine implements VideoClipperEngine and identifier", () => {
    const engine = new MockClipperEngine();
    assert.equal(engine.name, MOCK_CLIPPER_ENGINE);
  });

  await test("MockClipperEngine extractMetadata returns standard 1080p metadata", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_mock_"));
    const testFile = path.join(tempDir, "source.mp4");
    await fsp.writeFile(testFile, Buffer.alloc(1024));

    try {
      const engine = new MockClipperEngine();
      const source = createLocalFileSource(testFile);
      const meta = await engine.extractMetadata(source);

      assert.equal(meta.width, 1920);
      assert.equal(meta.height, 1080);
      assert.equal(meta.durationSeconds, 60.0);
      assert.equal(meta.videoCodec, "h264");
      assert.equal(meta.audioCodec, "aac");
      assert.equal(meta.hasAudio, true);
      assert.equal(meta.sampleRate, 44100);
      assert.equal(meta.channels, 2);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("MockClipperEngine extractMetadata detects silent videos", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_mock_"));
    const testFile = path.join(tempDir, "silent_timelapse.mp4");
    await fsp.writeFile(testFile, Buffer.alloc(1024));

    try {
      const engine = new MockClipperEngine();
      const source = createLocalFileSource(testFile);
      const meta = await engine.extractMetadata(source);

      assert.equal(meta.hasAudio, false);
      assert.equal(meta.audioCodec, null);
      assert.equal(meta.channels, null);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("MockClipperEngine detectScenes returns monotonic scene cuts with valid scores", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_mock_"));
    const testFile = path.join(tempDir, "source.mp4");
    await fsp.writeFile(testFile, Buffer.alloc(1024));

    try {
      const engine = new MockClipperEngine();
      const source = createLocalFileSource(testFile);
      const scenes = await engine.detectScenes(source);

      assert.ok(scenes.length >= 3);
      let lastTime = 0;
      for (const scene of scenes) {
        assert.ok(scene.timestampSeconds > lastTime);
        assert.ok(scene.score >= 0.0 && scene.score <= 1.0);
        lastTime = scene.timestampSeconds;
      }
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("MockClipperEngine transcribeAudio produces monotonic word-level timestamps", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_mock_"));
    const testFile = path.join(tempDir, "speech_podcast.mp4");
    await fsp.writeFile(testFile, Buffer.alloc(1024));

    try {
      const engine = new MockClipperEngine();
      const source = createLocalFileSource(testFile);
      const transcript = await engine.transcribeAudio(source);

      assert.equal(transcript.isVisualOnly, false);
      assert.ok(transcript.segments.length > 0);
      assert.ok(transcript.fullText.length > 0);

      for (const seg of transcript.segments) {
        assert.ok(seg.start < seg.end);
        let prevWordEnd = seg.start;
        for (const w of seg.words) {
          assert.ok(w.start >= prevWordEnd, `Word '${w.word}' starts before previous word ends`);
          assert.ok(w.end > w.start, `Word '${w.word}' end must be greater than start`);
          assert.ok(w.end <= seg.end + 0.1, `Word '${w.word}' end exceeds segment boundary`);
          prevWordEnd = w.end;
        }
      }
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("MockClipperEngine transcribeAudio handles silent videos cleanly", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_mock_"));
    const testFile = path.join(tempDir, "silent_demo.mp4");
    await fsp.writeFile(testFile, Buffer.alloc(1024));

    try {
      const engine = new MockClipperEngine();
      const source = createLocalFileSource(testFile);
      const transcript = await engine.transcribeAudio(source);

      assert.equal(transcript.isVisualOnly, true);
      assert.equal(transcript.segments.length, 0);
      assert.equal(transcript.fullText, "");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("MockClipperEngine renderClip returns mock MP4 with requested aspect ratio and duration", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clipper_mock_"));
    const testFile = path.join(tempDir, "input_source.mp4");
    await fsp.writeFile(testFile, Buffer.alloc(1024));

    try {
      const engine = new MockClipperEngine();
      const source = createLocalFileSource(testFile);

      // Request 9:16 vertical clip
      const result916 = await engine.renderClip({
        jobId: "job_12345678",
        userId: "usr_12345678",
        clipIndex: 0,
        source,
        startTime: 10.0,
        endTime: 40.0,
        aspectRatio: "9:16",
        framing: "pillarbox_blur",
        burnSubtitles: true,
      });

      assert.equal(result916.width, 1080);
      assert.equal(result916.height, 1920);
      assert.equal(result916.durationSeconds, 30.0);
      assert.equal(result916.mimeType, "video/mp4");
      assert.equal(result916.isMockOutput, true);
      assert.ok(result916.videoBuffer && result916.videoBuffer.length > 0);
      assert.ok(result916.thumbnailBuffer && result916.thumbnailBuffer.length > 0);

      // Verify the emitted buffer is a structurally valid MP4 container
      const inspection = inspectContainerMagicBytes(result916.videoBuffer!);
      assert.equal(inspection.valid, true);
      if (inspection.valid) {
        assert.equal(inspection.data.format, "mp4");
      }

      // Request 1:1 square clip
      const result11 = await engine.renderClip({
        jobId: "job_12345678",
        userId: "usr_12345678",
        clipIndex: 1,
        source,
        startTime: 5.0,
        endTime: 20.0,
        aspectRatio: "1:1",
        framing: "center_crop",
        burnSubtitles: false,
      });

      assert.equal(result11.width, 1080);
      assert.equal(result11.height, 1080);
      assert.equal(result11.durationSeconds, 15.0);
      assert.equal(result11.isMockOutput, true);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
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
  console.error("Unhandled test execution error:", err);
  process.exit(1);
});
