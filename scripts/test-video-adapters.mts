// Stage 8, Batch 1: Video domain configuration, types, mock provider adapter,
// MP4 binary fixture, and ED25519 webhook signature verification tests.
//
// Fully offline: NO network, NO real API credentials, NO database.
// Global fetch is replaced with a throwing function.

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

globalThis.fetch = (async () => {
  throw new Error("Network access is forbidden in video adapter tests");
}) as typeof fetch;

const {
  DEFAULT_DAILY_USER_VIDEO_LIMIT,
  DEFAULT_VIDEO_CREDIT_COST,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_PROVIDER,
  DEFAULT_VIDEO_SETTINGS,
  MAX_PROVIDER_VIDEO_BYTES,
  MAX_STORED_THUMBNAIL_BYTES,
  MAX_STORED_VIDEO_BYTES,
  MOCK_VIDEO_MODEL,
  MOCK_VIDEO_PROVIDER,
  PROVISIONAL_PAID_DAILY_VIDEO_LIMIT,
  PROVISIONAL_QA_DAILY_VIDEO_LIMIT,
  STORED_THUMBNAIL_MIME,
  STORED_VIDEO_MIME,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_FRAME_RATES,
  VIDEO_INGESTION_LEASE_MS,
  VIDEO_POLL_INTERVAL_MS,
  VIDEO_PROCESSING_STALE_MS,
  VIDEO_PROVIDER_TIMEOUT_MS,
  VIDEO_RESOLUTIONS,
  VIDEO_SIGNED_URL_TTL_SECONDS,
  WEBHOOK_TIMESTAMP_TOLERANCE_MS,
  getDailyUserVideoLimit,
  getVideoCreditCost,
  isSupportedVideoAspectRatio,
  isSupportedVideoDuration,
  isSupportedVideoFrameRate,
  isSupportedVideoResolution,
  validateVideoPrompt,
} = await import("@/features/video/config");

const {
  canGenerateVideoInStage8,
  isServerAuthorizedQaUser,
  parseQaAllowlist,
  resolveUserVideoEntitlement,
} = await import("@/features/video/auth");

const { VideoProviderError } = await import("@/features/video/types");

const {
  createProviderHttpError,
  normalizeProviderError,
} = await import("@/features/video/providers/adapter");

const {
  MOCK_MP4_BASE64,
  MOCK_MP4_DATA_URI,
  MOCK_MP4_FIXTURE_BUFFER,
  MOCK_MP4_PLAYABLE_BASE64,
  MOCK_MP4_PLAYABLE_DATA_URI,
  MOCK_MP4_PLAYABLE_FIXTURE_BUFFER,
  MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER,
  createMockMp4Buffer,
  createPlayableMp4Buffer,
  inspectMp4Buffer,
} = await import("@/features/video/providers/fixture");

const { MockVideoProvider } = await import("@/features/video/providers/mock-provider");

const {
  extractHeader,
  generateTestEd25519KeyPair,
  signTestWebhookPayload,
  verifyEd25519WebhookSignature,
} = await import("@/features/video/webhooks/verify");

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) {
    pass++;
    console.log(`PASS  ${m}`);
  } else {
    fail++;
    console.log(`FAIL  ${m}`);
  }
};
const section = (s: string) => console.log(`\n# ${s}`);

// ===========================================================================
// Section 1: Configuration & Settings Validation
// ===========================================================================
section("Section 1: Configuration & Settings Validation");

ok(
  VIDEO_ASPECT_RATIOS["16:9"].width === 1280 &&
    VIDEO_ASPECT_RATIOS["16:9"].height === 720,
  "16:9 aspect ratio defines 1280x720 dimensions"
);

ok(
  VIDEO_ASPECT_RATIOS["9:16"].width === 720 &&
    VIDEO_ASPECT_RATIOS["9:16"].height === 1280,
  "9:16 aspect ratio defines 720x1280 dimensions"
);

ok(
  VIDEO_ASPECT_RATIOS["1:1"].width === 960 &&
    VIDEO_ASPECT_RATIOS["1:1"].height === 960,
  "1:1 aspect ratio defines 960x960 dimensions"
);

ok(
  VIDEO_DURATIONS[5].seconds === 5,
  "Supported duration includes 5 seconds"
);

ok(
  VIDEO_RESOLUTIONS["720p"].verticalPixels === 720,
  "Supported resolution includes 720p"
);

ok(
  VIDEO_FRAME_RATES[16].fps === 16,
  "Supported frame rate includes 16 fps"
);

ok(
  DEFAULT_VIDEO_SETTINGS.aspectRatio === "16:9" &&
    DEFAULT_VIDEO_SETTINGS.duration === 5 &&
    DEFAULT_VIDEO_SETTINGS.resolution === "720p" &&
    DEFAULT_VIDEO_SETTINGS.fps === 16,
  "Default settings are 16:9, 5s, 720p, 16fps"
);

