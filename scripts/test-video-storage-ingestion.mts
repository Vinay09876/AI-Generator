// Stage 8, Batch 2B: Video Storage, Streaming Ingestion & Thumbnail Poster Frame Extraction
//
// Fully offline: NO real external API calls, NO real Supabase network calls, ₹0 spend.
// Tests stream metering, SSRF protection, DNS connection pinning, redirect verification,
// chunk-safe MP4 header validation, thumbnail boundaries, atomic completion,
// stale lease rejection, and authenticated signed URL ownership.
//
// Run: npm run test:video-storage

import { Readable } from "node:stream";
import sharp from "sharp";

// Clear any ambient sensitive environment keys
for (const k of [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AI_API_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "FAL_KEY",
]) {
  delete process.env[k];
}

const {
  MAX_PROVIDER_VIDEO_BYTES,
  MAX_STORED_THUMBNAIL_BYTES,
  MAX_STORED_VIDEO_BYTES,
  STORED_THUMBNAIL_MIME,
  STORED_VIDEO_MIME,
  VIDEO_SIGNED_URL_TTL_SECONDS,
} = await import("@/features/video/config");

const {
  assertStorageKeySegment,
  buildVideoObjectKey,
  buildVideoThumbnailObjectKey,
  isVideoAssetKeyOwnedBy,
  isVideoKeyOwnedBy,
  isVideoThumbnailKeyOwnedBy,
} = await import("@/features/video/storage/keys");

const {
  DEFAULT_APPROVED_VIDEO_HOSTS,
  SsrfError,
  isPrivateIp,
  matchesHostPattern,
  resolveAndPinAddress,
  safeFetchWithSsrfGuard,
  safePinnedHttpsDownload,
  validateUrlStructure,
  validateVideoDownloadUrl,
} = await import("@/features/video/storage/ssrf");

const {
  CompositeVideoThumbnailExtractor,
  FfmpegThumbnailExtractor,
  MockThumbnailExtractor,
  ProviderPosterThumbnailExtractor,
  ThumbnailExtractionError,
  convertFrameBufferToWebp,
  isFfmpegAvailable,
  resetFfmpegAvailabilityCache,
} = await import("@/features/video/storage/thumbnail");

const {
  createVideoStreamMeter,
  downloadVideoStream,
  validateMp4MagicBytes,
} = await import("@/features/video/storage/stream");

const {
  VideoAssetPersistenceError,
  VideoStorageError,
} = await import("@/features/video/storage/types");

const {
  getSignedVideoAssetUrl,
  ingestVideoOutput,
} = await import("@/features/video/storage/ingestion");

const {
  MOCK_MP4_PLAYABLE_DATA_URI,
  MOCK_MP4_PLAYABLE_FIXTURE_BUFFER,
  MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER,
} = await import("@/features/video/providers/fixture");

const { JobNotCompletableError } = await import("@/features/video/lifecycle");

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) {
    pass++;
    console.log(`PASS  ${m}`);
  } else {
    fail++;
    console.error(`FAIL  ${m}`);
  }
};

const defaultPublicDns = async () => ["104.18.2.1"];


console.log("\n# Section 1: User-Scoped Object Keys & Traversal Defense");
{
  const validUser = "user_12345678";
  const validJob = "job_12345678";
  const validAsset = "asset_12345678";

  const vKey = buildVideoObjectKey({ userId: validUser, jobId: validJob, assetId: validAsset });
  ok(vKey === "users/user_12345678/videos/job_12345678/asset_12345678.mp4", "buildVideoObjectKey produces canonical path");

  const tKey = buildVideoThumbnailObjectKey({ userId: validUser, jobId: validJob, assetId: validAsset });
  ok(tKey === "users/user_12345678/videos/job_12345678/asset_12345678-thumb.webp", "buildVideoThumbnailObjectKey produces canonical path");

  ok(isVideoKeyOwnedBy(vKey, validUser), "isVideoKeyOwnedBy recognizes rightful owner");
  ok(!isVideoKeyOwnedBy(vKey, "user_87654321"), "isVideoKeyOwnedBy rejects different user");
  ok(!isVideoKeyOwnedBy(vKey, "user_12345678_extra"), "isVideoKeyOwnedBy rejects prefix injection");
  ok(!isVideoKeyOwnedBy(tKey, validUser), "isVideoKeyOwnedBy rejects thumbnail key for video check");

  ok(isVideoThumbnailKeyOwnedBy(tKey, validUser), "isVideoThumbnailKeyOwnedBy recognizes rightful owner");
  ok(!isVideoThumbnailKeyOwnedBy(tKey, "other_user_123"), "isVideoThumbnailKeyOwnedBy rejects different user");
  ok(!isVideoThumbnailKeyOwnedBy(vKey, validUser), "isVideoThumbnailKeyOwnedBy rejects mp4 key for thumbnail check");

  ok(isVideoAssetKeyOwnedBy(vKey, validUser), "isVideoAssetKeyOwnedBy accepts video key");
  ok(isVideoAssetKeyOwnedBy(tKey, validUser), "isVideoAssetKeyOwnedBy accepts thumbnail key");
  ok(!isVideoAssetKeyOwnedBy("users/user_12345678/evil/hack.mp4", validUser), "isVideoAssetKeyOwnedBy rejects rogue path");

  // Path traversal assertions
  let threw = false;
  try {
    buildVideoObjectKey({ userId: "../admin", jobId: validJob, assetId: validAsset });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "INVALID_KEY";
  }
  ok(threw, "buildVideoObjectKey rejects path traversal in userId");

  threw = false;
  try {
    buildVideoObjectKey({ userId: validUser, jobId: "job/with/slashes", assetId: validAsset });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "INVALID_KEY";
  }
  ok(threw, "buildVideoObjectKey rejects slashes in jobId");

  threw = false;
  try {
    buildVideoThumbnailObjectKey({ userId: validUser, jobId: validJob, assetId: "short" });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "INVALID_KEY";
  }
  ok(threw, "buildVideoThumbnailObjectKey rejects segment shorter than 8 chars");
}