// Type guards
ok(
  isSupportedVideoAspectRatio("16:9") &&
    isSupportedVideoAspectRatio("9:16") &&
    isSupportedVideoAspectRatio("1:1"),
  "isSupportedVideoAspectRatio accepts all approved aspect ratios"
);
ok(
  !isSupportedVideoAspectRatio("4:3") &&
    !isSupportedVideoAspectRatio("") &&
    !isSupportedVideoAspectRatio(null),
  "isSupportedVideoAspectRatio rejects unapproved aspect ratios"
);

ok(
  isSupportedVideoDuration(5) && !isSupportedVideoDuration(10),
  "isSupportedVideoDuration validates 5s and rejects unapproved durations"
);

ok(
  isSupportedVideoResolution("720p") && !isSupportedVideoResolution("1080p"),
  "isSupportedVideoResolution validates 720p and rejects unapproved resolutions"
);

ok(
  isSupportedVideoFrameRate(16) && !isSupportedVideoFrameRate(24) && !isSupportedVideoFrameRate(60),
  "isSupportedVideoFrameRate validates 16fps and rejects unapproved frame rates (including 24fps)"
);

// Configurable credit pricing
ok(
  DEFAULT_VIDEO_CREDIT_COST === 10,
  "DEFAULT_VIDEO_CREDIT_COST is 10 credits (configurable default)"
);
ok(
  getVideoCreditCost() === 10 &&
    getVideoCreditCost({ duration: 5, resolution: "720p" }) === 10,
  "getVideoCreditCost returns 10 credits by default"
);

// Daily limit & quotas
ok(
  DEFAULT_DAILY_USER_VIDEO_LIMIT === 1,
  "DEFAULT_DAILY_USER_VIDEO_LIMIT is 1 generation per day for promotional accounts"
);
ok(
  getDailyUserVideoLimit() === 1 &&
    getDailyUserVideoLimit("promotional") === 1,
  "getDailyUserVideoLimit defaults to 1 for promotional tier"
);
ok(
  getDailyUserVideoLimit("qa") === 10,
  "getDailyUserVideoLimit('qa') returns 10 for authorized QA accounts"
);
ok(
  getDailyUserVideoLimit("paid") === 50,
  "getDailyUserVideoLimit('paid') returns 50 for paid tier"
);
ok(
  getDailyUserVideoLimit("unrecognized_tier") === 1 &&
    getDailyUserVideoLimit("enterprise") === 1 &&
    getDailyUserVideoLimit(null) === 1 &&
    getDailyUserVideoLimit("") === 1,
  "getDailyUserVideoLimit fails closed to promotional (1) for unknown or malformed tiers"
);

// File size limits
ok(
  MAX_PROVIDER_VIDEO_BYTES === 35 * 1024 * 1024,
  "MAX_PROVIDER_VIDEO_BYTES is 35 MB"
);
ok(
  MAX_STORED_VIDEO_BYTES === 35 * 1024 * 1024,
  "MAX_STORED_VIDEO_BYTES is 35 MB"
);
ok(
  MAX_STORED_THUMBNAIL_BYTES === 1 * 1024 * 1024,
  "MAX_STORED_THUMBNAIL_BYTES is 1 MB"
);
ok(
  STORED_VIDEO_MIME === "video/mp4" && STORED_THUMBNAIL_MIME === "image/webp",
  "Stored MIME types are video/mp4 and image/webp"
);
ok(
  VIDEO_SIGNED_URL_TTL_SECONDS === 600,
  "VIDEO_SIGNED_URL_TTL_SECONDS is 600s (10 minutes)"
);

// Timing invariants
ok(
  VIDEO_PROVIDER_TIMEOUT_MS < VIDEO_INGESTION_LEASE_MS &&
    VIDEO_INGESTION_LEASE_MS < VIDEO_PROCESSING_STALE_MS,
  "Timing invariant: PROVIDER_TIMEOUT (120s) < INGESTION_LEASE (300s) < PROCESSING_STALE (900s)"
);
ok(
  VIDEO_POLL_INTERVAL_MS === 4_000,
  "VIDEO_POLL_INTERVAL_MS is 4,000 ms"
);
ok(
  WEBHOOK_TIMESTAMP_TOLERANCE_MS === 300_000,
  "WEBHOOK_TIMESTAMP_TOLERANCE_MS is 300,000 ms (5 minutes)"
);

// Prompt validation
ok(
  validateVideoPrompt("A serene ocean sunset").valid === true &&
    validateVideoPrompt("A serene ocean sunset").cleaned === "A serene ocean sunset",
  "validateVideoPrompt accepts valid prompt"
);
ok(
  validateVideoPrompt("   ").valid === false,
  "validateVideoPrompt rejects whitespace-only prompt"
);
ok(
  validateVideoPrompt("").valid === false,
  "validateVideoPrompt rejects empty prompt"
);
ok(
  validateVideoPrompt(123).valid === false,
  "validateVideoPrompt rejects non-string prompt"
);
ok(
  validateVideoPrompt("a".repeat(2049)).valid === false,
  "validateVideoPrompt rejects prompt exceeding 2048 characters"
);

// ===========================================================================
// Section 2: Valid MP4 Fixture & Binary Parsing
// ===========================================================================
section("Section 2: Valid MP4 Fixture & Binary Parsing");

// 1. Structural fixture (631 bytes)
ok(
  Buffer.isBuffer(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER) &&
    MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER.length === 631,
  `MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER is valid 631-byte structural buffer`
);

const structuralInspection = inspectMp4Buffer(MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER);
ok(
  structuralInspection.isValid === true,
  "inspectMp4Buffer validates structural fixture as conforming ISOBMFF container"
);
ok(
  structuralInspection.hasFtyp && structuralInspection.hasMoov && structuralInspection.hasMdat,
  "Structural fixture contains mandatory ftyp, moov, and mdat boxes"
);
ok(
  structuralInspection.isPlayableH264 === false && structuralInspection.hasAvcC === false,
  "Structural fixture accurately identified as non-playable (lacks avcC box)"
);

// 2. Playable H.264 fixture (19,190 bytes)
ok(
  Buffer.isBuffer(MOCK_MP4_PLAYABLE_FIXTURE_BUFFER) &&
    MOCK_MP4_PLAYABLE_FIXTURE_BUFFER.length === 19190,
  `MOCK_MP4_PLAYABLE_FIXTURE_BUFFER is valid 19,190-byte playable buffer`
);

const playableInspection = inspectMp4Buffer(MOCK_MP4_PLAYABLE_FIXTURE_BUFFER);
ok(
  playableInspection.isValid === true,
  "inspectMp4Buffer validates playable fixture as conforming ISOBMFF container"
);
ok(
  playableInspection.hasFtyp && playableInspection.hasMoov && playableInspection.hasMdat,
  "Playable fixture contains mandatory ftyp, moov, and mdat boxes"
);
ok(
  playableInspection.hasAvcC === true && playableInspection.isPlayableH264 === true,
  "Playable fixture verified as decodable H.264 video (contains authentic avcC with SPS/PPS)"
);
ok(
  MOCK_MP4_PLAYABLE_DATA_URI.startsWith("data:video/mp4;base64,") &&
    MOCK_MP4_PLAYABLE_BASE64.length > 5000,
  "MOCK_MP4_PLAYABLE_DATA_URI has valid data URI scheme and complete base64 payload"
);

// 3. Custom aspect ratio MP4 buffer generation
const portraitBuffer = createMockMp4Buffer({ width: 720, height: 1280, durationSeconds: 5 });
const portraitInspection = inspectMp4Buffer(portraitBuffer);
ok(
  portraitInspection.isValid === true && portraitBuffer.length > 500,
  "createMockMp4Buffer generates valid custom 720x1280 MP4 buffer"
);

// Data URI format for structural fixture
ok(
  MOCK_MP4_DATA_URI.startsWith("data:video/mp4;base64,") &&
    MOCK_MP4_BASE64.length > 100,
  "MOCK_MP4_DATA_URI has valid data URI scheme and base64 payload"
);

// Corrupted / truncated buffer rejection
ok(
  inspectMp4Buffer(Buffer.alloc(8)).isValid === false,
  "inspectMp4Buffer rejects truncated buffer (<16 bytes)"
);
ok(
  inspectMp4Buffer(Buffer.from("invalid-mp4-data-stream-not-isobmff")).isValid === false,
  "inspectMp4Buffer rejects non-ISOBMFF stream"
);

// ===========================================================================
// Section 3: MockVideoProvider Lifecycle & Deterministic Progression
// ===========================================================================
section("Section 3: MockVideoProvider Lifecycle & Deterministic Progression");

const provider = new MockVideoProvider({ transitionSteps: 1 });
ok(provider.id === MOCK_VIDEO_PROVIDER, "Provider id matches MOCK_VIDEO_PROVIDER");
ok(provider.model === MOCK_VIDEO_MODEL, "Provider model matches MOCK_VIDEO_MODEL");

// Submit
const submitResult = await provider.submit({
  prompt: "A neon hologram rotating in cyber city",
  settings: { aspectRatio: "16:9", duration: 5, resolution: "720p", fps: 16 },
});

ok(
  typeof submitResult.providerJobId === "string" &&
    submitResult.providerJobId.startsWith("mock-vjob-"),
  `submit() returns deterministic providerJobId: ${submitResult.providerJobId}`
);
ok(
  submitResult.status === "PENDING",
  "Initial submission status is 'PENDING'"
);

// Check 1: PENDING
const status1 = await provider.checkStatus(submitResult.providerJobId);
ok(
  status1.status === "PENDING",
  "First checkStatus() returns PENDING"
);

// Check 2: PROCESSING
const status2 = await provider.checkStatus(submitResult.providerJobId);
ok(
  status2.status === "PROCESSING",
  "Second checkStatus() transitions to PROCESSING"
);