console.log("\n# Section 2: SSRF Guardrails, Connection Pinning & Safe Redirects");
{
  // Host pattern matching
  ok(matchesHostPattern("fal.media", "fal.media"), "matches exact host fal.media");
  ok(matchesHostPattern("v3.fal.media", "*.fal.media"), "matches wildcard subdomain *.fal.media");
  ok(matchesHostPattern("storage.googleapis.com", "storage.googleapis.com"), "matches storage.googleapis.com");
  ok(!matchesHostPattern("evil-fal.media", "*.fal.media"), "rejects faux subdomain evil-fal.media");
  ok(!matchesHostPattern("attacker.com", "fal.media"), "rejects unauthorized domain");

  // IP Range classification
  ok(isPrivateIp("127.0.0.1"), "identifies 127.0.0.1 as private loopback");
  ok(isPrivateIp("10.0.0.50"), "identifies 10.0.0.50 as private RFC1918");
  ok(isPrivateIp("172.20.10.2"), "identifies 172.20.10.2 as private RFC1918");
  ok(isPrivateIp("192.168.1.1"), "identifies 192.168.1.1 as private RFC1918");
  ok(isPrivateIp("169.254.169.254"), "identifies 169.254.169.254 as private link-local AWS metadata");
  ok(isPrivateIp("100.64.0.1"), "identifies 100.64.0.1 as carrier-grade NAT");
  ok(isPrivateIp("0.0.0.0"), "identifies 0.0.0.0 as reserved network");
  ok(isPrivateIp("::1"), "identifies IPv6 ::1 as loopback");
  ok(isPrivateIp("fc00::1"), "identifies IPv6 fc00::1 as unique local");
  ok(isPrivateIp("fe80::1"), "identifies IPv6 fe80::1 as link-local");
  ok(isPrivateIp("::ffff:192.168.1.1"), "identifies IPv4-mapped IPv6 private address");
  ok(!isPrivateIp("8.8.8.8"), "identifies 8.8.8.8 as public IP");
  ok(!isPrivateIp("1.1.1.1"), "identifies 1.1.1.1 as public IP");
  ok(!isPrivateIp("2606:4700::6812:201"), "identifies public IPv6 address");

  // DNS Resolution & Connection Pinning
  const dnsPublicIpv4Mock = defaultPublicDns;
  const dnsPublicIpv6Mock = async () => ["2606:4700::6812:201"];
  const dnsPrivateIpv4Mock = async () => ["127.0.0.1"];
  const dnsPrivateIpv6Mock = async () => ["::1"];
  const dnsLinkLocalMock = async () => ["169.254.169.254"];
  const dnsFailMock = async () => {
    throw new Error("ENOTFOUND");
  };
  const dnsEmptyMock = async () => [];

  // Pinned resolution tests
  const pinnedV4 = await resolveAndPinAddress("v3.fal.media", { dnsResolver: dnsPublicIpv4Mock });
  ok(pinnedV4.ip === "104.18.2.1" && pinnedV4.family === 4, "resolveAndPinAddress successfully pins public IPv4");

  const pinnedV6 = await resolveAndPinAddress("v3.fal.media", { dnsResolver: dnsPublicIpv6Mock });
  ok(pinnedV6.ip === "2606:4700::6812:201" && pinnedV6.family === 6, "resolveAndPinAddress successfully pins public IPv6");

  let threw = false;
  try {
    await resolveAndPinAddress("v3.fal.media", { dnsResolver: dnsPrivateIpv4Mock });
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "PRIVATE_IP";
  }
  ok(threw, "resolveAndPinAddress rejects private IPv4");

  threw = false;
  try {
    await resolveAndPinAddress("v3.fal.media", { dnsResolver: dnsPrivateIpv6Mock });
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "PRIVATE_IP";
  }
  ok(threw, "resolveAndPinAddress rejects private IPv6");

  threw = false;
  try {
    await resolveAndPinAddress("v3.fal.media", { dnsResolver: dnsLinkLocalMock });
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "PRIVATE_IP";
  }
  ok(threw, "resolveAndPinAddress rejects link-local metadata address");

  threw = false;
  try {
    await resolveAndPinAddress("v3.fal.media", { dnsResolver: dnsFailMock });
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "DNS_FAILURE";
  }
  ok(threw, "resolveAndPinAddress fails closed on DNS lookup error");

  threw = false;
  try {
    await resolveAndPinAddress("v3.fal.media", { dnsResolver: dnsEmptyMock });
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "DNS_FAILURE";
  }
  ok(threw, "resolveAndPinAddress fails closed when DNS returns no records");

  // URL Syntax Validation
  threw = false;
  try {
    validateUrlStructure("http://fal.media/video.mp4");
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "DISALLOWED_PROTOCOL";
  }
  ok(threw, "rejects insecure http: protocol");

  threw = false;
  try {
    validateUrlStructure("https://fal.media:8080/video.mp4");
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "DISALLOWED_PORT";
  }
  ok(threw, "rejects non-standard HTTPS port");

  threw = false;
  try {
    validateUrlStructure("https://user:pass@fal.media/video.mp4");
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "INVALID_URL";
  }
  ok(threw, "rejects embedded credentials in URL");

  threw = false;
  try {
    validateUrlStructure("https://localhost/video.mp4");
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "DISALLOWED_HOST";
  }
  ok(threw, "rejects localhost hostname");

  threw = false;
  try {
    validateUrlStructure("https://169.254.169.254/latest/meta-data");
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "PRIVATE_IP";
  }
  ok(threw, "rejects raw link-local metadata IP address");

  threw = false;
  try {
    validateUrlStructure("https://unapproved-host.com/video.mp4");
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "DISALLOWED_HOST";
  }
  ok(threw, "rejects unapproved host domain");

  // Connection Pinning Verification with Mock HTTPS Request
  let capturedLookupIp: string | null = null;
  let capturedLookupFamily: number | null = null;
  let capturedServername: string | null = null;

  const mockHttpsRequest = ((opts: any, cb: any) => {
    capturedServername = opts.servername;
    // Execute the lookup callback passed to https.request
    if (typeof opts.lookup === "function") {
      opts.lookup(opts.hostname, {}, (_err: any, ip: string, fam: number) => {
        capturedLookupIp = ip;
        capturedLookupFamily = fam;
      });
    }

    const mockRes: any = Readable.from(Buffer.from("OK_STREAM"));
    mockRes.statusCode = 200;
    mockRes.statusMessage = "OK";
    mockRes.headers = { "content-type": "video/mp4" };

    setImmediate(() => cb(mockRes));
    return {
      on: () => {},
      end: () => {},
      destroy: () => {},
      setTimeout: () => {},
    };
  }) as any;

  const pinnedResp = await safePinnedHttpsDownload(
    "https://v3.fal.media/output.mp4",
    {},
    {
      dnsResolver: dnsPublicIpv4Mock,
      httpsRequestImpl: mockHttpsRequest,
    },
  );

  ok(pinnedResp.statusCode === 200, "safePinnedHttpsDownload executes mock request");
  ok(capturedServername === "v3.fal.media", "connection preserves TLS SNI servername (v3.fal.media)");
  ok(capturedLookupIp === "104.18.2.1", "socket connection is strictly pinned to validated IP (104.18.2.1)");
  ok(capturedLookupFamily === 4, "socket connection uses IPv4 family");

  // DNS Rebinding Attack Simulation:
  // Initial resolution validated 104.18.2.1.
  // Attacker tries to switch DNS to 127.0.0.1 at connection time.
  // Verified that the socket receives the pre-pinned address, NOT the rebound address.
  let dnsCallCount = 0;
  const rebindingDnsMock = async () => {
    dnsCallCount++;
    if (dnsCallCount === 1) return ["104.18.2.1"]; // first check
    return ["127.0.0.1"]; // rebound attack
  };

  await safePinnedHttpsDownload(
    "https://v3.fal.media/output.mp4",
    {},
    {
      dnsResolver: rebindingDnsMock,
      httpsRequestImpl: mockHttpsRequest,
    },
  );
  ok(capturedLookupIp === "104.18.2.1", "connection pinning prevents DNS rebinding between validation and connect");

  // Redirect Handling with Connection Pinning
  const redirectHttpsMock = ((opts: any, cb: any) => {
    const isInit = opts.path === "/init";
    const mockRes: any = Readable.from(Buffer.from(""));
    mockRes.statusCode = isInit ? 302 : 200;
    mockRes.statusMessage = isInit ? "Found" : "OK";
    mockRes.headers = isInit
      ? { location: "https://v3.fal.media/final.mp4" }
      : { "content-type": "video/mp4" };

    setImmediate(() => cb(mockRes));
    return {
      on: () => {},
      end: () => {},
      destroy: () => {},
      setTimeout: () => {},
    };
  }) as any;

  const redirResult = await safePinnedHttpsDownload(
    "https://fal.media/init",
    {},
    {
      dnsResolver: dnsPublicIpv4Mock,
      httpsRequestImpl: redirectHttpsMock,
    },
  );
  ok(redirResult.finalUrl === "https://v3.fal.media/final.mp4", "safePinnedHttpsDownload safely follows verified redirect");

  // Dangerous redirect to private IP intercepted
  const badRedirHttpsMock = ((opts: any, cb: any) => {
    const mockRes: any = Readable.from(Buffer.from(""));
    mockRes.statusCode = 302;
    mockRes.headers = { location: "https://169.254.169.254/latest/meta-data" };
    setImmediate(() => cb(mockRes));
    return {
      on: () => {},
      end: () => {},
      destroy: () => {},
      setTimeout: () => {},
    };
  }) as any;

  threw = false;
  try {
    await safePinnedHttpsDownload(
      "https://fal.media/init",
      {},
      {
        dnsResolver: dnsPublicIpv4Mock,
        httpsRequestImpl: badRedirHttpsMock,
      },
    );
  } catch (e) {
    threw = (e as InstanceType<typeof SsrfError>).code === "PRIVATE_IP";
  }
  ok(threw, "safePinnedHttpsDownload intercepts and rejects redirect to private/metadata IP");
}