// Check 3: COMPLETED
const status3 = await provider.checkStatus(submitResult.providerJobId);
ok(
  status3.status === "COMPLETED",
  "Third checkStatus() transitions to COMPLETED"
);
ok(
  status3.metadata !== null && status3.metadata !== undefined,
  "Completed status includes video metadata"
);
ok(
  status3.metadata?.mimeType === "video/mp4" &&
    status3.metadata?.width === 1280 &&
    status3.metadata?.height === 720 &&
    status3.metadata?.durationSeconds === 5 &&
    status3.metadata?.fps === 16,
  "Metadata accurately reflects 16:9 aspect ratio (1280x720, 5s, 16fps)"
);
ok(
  status3.metadata?.videoUrl.startsWith("data:video/mp4;base64,") === true,
  "Metadata videoUrl contains valid data URI with MP4 payload"
);

// Check 4: Duplicate checks in COMPLETED (idempotent)
const status4 = await provider.checkStatus(submitResult.providerJobId);
ok(
  status4.status === "COMPLETED" &&
    status4.metadata?.width === status3.metadata?.width &&
    status4.metadata?.videoUrl === status3.metadata?.videoUrl,
  "Duplicate checkStatus() on COMPLETED job is strictly idempotent"
);

// Aspect ratio propagation (9:16 portrait)
const portraitSubmit = await provider.submit({
  prompt: "A drone shot flying through bamboo forest",
  settings: { aspectRatio: "9:16" },
});
await provider.checkStatus(portraitSubmit.providerJobId); // PENDING -> PROCESSING
await provider.checkStatus(portraitSubmit.providerJobId); // PROCESSING -> COMPLETED
const portraitFinal = await provider.checkStatus(portraitSubmit.providerJobId);
ok(
  portraitFinal.status === "COMPLETED" &&
    portraitFinal.metadata?.width === 720 &&
    portraitFinal.metadata?.height === 1280,
  "9:16 job generates metadata with width 720 and height 1280"
);

// Aspect ratio propagation (1:1 square)
const squareSubmit = await provider.submit({
  prompt: "A retro pixel art character dancing",
  settings: { aspectRatio: "1:1" },
});
await provider.checkStatus(squareSubmit.providerJobId);
await provider.checkStatus(squareSubmit.providerJobId);
const squareFinal = await provider.checkStatus(squareSubmit.providerJobId);
ok(
  squareFinal.status === "COMPLETED" &&
    squareFinal.metadata?.width === 960 &&
    squareFinal.metadata?.height === 960,
  "1:1 job generates metadata with width 960 and height 960"
);

// Slow mode progression
const slowSubmit = await provider.submit({
  prompt: "A peaceful garden [mock:slow]",
});
let checkCount = 0;
let currentStatus = await provider.checkStatus(slowSubmit.providerJobId);
while (currentStatus.status !== "COMPLETED" && checkCount < 10) {
  checkCount++;
  currentStatus = await provider.checkStatus(slowSubmit.providerJobId);
}
ok(
  checkCount >= 5 && currentStatus.status === "COMPLETED",
  `[mock:slow] requires multiple checks before completion (${checkCount} checks taken)`
);

// Playable fixture mode in MockVideoProvider
const playableSubmit = await provider.submit({
  prompt: "A cinematic test shot [mock:playable]",
});
await provider.checkStatus(playableSubmit.providerJobId);
await provider.checkStatus(playableSubmit.providerJobId);
const playableDone = await provider.checkStatus(playableSubmit.providerJobId);
ok(
  playableDone.status === "COMPLETED" &&
    playableDone.metadata?.videoUrl === MOCK_MP4_PLAYABLE_DATA_URI &&
    playableDone.metadata?.fileSizeBytes === 19190,
  "MockVideoProvider with [mock:playable] returns genuine playable H.264 video fixture"
);

// ===========================================================================
// Section 4: Mock Provider Failure & Cancellation Scenarios
// ===========================================================================
section("Section 4: Mock Provider Failure & Cancellation Scenarios");

// Submit-time network failure
let networkFailed = false;
try {
  await provider.submit({ prompt: "A city [mock:fail:network]" });
} catch (err) {
  if (err instanceof VideoProviderError) {
    networkFailed = err.code === "NETWORK" && err.outcome === "not_run";
  }
}
ok(networkFailed, "Submit-time [mock:fail:network] throws VideoProviderError(NETWORK, not_run)");

// Submit-time policy failure
let policyFailed = false;
try {
  await provider.submit({ prompt: "Banned text [mock:fail:immediate_policy]" });
} catch (err) {
  if (err instanceof VideoProviderError) {
    policyFailed = err.code === "CONTENT_POLICY" && err.outcome === "not_run";
  }
}
ok(policyFailed, "Submit-time [mock:fail:immediate_policy] throws VideoProviderError(CONTENT_POLICY, not_run)");

// Async failures: not_run
const failNotRunSubmit = await provider.submit({ prompt: "Test [mock:fail:not_run]" });
const failNotRunStatus = await provider.checkStatus(failNotRunSubmit.providerJobId);
ok(
  failNotRunStatus.status === "FAILED",
  "Async [mock:fail:not_run] transitions to FAILED status"
);

// Async failures: policy
const failPolicySubmit = await provider.submit({ prompt: "NSFW [mock:fail:policy]" });
const failPolicyStatus = await provider.checkStatus(failPolicySubmit.providerJobId);
ok(
  failPolicyStatus.status === "FAILED" &&
    failPolicyStatus.error?.code === "CONTENT_POLICY",
  "Async [mock:fail:policy] transitions to FAILED with code CONTENT_POLICY"
);

// Idempotent failed checks
const duplicateFailStatus = await provider.checkStatus(failPolicySubmit.providerJobId);
ok(
  duplicateFailStatus.status === "FAILED",
  "Duplicate checkStatus() on FAILED job remains FAILED"
);

// Non-existent job check
let notFoundOk = false;
try {
  await provider.checkStatus("non-existent-job-id");
} catch (err) {
  if (err instanceof VideoProviderError) {
    notFoundOk = err.code === "INVALID_REQUEST" && err.httpStatus === 404;
  }
}
ok(notFoundOk, "checkStatus() for non-existent job throws VideoProviderError(INVALID_REQUEST, 404)");

// Job Cancellation
const cancelTargetSubmit = await provider.submit({ prompt: "A car cruising down highway" });
const cancelRes = await provider.cancel!(cancelTargetSubmit.providerJobId);
ok(
  cancelRes.cancelled === true,
  "cancel() successfully cancels an active job"
);

const cancelledStatus = await provider.checkStatus(cancelTargetSubmit.providerJobId);
ok(
  cancelledStatus.status === "CANCELLED",
  "checkStatus() after cancellation returns status CANCELLED"
);

// Cancelling an already completed job
const alreadyDoneSubmit = await provider.submit({ prompt: "A sunrise over mountains" });
await provider.checkStatus(alreadyDoneSubmit.providerJobId);
await provider.checkStatus(alreadyDoneSubmit.providerJobId);
const doneStatus = await provider.checkStatus(alreadyDoneSubmit.providerJobId);
ok(doneStatus.status === "COMPLETED", "Target job reached COMPLETED");

const cancelCompletedRes = await provider.cancel!(alreadyDoneSubmit.providerJobId);
ok(
  cancelCompletedRes.cancelled === false &&
    cancelCompletedRes.reason?.includes("already completed") === true,
  "cancel() on completed job returns cancelled: false with informative reason"
);

// Cancelling non-existent job
const cancelMissingRes = await provider.cancel!("ghost-job-xyz");
ok(
  cancelMissingRes.cancelled === false &&
    cancelMissingRes.reason?.includes("not found") === true,
  "cancel() on non-existent job returns cancelled: false"
);

// ===========================================================================
// Section 5: Error Normalization & Logging Safety
// ===========================================================================
section("Section 5: Error Normalization & Logging Safety");

// Preserves existing VideoProviderError
const originalErr = new VideoProviderError({
  code: "AUTH",
  outcome: "not_run",
  message: "Unauthorized token",
});
const norm1 = normalizeProviderError(originalErr);
ok(norm1 === originalErr, "normalizeProviderError returns existing VideoProviderError directly");

// AbortError normalization
const abortErr = new Error("The user aborted a request.");
abortErr.name = "AbortError";
const normAbort = normalizeProviderError(abortErr, "job-123");
ok(
  normAbort.code === "CANCELLED" && normAbort.outcome === "unknown",
  "normalizeProviderError maps AbortError to CANCELLED (unknown)"
);

// Network error normalization
const netErr = new Error("getaddrinfo ENOTFOUND api.fal.ai");
const normNet = normalizeProviderError(netErr);
ok(
  normNet.code === "NETWORK" && normNet.outcome === "not_run",
  "normalizeProviderError maps ENOTFOUND to NETWORK (not_run)"
);

// Content policy error normalization
const policyErr = new Error("Safety moderation triggered: content contains nsfw words");
const normPolicy = normalizeProviderError(policyErr);
ok(
  normPolicy.code === "CONTENT_POLICY" && normPolicy.outcome === "not_run",
  "normalizeProviderError maps moderation/nsfw exception to CONTENT_POLICY (not_run)"
);

// Rate limit error normalization
const rateErr = new Error("Too Many Requests: 429 rate limit exceeded");
const normRate = normalizeProviderError(rateErr);
ok(
  normRate.code === "RATE_LIMITED" && normRate.outcome === "not_run",
  "normalizeProviderError maps 429 to RATE_LIMITED (not_run)"
);

// HTTP status mapper
const http401 = createProviderHttpError({ status: 401, bodyText: "Invalid Bearer token" });
ok(
  http401.code === "AUTH" && http401.outcome === "not_run",
  "createProviderHttpError maps 401 to AUTH (not_run)"
);

const http404 = createProviderHttpError({ status: 404, bodyText: "Model fal-ai/wan-unknown not found" });
ok(
  http404.code === "MODEL_NOT_FOUND" && http404.outcome === "not_run",
  "createProviderHttpError maps 404 to MODEL_NOT_FOUND (not_run)"
);