console.log("\n# Section 3: Chunk-Safe MP4 Header & Stream Verification");
{
  // 1. Magic bytes validation helper
  ok(validateMp4MagicBytes(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER), "validateMp4MagicBytes accepts valid ISOBMFF header");
  ok(validateMp4MagicBytes(MOCK_MP4_PLAYABLE_FIXTURE_BUFFER), "validateMp4MagicBytes accepts playable H.264 header");
  ok(!validateMp4MagicBytes(Buffer.from("RIFF1234WEBPVP8 ")), "validateMp4MagicBytes rejects WebP file");
  ok(!validateMp4MagicBytes(Buffer.from("GIF89a")), "validateMp4MagicBytes rejects GIF file");
  ok(!validateMp4MagicBytes(Buffer.from([0xff, 0xd8, 0xff])), "validateMp4MagicBytes rejects JPEG file");
  ok(!validateMp4MagicBytes(Buffer.from("short")), "validateMp4MagicBytes rejects buffer < 8 bytes");

  // 2. Chunk-Safe Header Delivery in ONE chunk (8+ bytes)
  const singleChunkMeter = createVideoStreamMeter({ maxBytes: 1000, validateSignature: true });
  const singleChunkData: Buffer[] = [];
  singleChunkMeter.stream.on("data", (c) => singleChunkData.push(c));

  singleChunkMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(0, 50));
  singleChunkMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(50, 100));
  singleChunkMeter.stream.end();

  await new Promise((r) => singleChunkMeter.stream.on("end", r));
  ok(singleChunkMeter.getBytesRead() === 100, "header delivered in one chunk validates and streams normally");

  // 3. Chunk-Safe Header SPLIT ACROSS TWO CHUNKS (4 bytes + 4 bytes)
  const splitTwoMeter = createVideoStreamMeter({ maxBytes: 1000, validateSignature: true });
  const splitTwoData: Buffer[] = [];
  splitTwoMeter.stream.on("data", (c) => splitTwoData.push(c));

  // Chunk 1: first 4 bytes (size header only)
  splitTwoMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(0, 4));
  // Chunk 2: next 4 bytes ('ftyp' box type) + remaining bytes
  splitTwoMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(4, 50));
  splitTwoMeter.stream.end();

  await new Promise((r) => splitTwoMeter.stream.on("end", r));
  ok(splitTwoMeter.getBytesRead() === 50, "header split across two chunks (4b + 4b) accumulates and succeeds");

  // 4. Chunk-Safe Header SPLIT ACROSS SEVERAL SMALL CHUNKS (1b, 1b, 2b, 4b)
  const smallChunksMeter = createVideoStreamMeter({ maxBytes: 1000, validateSignature: true });
  const smallChunksData: Buffer[] = [];
  smallChunksMeter.stream.on("data", (c) => smallChunksData.push(c));

  smallChunksMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(0, 1)); // 1 byte
  smallChunksMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(1, 2)); // 1 byte
  smallChunksMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(2, 4)); // 2 bytes
  smallChunksMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(4, 8)); // 4 bytes ('ftyp')
  smallChunksMeter.stream.write(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.subarray(8, 60)); // payload
  smallChunksMeter.stream.end();

  await new Promise((r) => smallChunksMeter.stream.on("end", r));
  ok(smallChunksMeter.getBytesRead() === 60, "header split across several small chunks (1b, 1b, 2b, 4b) accumulates and succeeds");

  // 5. Invalid MP4 Header (8 bytes of non-ftyp, e.g. 'moov' or corrupt)
  const badHeaderBuffer = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x77, 0x65, 0x62, 0x70]); // 'webp' box
  const badMeter = createVideoStreamMeter({ maxBytes: 1000, validateSignature: true });
  let badError: any = null;
  badMeter.stream.on("error", (e) => {
    badError = e;
  });
  badMeter.stream.write(badHeaderBuffer);

  await new Promise((r) => setImmediate(r));
  ok(badError !== null && badError.code === "INVALID_SIGNATURE", "invalid header rejects with INVALID_SIGNATURE");
  ok(badError?.message.includes("expected 'ftyp'"), "error message identifies missing 'ftyp' box");

  // 6. Premature Stream Termination (ending before 8 header bytes arrive)
  const truncatedMeter = createVideoStreamMeter({ maxBytes: 1000, validateSignature: true });
  let truncError: any = null;
  truncatedMeter.stream.on("error", (e) => {
    truncError = e;
  });
  truncatedMeter.stream.write(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66])); // only 5 bytes
  truncatedMeter.stream.end(); // stream finishes prematurely

  await new Promise((r) => setImmediate(r));
  ok(truncError !== null && truncError.code === "INVALID_SIGNATURE", "stream ending before 8 bytes rejects in flush()");
  ok(truncError?.message.includes("terminated prematurely"), "identifies premature stream termination");

  // 7. Continuous Oversized Video Enforcement (> maxBytes)
  const smallCapMeter = createVideoStreamMeter({ maxBytes: 50, validateSignature: false });
  let capError: any = null;
  smallCapMeter.stream.on("error", (e) => {
    capError = e;
  });
  smallCapMeter.stream.write(Buffer.alloc(40, 1));
  smallCapMeter.stream.write(Buffer.alloc(20, 1));

  await new Promise((r) => setImmediate(r));
  ok(capError !== null && capError.code === "TOO_LARGE", "stream meter aborts with TOO_LARGE when exceeding maxBytes");

  // 8. Download Video Stream from Data URI
  const dataUriDownload = await downloadVideoStream({
    videoUrl: MOCK_MP4_PLAYABLE_DATA_URI,
    maxBytes: 35 * 1024 * 1024,
  });
  ok(dataUriDownload.mimeType === "video/mp4", "downloadVideoStream resolves video/mp4 MIME type from data URI");
  ok(dataUriDownload.expectedSizeBytes === MOCK_MP4_PLAYABLE_FIXTURE_BUFFER.length, "downloadVideoStream reports exact playable fixture size");

  // 9. Early Content-Length check exceeding 35MB
  const mockHugeHttps = ((_opts: any, cb: any) => {
    const mockRes: any = Readable.from(Buffer.alloc(100));
    mockRes.statusCode = 200;
    mockRes.headers = {
      "content-type": "video/mp4",
      "content-length": String(36 * 1024 * 1024), // 36 MB
    };
    setImmediate(() => cb(mockRes));
    return { on: () => {}, end: () => {}, destroy: () => {}, setTimeout: () => {} };
  }) as any;

  let threw = false;
  try {
    await downloadVideoStream({
      videoUrl: "https://v3.fal.media/huge.mp4",
      maxBytes: 35 * 1024 * 1024,
      validationOptions: {
        dnsResolver: defaultPublicDns,
        httpsRequestImpl: mockHugeHttps,
      },
    });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "TOO_LARGE";
  }
  ok(threw, "downloadVideoStream aborts immediately when Content-Length exceeds 35MB");
}

console.log("\n# Section 4: Thumbnail Extraction Boundary");
{
  // 1. Tooling check: FFmpeg availability in this Windows environment
  resetFfmpegAvailabilityCache();
  const ffmpegInstalled = await isFfmpegAvailable(true);
  ok(!ffmpegInstalled, "isFfmpegAvailable accurately reports false (no FFmpeg installed in environment)");

  // 2. FfmpegThumbnailExtractor reports clean MISSING_DEPENDENCY
  const ffmpegExtractor = new FfmpegThumbnailExtractor();
  let threw = false;
  try {
    await ffmpegExtractor.extract({ videoUrl: "https://v3.fal.media/video.mp4" });
  } catch (e) {
    threw = (e as InstanceType<typeof ThumbnailExtractionError>).code === "MISSING_DEPENDENCY";
  }
  ok(threw, "FfmpegThumbnailExtractor cleanly throws MISSING_DEPENDENCY when FFmpeg is not in PATH");

  // 3. ProviderPosterThumbnailExtractor with raw image buffer
  const sampleFrameJpeg = await sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 120, g: 60, b: 200 } },
  })
    .jpeg()
    .toBuffer();

  const posterExtractor = new ProviderPosterThumbnailExtractor();
  const thumbResult = await posterExtractor.extract({ posterBuffer: sampleFrameJpeg, width: 1280, height: 720 });

  ok(thumbResult.mimeType === "image/webp", "thumbnail converted to image/webp");
  ok(thumbResult.width === 1280 && thumbResult.height === 720, "thumbnail preserves target 1280x720 dimensions");
  ok(thumbResult.sizeBytes > 0 && thumbResult.sizeBytes <= MAX_STORED_THUMBNAIL_BYTES, "thumbnail size is within 1MB limit");

  // 4. ProviderPosterThumbnailExtractor with empty input
  threw = false;
  try {
    await posterExtractor.extract({});
  } catch (e) {
    threw = (e as InstanceType<typeof ThumbnailExtractionError>).code === "EMPTY_INPUT";
  }
  ok(threw, "ProviderPosterThumbnailExtractor rejects empty input");

  // 5. ProviderPosterThumbnailExtractor with corrupted image
  threw = false;
  try {
    await posterExtractor.extract({ posterBuffer: Buffer.from("NOT_AN_IMAGE_PAYLOAD") });
  } catch (e) {
    threw = (e as InstanceType<typeof ThumbnailExtractionError>).code === "INVALID_IMAGE";
  }
  ok(threw, "ProviderPosterThumbnailExtractor rejects corrupted frame");

  // 6. MockThumbnailExtractor deterministic tests
  const mockExtractor = new MockThumbnailExtractor();
  const mockThumb = await mockExtractor.extract({ width: 720, height: 1280 });
  ok(mockThumb.mimeType === "image/webp", "MockThumbnailExtractor produces valid WebP");

  const missingMock = new MockThumbnailExtractor({ failMode: "missing_dependency" });
  threw = false;
  try {
    await missingMock.extract({});
  } catch (e) {
    threw = (e as InstanceType<typeof ThumbnailExtractionError>).code === "MISSING_DEPENDENCY";
  }
  ok(threw, "MockThumbnailExtractor correctly simulates missing_dependency");

  const corruptMock = new MockThumbnailExtractor({ failMode: "corrupt_frame" });
  threw = false;
  try {
    await corruptMock.extract({});
  } catch (e) {
    threw = (e as InstanceType<typeof ThumbnailExtractionError>).code === "INVALID_IMAGE";
  }
  ok(threw, "MockThumbnailExtractor correctly simulates corrupt_frame");

  // 7. CompositeVideoThumbnailExtractor
  const compositeExtractor = new CompositeVideoThumbnailExtractor();
  const compResult = await compositeExtractor.extract({ posterBuffer: sampleFrameJpeg });
  ok(compResult.mimeType === "image/webp", "CompositeExtractor uses poster image when available");

  threw = false;
  try {
    await compositeExtractor.extract({});
  } catch (e) {
    threw = (e as InstanceType<typeof ThumbnailExtractionError>).code === "MISSING_DEPENDENCY";
  }
  ok(threw, "CompositeExtractor cleanly throws MISSING_DEPENDENCY when poster missing and FFmpeg absent");
}