const http504 = createProviderHttpError({ status: 504, bodyText: "Gateway Timeout" });
ok(
  http504.code === "TIMEOUT" && http504.outcome === "unknown",
  "createProviderHttpError maps 504 to TIMEOUT (unknown)"
);

// Secret-free toLog()
const errWithSecret = new VideoProviderError({
  code: "AUTH",
  outcome: "not_run",
  message: "Failed auth for user request",
  providerJobId: "vjob-999",
  providerCode: "UNAUTHORIZED",
  httpStatus: 401,
});
const logObj = errWithSecret.toLog();
ok(
  logObj.code === "AUTH" &&
    logObj.providerJobId === "vjob-999" &&
    !("token" in logObj) &&
    !("authorization" in logObj),
  "toLog() generates clean structured log without sensitive credential fields"
);

// ===========================================================================
// Section 6: Webhook Verification Boundary & ED25519 Cryptography
// ===========================================================================
section("Section 6: Webhook Verification Boundary & ED25519 Cryptography");

// Keypair generation
const keypair = generateTestEd25519KeyPair();
ok(
  typeof keypair.publicKeyPem === "string" && keypair.publicKeyPem.includes("PUBLIC KEY"),
  "generateTestEd25519KeyPair() creates valid SPKI PEM public key"
);
ok(
  typeof keypair.privateKeyPem === "string" && keypair.privateKeyPem.includes("PRIVATE KEY"),
  "generateTestEd25519KeyPair() creates valid PKCS#8 PEM private key"
);

// Successful verification with fresh timestamp
const payloadBody = JSON.stringify({
  request_id: "fal-req-12345",
  status: "OK",
  video: { url: "https://v3.fal.media/output.mp4" },
});
const nowSec = Math.floor(Date.now() / 1000);
const signedData = signTestWebhookPayload({
  rawBody: payloadBody,
  privateKey: keypair.privateKey,
  timestamp: nowSec,
  encoding: "base64",
});

const verifySuccess = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: signedData.headers,
  publicKey: keypair.publicKey,
});
ok(
  verifySuccess.valid === true,
  "verifyEd25519WebhookSignature successfully verifies valid payload with fresh timestamp"
);

// Hex-encoded signature format
const hexSignedData = signTestWebhookPayload({
  rawBody: payloadBody,
  privateKey: keypair.privateKey,
  timestamp: nowSec,
  encoding: "hex",
});
const verifyHex = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: hexSignedData.headers,
  publicKey: keypair.publicKey,
});
ok(
  verifyHex.valid === true,
  "verifyEd25519WebhookSignature supports 128-char hex-encoded signatures"
);

// Svix-style v1= prefix
const v1Headers = {
  "x-fal-signature": `v1=${signedData.signature}`,
  "x-fal-timestamp": signedData.timestamp,
};
const verifyV1 = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: v1Headers,
  publicKey: keypair.publicKey,
});
ok(
  verifyV1.valid === true,
  "verifyEd25519WebhookSignature supports 'v1=' signature prefix format"
);

// Tampered payload body detection
const tamperedBody = JSON.stringify({
  request_id: "fal-req-12345",
  status: "TAMPERED_STATUS",
  video: { url: "https://malicious.cdn/fake.mp4" },
});
const verifyTampered = verifyEd25519WebhookSignature({
  rawBody: tamperedBody,
  headers: signedData.headers,
  publicKey: keypair.publicKey,
});
ok(
  verifyTampered.valid === false &&
    verifyTampered.error?.includes("Signature verification failed") === true,
  "verifyEd25519WebhookSignature rejects tampered body payload"
);

// Wrong signature detection
const verifyWrongSig = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: {
    "x-fal-signature": Buffer.alloc(64, 0xaa).toString("base64"),
    "x-fal-timestamp": String(nowSec),
  },
  publicKey: keypair.publicKey,
});
ok(
  verifyWrongSig.valid === false,
  "verifyEd25519WebhookSignature rejects mismatched signature"
);

// Missing signature header detection
const verifyMissingSig = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: { "x-fal-timestamp": String(nowSec) },
  publicKey: keypair.publicKey,
});
ok(
  verifyMissingSig.valid === false &&
    verifyMissingSig.error?.includes("Missing required webhook signature") === true,
  "verifyEd25519WebhookSignature rejects request missing signature header"
);

// Replay attack prevention: Expired timestamp (10 minutes old)
const oldTimestampSec = nowSec - 600; // 10 minutes ago (> 5m tolerance)
const expiredSignedData = signTestWebhookPayload({
  rawBody: payloadBody,
  privateKey: keypair.privateKey,
  timestamp: oldTimestampSec,
});
const verifyExpired = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: expiredSignedData.headers,
  publicKey: keypair.publicKey,
});
ok(
  verifyExpired.valid === false &&
    verifyExpired.error?.includes("Webhook timestamp expired") === true,
  "verifyEd25519WebhookSignature rejects expired timestamp (replay attack prevention)"
);

// Future timestamp clock skew protection (> 60s in future)
const futureTimestampSec = nowSec + 300; // 5 minutes in future
const futureSignedData = signTestWebhookPayload({
  rawBody: payloadBody,
  privateKey: keypair.privateKey,
  timestamp: futureTimestampSec,
});
const verifyFuture = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: futureSignedData.headers,
  publicKey: keypair.publicKey,
});
ok(
  verifyFuture.valid === false &&
    verifyFuture.error?.includes("in the future beyond allowable clock skew") === true,
  "verifyEd25519WebhookSignature rejects future timestamp beyond clock skew limit"
);

// Case-insensitive header extraction
const mixedCaseHeaders = {
  "X-FAL-SIGNATURE": signedData.signature,
  "X-FAL-TIMESTAMP": signedData.timestamp,
};
const verifyMixedCase = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: mixedCaseHeaders,
  publicKey: keypair.publicKey,
});
ok(
  verifyMixedCase.valid === true,
  "verifyEd25519WebhookSignature correctly matches case-insensitive headers (X-FAL-SIGNATURE)"
);

// Public key string parsing (PEM string instead of KeyObject)
const verifyPemString = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: signedData.headers,
  publicKey: keypair.publicKeyPem,
});
ok(
  verifyPemString.valid === true,
  "verifyEd25519WebhookSignature accepts PEM string public key"
);

// Malformed public key handled gracefully
const verifyBadKey = verifyEd25519WebhookSignature({
  rawBody: payloadBody,
  headers: signedData.headers,
  publicKey: "not-a-valid-pem-key",
});
ok(
  verifyBadKey.valid === false &&
    verifyBadKey.error?.includes("Failed to load public key") === true,
  "verifyEd25519WebhookSignature safely returns error on malformed public key"
);

// ===========================================================================
// Section 7: Server-Side QA Authorization & Entitlement Gating
// ===========================================================================
section("Section 7: Server-Side QA Authorization & Entitlement Gating");

// parseQaAllowlist helper
const parsedAllowlist = parseQaAllowlist("cuser_qa_1, cuser_qa_2; qa1@yourai.test\nqa2@yourai.test");
ok(
  parsedAllowlist.userIds.has("cuser_qa_1") &&
    parsedAllowlist.userIds.has("cuser_qa_2") &&
    parsedAllowlist.emails.has("qa1@yourai.test") &&
    parsedAllowlist.emails.has("qa2@yourai.test"),
  "parseQaAllowlist parses comma, semicolon, and newline-separated user IDs and emails"
);
ok(
  parseQaAllowlist("").userIds.size === 0 && parseQaAllowlist(null).emails.size === 0,
  "parseQaAllowlist handles empty and null inputs safely"
);

// 1. Missing QA configuration
ok(
  isServerAuthorizedQaUser({
    user: { id: "cuser_qa_1", email: "qa@yourai.test", emailVerified: true },
    allowlistRaw: undefined,
    nodeEnv: "production",
  }) === false,
  "isServerAuthorizedQaUser fails closed when allowlist is undefined in production"
);
ok(
  isServerAuthorizedQaUser({
    user: { id: "cuser_qa_1", email: "qa@yourai.test", emailVerified: true },
    allowlistRaw: null,
    nodeEnv: "development",
  }) === false,
  "isServerAuthorizedQaUser returns false when allowlist is null"
);

// 2. Empty or whitespace-only QA configuration
ok(
  isServerAuthorizedQaUser({
    user: { id: "cuser_qa_1" },
    allowlistRaw: "   ",
    nodeEnv: "production",
  }) === false,
  "isServerAuthorizedQaUser fails closed when allowlist is whitespace in production"
);
ok(
  isServerAuthorizedQaUser({
    user: { id: "cuser_qa_1" },
    allowlistRaw: "",
    nodeEnv: "development",
  }) === false,
  "isServerAuthorizedQaUser returns false when allowlist is empty string"
);

// 3. Unauthorized users
const testAllowlist = "cuser_qa_123, verified-qa@yourai.test";
ok(
  isServerAuthorizedQaUser({
    user: { id: "cuser_unauthorized_999", email: "stranger@example.com", emailVerified: true },
    allowlistRaw: testAllowlist,
  }) === false,
  "isServerAuthorizedQaUser rejects user not present in allowlist"
);
ok(
  isServerAuthorizedQaUser({
    user: null,
    allowlistRaw: testAllowlist,
  }) === false,
  "isServerAuthorizedQaUser rejects null user safely"
);

// 4. Stable User ID matching (preferred)
ok(
  isServerAuthorizedQaUser({
    user: { id: "cuser_qa_123" },
    allowlistRaw: testAllowlist,
  }) === true,
  "isServerAuthorizedQaUser authorizes user by stable user ID regardless of email"
);
ok(
  isServerAuthorizedQaUser({
    user: { id: "  cuser_qa_123  " },
    allowlistRaw: testAllowlist,
  }) === true,
  "isServerAuthorizedQaUser handles whitespace trimming on user ID"
);