console.log("\n# Section 5: Video Object Storage Adapter (Mock & In-Memory)");
{
  class InMemoryVideoObjectStorage {
    public objects = new Map<string, { body: Buffer; contentType: string }>();
    public signedCalls: string[] = [];
    public deletedCalls: string[] = [];

    async put(key: string, body: Buffer, options: { contentType: string; maxBytes: number }) {
      if (this.objects.has(key)) {
        throw new VideoStorageError("ALREADY_EXISTS", `Key ${key} already exists.`);
      }
      if (body.length > options.maxBytes) {
        throw new VideoStorageError("TOO_LARGE", `Exceeds maxBytes ${options.maxBytes}`);
      }
      this.objects.set(key, { body, contentType: options.contentType });
    }

    async putStream(
      key: string,
      stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
      options: { contentType: string; maxBytes: number; contentLength?: number },
    ): Promise<{ sizeBytes: number }> {
      if (this.objects.has(key)) {
        throw new VideoStorageError("ALREADY_EXISTS", `Key ${key} already exists.`);
      }
      const chunks: Buffer[] = [];
      const nodeStream = stream as NodeJS.ReadableStream;
      for await (const chunk of nodeStream) {
        chunks.push(Buffer.from(chunk));
      }
      const fullBuffer = Buffer.concat(chunks);
      if (fullBuffer.length > options.maxBytes) {
        throw new VideoStorageError("TOO_LARGE", `Stream exceeded maxBytes`);
      }
      this.objects.set(key, { body: fullBuffer, contentType: options.contentType });
      return { sizeBytes: fullBuffer.length };
    }

    async createSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
      if (!this.objects.has(key)) {
        throw new VideoStorageError("NOT_FOUND", `Key ${key} not found.`);
      }
      this.signedCalls.push(key);
      return `https://storage.supabase.test/signed/${key}?expires=${expiresInSeconds}`;
    }

    async delete(key: string): Promise<void> {
      this.deletedCalls.push(key);
      this.objects.delete(key);
    }
  }

  const storage = new InMemoryVideoObjectStorage();
  await storage.put("test.webp", Buffer.from("fake-webp"), { contentType: "image/webp", maxBytes: 1000 });
  ok(storage.objects.has("test.webp"), "put stores object");

  // Duplicate key rejected
  let threw = false;
  try {
    await storage.put("test.webp", Buffer.from("fake-webp-2"), { contentType: "image/webp", maxBytes: 1000 });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "ALREADY_EXISTS";
  }
  ok(threw, "put rejects duplicate key without overwrite");

  // putStream stores streamed data
  await storage.putStream("test.mp4", Readable.from(Buffer.from("fake-mp4-stream")), {
    contentType: "video/mp4",
    maxBytes: 1000,
  });
  ok(storage.objects.has("test.mp4"), "putStream stores streamed data");

  // delete cleans up key
  await storage.delete("test.webp");
  ok(!storage.objects.has("test.webp"), "delete removes stored object");
}

console.log("\n# Section 6: Ingestion Pipeline Orchestration & Authenticated Signed URLs");
{
  class MockDbHarness {
    public jobs = new Map<string, any>();
    public assets = new Map<string, any>();
    public shouldFailDbCompletion = false;

    constructor() {
      this.jobs.set("vjob-001", {
        id: "vjob-001",
        userId: "user_valid_123",
        status: "PROCESSING",
        estimatedCredits: 10,
        chargedCredits: 0,
        ingestionToken: "vin-token-001",
        ingestionLeaseExpiresAt: new Date(Date.now() + 300_000),
      });
    }

    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      if (this.shouldFailDbCompletion) {
        throw new Error("Simulated database connection failure during commit");
      }

      const tx = {
        $queryRaw: async ([q]: TemplateStringsArray, ...args: any[]) => {
          const sql = q.toString();
          if (sql.includes('UPDATE "GenerationJob"')) {
            const jobId = args[0];
            const token = args[1];
            const job = this.jobs.get(jobId);
            if (!job || job.status !== "PROCESSING" || job.ingestionToken !== token) {
              return [];
            }
            job.status = "COMPLETED";
            job.chargedCredits = job.estimatedCredits;
            job.ingestionToken = null;
            job.ingestionLeaseExpiresAt = null;
            return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
          }
          return [];
        },
        generatedAsset: {
          create: async ({ data }: any) => {
            this.assets.set(data.id, data);
            return { id: data.id };
          },
        },
      };

      return fn(tx);
    }

    generatedAsset = {
      findFirst: async ({ where }: any) => {
        for (const asset of this.assets.values()) {
          if (asset.id === where.id && asset.userId === where.userId) {
            return asset;
          }
        }
        return null;
      },
    };
  }

  class TestStorage {
    public files = new Map<string, Buffer>();
    public deleted: string[] = [];

    async put(key: string, body: Buffer) {
      this.files.set(key, body);
    }
    async putStream(key: string, stream: any) {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      this.files.set(key, Buffer.concat(chunks));
      return { sizeBytes: this.files.get(key)!.length };
    }
    async createSignedUrl(key: string, exp: number) {
      return `https://signed.supabase.test/${key}?ttl=${exp}`;
    }
    async delete(key: string) {
      this.deleted.push(key);
      this.files.delete(key);
    }
  }

  // 1. Full Ingestion Happy Path
  const db = new MockDbHarness();
  const storage = new TestStorage();
  const mockExtractor = new MockThumbnailExtractor();

  const result = await ingestVideoOutput({
    jobId: "vjob-001",
    userId: "user_valid_123",
    ingestionToken: "vin-token-001",
    videoUrl: MOCK_MP4_PLAYABLE_DATA_URI,
    width: 1280,
    height: 720,
    durationSeconds: 5.0,
    storage: storage as any,
    thumbnailExtractor: mockExtractor,
    db: db as any,
  });

  ok(result.jobId === "vjob-001", "ingestVideoOutput returns completed jobId");
  ok(typeof result.assetId === "string" && result.assetId.length > 0, "ingestVideoOutput assigns unique assetId");
  ok(storage.files.has(result.videoKey), "uploaded video object exists in storage");
  ok(storage.files.has(result.thumbnailKey!), "uploaded thumbnail object exists in storage");
  ok(db.jobs.get("vjob-001").status === "COMPLETED", "job status updated to COMPLETED");
  ok(db.jobs.get("vjob-001").ingestionToken === null, "ingestionToken cleared to NULL");
  ok(db.jobs.get("vjob-001").ingestionLeaseExpiresAt === null, "ingestionLeaseExpiresAt cleared to NULL");
  ok(db.assets.has(result.assetId), "GeneratedAsset row created in database");
  ok(db.assets.get(result.assetId).durationSeconds === 5.0, "asset stores durationSeconds: 5.0");

  // 2. Authenticated Signed URLs: Rightful Owner
  const videoSignedUrl = await getSignedVideoAssetUrl({
    userId: "user_valid_123",
    assetId: result.assetId,
    storage: storage as any,
    kind: "video",
    db: db as any,
  });
  ok(videoSignedUrl.includes(result.videoKey), "getSignedVideoAssetUrl generates valid signed URL for video");

  const thumbSignedUrl = await getSignedVideoAssetUrl({
    userId: "user_valid_123",
    assetId: result.assetId,
    storage: storage as any,
    kind: "thumbnail",
    db: db as any,
  });
  ok(thumbSignedUrl.includes(result.thumbnailKey!), "getSignedVideoAssetUrl generates valid signed URL for thumbnail");

  // 3. Security Tests: Manipulated User ID / Cross-Account Access
  let threw = false;
  try {
    await getSignedVideoAssetUrl({
      userId: "user_attacker_999",
      assetId: result.assetId,
      storage: storage as any,
      kind: "video",
      db: db as any,
    });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "NOT_FOUND";
  }
  ok(threw, "cross-account video access rejected with safe 404 NOT_FOUND");

  threw = false;
  try {
    await getSignedVideoAssetUrl({
      userId: "user_attacker_999",
      assetId: result.assetId,
      storage: storage as any,
      kind: "thumbnail",
      db: db as any,
    });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "NOT_FOUND";
  }
  ok(threw, "cross-account thumbnail access rejected with safe 404 NOT_FOUND");

  // 4. Security Tests: Path Traversal in User ID or Asset ID
  threw = false;
  try {
    await getSignedVideoAssetUrl({
      userId: "../admin",
      assetId: result.assetId,
      storage: storage as any,
      db: db as any,
    });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "NOT_FOUND";
  }
  ok(threw, "path traversal in userId rejected with safe 404 NOT_FOUND");

  threw = false;
  try {
    await getSignedVideoAssetUrl({
      userId: "user_valid_123",
      assetId: "short",
      storage: storage as any,
      db: db as any,
    });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "NOT_FOUND";
  }
  ok(threw, "malformed assetId rejected with safe 404 NOT_FOUND");

  // 5. Security Tests: Corrupted / Tampered Storage Key in DB (Points outside user namespace)
  const rogueDb = new MockDbHarness();
  rogueDb.assets.set("asset_rogue_1", {
    id: "asset_rogue_1",
    userId: "user_victim_111",
    storageKey: "users/other_user_222/videos/job_1/asset_1.mp4", // Key belongs to someone else!
    thumbnailKey: "users/other_user_222/videos/job_1/asset_1-thumb.webp",
  });

  threw = false;
  try {
    await getSignedVideoAssetUrl({
      userId: "user_victim_111",
      assetId: "asset_rogue_1",
      storage: storage as any,
      kind: "video",
      db: rogueDb as any,
    });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "NOT_FOUND";
  }
  ok(threw, "database record with mismatched storageKey prefix strictly rejected with 404");

  threw = false;
  try {
    await getSignedVideoAssetUrl({
      userId: "user_victim_111",
      assetId: "asset_rogue_1",
      storage: storage as any,
      kind: "thumbnail",
      db: rogueDb as any,
    });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "NOT_FOUND";
  }
  ok(threw, "database record with mismatched thumbnailKey prefix strictly rejected with 404");

  // 6. Graceful Fallback with requireThumbnail = false
  const db2 = new MockDbHarness();
  db2.jobs.set("vjob-002", {
    id: "vjob-002",
    userId: "user_valid_123",
    status: "PROCESSING",
    estimatedCredits: 10,
    ingestionToken: "vin-token-002",
    ingestionLeaseExpiresAt: new Date(Date.now() + 300_000),
  });
  const storage2 = new TestStorage();
  const missingExtractor = new MockThumbnailExtractor({ failMode: "missing_dependency" });

  const result2 = await ingestVideoOutput({
    jobId: "vjob-002",
    userId: "user_valid_123",
    ingestionToken: "vin-token-002",
    videoUrl: MOCK_MP4_PLAYABLE_DATA_URI,
    width: 1280,
    height: 720,
    durationSeconds: 5.0,
    storage: storage2 as any,
    thumbnailExtractor: missingExtractor,
    db: db2 as any,
    options: { requireThumbnail: false },
  });

  ok(result2.thumbnailKey === null, "graceful fallback sets thumbnailKey = null without corrupting metadata");
  ok(db2.assets.get(result2.assetId).thumbnailKey === null, "database asset has thumbnailKey: null");
  ok(db2.jobs.get("vjob-002").status === "COMPLETED", "job completes successfully even when FFmpeg is missing");

  // Requesting thumbnail on asset with thumbnailKey=null returns safe 404
  threw = false;
  try {
    await getSignedVideoAssetUrl({
      userId: "user_valid_123",
      assetId: result2.assetId,
      storage: storage2 as any,
      kind: "thumbnail",
      db: db2 as any,
    });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoStorageError>).code === "NOT_FOUND";
  }
  ok(threw, "requesting thumbnail on asset without thumbnail returns safe 404 NOT_FOUND");

  // 7. Strict Mode: requireThumbnail = true with Missing Extractor Cleans Up Video
  const db3 = new MockDbHarness();
  db3.jobs.set("vjob-003", {
    id: "vjob-003",
    userId: "user_valid_123",
    status: "PROCESSING",
    estimatedCredits: 10,
    ingestionToken: "vin-token-003",
    ingestionLeaseExpiresAt: new Date(Date.now() + 300_000),
  });
  const storage3 = new TestStorage();

  threw = false;
  try {
    await ingestVideoOutput({
      jobId: "vjob-003",
      userId: "user_valid_123",
      ingestionToken: "vin-token-003",
      videoUrl: MOCK_MP4_PLAYABLE_DATA_URI,
      width: 1280,
      height: 720,
      durationSeconds: 5.0,
      storage: storage3 as any,
      thumbnailExtractor: missingExtractor,
      db: db3 as any,
      options: { requireThumbnail: true },
    });
  } catch (e) {
    threw = (e as InstanceType<typeof ThumbnailExtractionError>).code === "MISSING_DEPENDENCY";
  }
  ok(threw, "strict mode aborts ingestion when thumbnail extraction fails");
  ok(storage3.files.size === 0, "uploaded video is deleted from storage on extraction failure (no orphan)");
  ok(storage3.deleted.length === 1, "storage.delete called for orphaned video object");

  // 8. Stale Lease Rejection & Orphan Cleanup
  const db4 = new MockDbHarness();
  db4.jobs.set("vjob-004", {
    id: "vjob-004",
    userId: "user_valid_123",
    status: "PROCESSING",
    estimatedCredits: 10,
    ingestionToken: "vin-worker-B-won",
    ingestionLeaseExpiresAt: new Date(Date.now() + 300_000),
  });
  const storage4 = new TestStorage();

  threw = false;
  try {
    await ingestVideoOutput({
      jobId: "vjob-004",
      userId: "user_valid_123",
      ingestionToken: "vin-stale-worker-A",
      videoUrl: MOCK_MP4_PLAYABLE_DATA_URI,
      width: 1280,
      height: 720,
      durationSeconds: 5.0,
      storage: storage4 as any,
      thumbnailExtractor: mockExtractor,
      db: db4 as any,
    });
  } catch (e) {
    threw = e instanceof JobNotCompletableError;
  }
  ok(threw, "stale ingestion token strictly rejected with JobNotCompletableError");
  ok(storage4.files.size === 0, "stale worker's uploaded objects deleted from storage (no orphans)");
  ok(storage4.deleted.length === 2, "cleaned up both video and thumbnail objects");

  // 9. Database Failure & Orphan Cleanup
  const db5 = new MockDbHarness();
  db5.jobs.set("vjob-005", {
    id: "vjob-005",
    userId: "user_valid_123",
    status: "PROCESSING",
    estimatedCredits: 10,
    ingestionToken: "vin-token-005",
    ingestionLeaseExpiresAt: new Date(Date.now() + 300_000),
  });
  db5.shouldFailDbCompletion = true;
  const storage5 = new TestStorage();

  threw = false;
  try {
    await ingestVideoOutput({
      jobId: "vjob-005",
      userId: "user_valid_123",
      ingestionToken: "vin-token-005",
      videoUrl: MOCK_MP4_PLAYABLE_DATA_URI,
      width: 1280,
      height: 720,
      durationSeconds: 5.0,
      storage: storage5 as any,
      thumbnailExtractor: mockExtractor,
      db: db5 as any,
    });
  } catch (e) {
    threw = (e as Error).message.includes("Simulated database connection failure");
  }
  ok(threw, "database completion failure propagates");
  ok(storage5.files.size === 0, "storage objects cleaned up on database failure (zero orphans)");
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