// 5. Verified vs unverified email identities
ok(
  isServerAuthorizedQaUser({
    user: { email: "verified-qa@yourai.test", emailVerified: new Date() },
    allowlistRaw: testAllowlist,
  }) === true,
  "isServerAuthorizedQaUser authorizes email match when emailVerified is a Date"
);
ok(
  isServerAuthorizedQaUser({
    user: { email: "verified-qa@yourai.test", emailVerified: true },
    allowlistRaw: testAllowlist,
  }) === true,
  "isServerAuthorizedQaUser authorizes email match when emailVerified is true"
);
ok(
  isServerAuthorizedQaUser({
    user: { email: "verified-qa@yourai.test", emailVerified: null },
    allowlistRaw: testAllowlist,
  }) === false,
  "isServerAuthorizedQaUser strictly denies unverified email match (emailVerified: null)"
);
ok(
  isServerAuthorizedQaUser({
    user: { email: "verified-qa@yourai.test", emailVerified: false },
    allowlistRaw: testAllowlist,
  }) === false,
  "isServerAuthorizedQaUser strictly denies unverified email match (emailVerified: false)"
);

// 6. Email case and whitespace normalization
ok(
  isServerAuthorizedQaUser({
    user: { email: "  VERIFIED-QA@YourAI.Test  ", emailVerified: true },
    allowlistRaw: testAllowlist,
  }) === true,
  "isServerAuthorizedQaUser normalizes email case and whitespace for matching"
);

// 7. Client-supplied tier manipulation ignored
const spoofedClientPayload = {
  tier: "paid",
  isQa: true,
  isQaAuthorized: true,
  dailyLimit: 9999,
  role: "admin",
};
const promotionalUserEntitlement = resolveUserVideoEntitlement({
  user: { id: "cuser_regular_user", email: "user@example.com", emailVerified: true },
  clientPayload: spoofedClientPayload,
  allowlistRaw: testAllowlist,
});
ok(
  promotionalUserEntitlement.tier === "promotional" &&
    promotionalUserEntitlement.dailyLimit === 1 &&
    promotionalUserEntitlement.isQaAuthorized === false,
  "resolveUserVideoEntitlement strictly ignores spoofed client tier/QA payload"
);

// 8. Trusted subscription validation
const activePaidEntitlement = resolveUserVideoEntitlement({
  user: { id: "cuser_subscriber_1" },
  trustedSubscription: { status: "active", tier: "paid" },
  allowlistRaw: testAllowlist,
});
ok(
  activePaidEntitlement.tier === "paid" &&
    activePaidEntitlement.dailyLimit === 50 &&
    activePaidEntitlement.creditCost === 10,
  "resolveUserVideoEntitlement grants paid tier (50 limit) only with trusted active subscription"
);

const cancelledSubscriptionEntitlement = resolveUserVideoEntitlement({
  user: { id: "cuser_cancelled_sub" },
  trustedSubscription: { status: "cancelled", tier: "paid" },
  allowlistRaw: testAllowlist,
});
ok(
  cancelledSubscriptionEntitlement.tier === "promotional" &&
    cancelledSubscriptionEntitlement.dailyLimit === 1,
  "resolveUserVideoEntitlement falls back to promotional when subscription status is not active"
);

// 9. QA authorization entitlement resolution
const qaEntitlement = resolveUserVideoEntitlement({
  user: { id: "cuser_qa_123" },
  allowlistRaw: testAllowlist,
});
ok(
  qaEntitlement.tier === "qa" &&
    qaEntitlement.dailyLimit === 10 &&
    qaEntitlement.isQaAuthorized === true,
  "resolveUserVideoEntitlement grants qa tier (10 limit) for authorized QA user"
);

// 10. Unknown tier fail-closed to promotional (1)
ok(
  getDailyUserVideoLimit("unrecognized_tier") === 1 &&
    getDailyUserVideoLimit("vip_tier") === 1,
  "getDailyUserVideoLimit fails closed to 1 for arbitrary unknown tiers"
);

// 11. Stage 8 production gating (canGenerateVideoInStage8)
const prodQaAccess = canGenerateVideoInStage8({
  entitlement: qaEntitlement,
  nodeEnv: "production",
});
ok(
  prodQaAccess.allowed === true,
  "canGenerateVideoInStage8 allows QA authorized user in production"
);

const prodPromoAccess = canGenerateVideoInStage8({
  entitlement: promotionalUserEntitlement,
  nodeEnv: "production",
});
ok(
  prodPromoAccess.allowed === false &&
    prodPromoAccess.reason?.includes("restricted to authorized QA accounts") === true,
  "canGenerateVideoInStage8 blocks promotional user in production with clear explanation"
);

const devPromoAccess = canGenerateVideoInStage8({
  entitlement: promotionalUserEntitlement,
  nodeEnv: "development",
});
ok(
  devPromoAccess.allowed === true,
  "canGenerateVideoInStage8 permits access in development environment"
);

// ===========================================================================
// Test Summary
// ===========================================================================
console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
