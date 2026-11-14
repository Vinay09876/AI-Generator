// Stage 8, Batch 3: Fal.ai Provider Adapter, Webhook Fast-ACK & Asynchronous Orchestration
//
// Fully offline: NO real Fal.ai API calls, NO real Cloudflare calls, ₹0 spend.
// Tests official Fal.ai Ed25519 signature verification, timestamp replay protection,
// durable webhook persistence, Fast-ACK, leased event claiming, out-of-order handling,
// duplicate deliveries, and crash recovery.
//
// Run: npm run test:video-webhooks

import crypto from "node:crypto";
import { Readable } from "node:stream";

// Clear ambient environment keys
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
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_PROVIDER,
  VIDEO_PROVIDER_TIMEOUT_MS,
  WEBHOOK_TIMESTAMP_TOLERANCE_MS,
} = await import("@/features/video/config");

const {
  FalVideoProvider,
  getFalVideoProvider,
} = await import("@/features/video/providers/fal-provider");

const {
  convertJwkToEd25519KeyObject,
  generateFalTestKeypair,
  signFalWebhookPayload,
  verifyFalWebhookSignature,
} = await import("@/features/video/webhooks/fal-verify");

const {
  generateWebhookCorrelationToken,
  verifyWebhookCorrelationToken,
} = await import("@/features/video/webhooks/correlation");

const {
  claimWebhookEvent,
  getWebhookRetryBackoffMs,
  persistVerifiedWebhookEvent,
  resetExhaustedWebhookEvent,
  settleWebhookEvent,
  sweepStaleWebhookEvents,
} = await import("@/features/video/webhooks/durable-events");

const {
  processPendingWebhookBatch,
  processVideoWebhookEvent,
} = await import("@/features/video/webhooks/process-event");

const {
  recordVideoJobSubmissionAmbiguous,
  reconcileStaleVideoJobs,
  resolveAmbiguousJobAsFailed,
  resolveAmbiguousJobAsCompleted,
} = await import("@/features/video/lifecycle");

const {
  processPendingIngestionJobs,
} = await import("@/features/video/storage/ingestion");

const { VideoProviderError } = await import("@/features/video/types");
const { handleFalWebhookRequest: webhookRouteHandler } = await import("@/features/video/webhooks/fal-handler");
const { handleVideoCronRequest: cronRouteHandler } = await import("@/features/video/cron-auth");
const { MOCK_MP4_PLAYABLE_DATA_URI } = await import("@/features/video/providers/fixture");
const { MockThumbnailExtractor } = await import("@/features/video/storage/thumbnail");

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

console.log("\n# Section 1: Official Fal.ai Ed25519 Webhook Verification");
{
  const { publicKeyJwk, keyObject, privateKeyObject } = generateFalTestKeypair();

  ok(publicKeyJwk.kty === "OKP", "JWK has kty = OKP");
  ok(publicKeyJwk.crv === "Ed25519", "JWK has crv = Ed25519");
  ok(typeof publicKeyJwk.x === "string" && publicKeyJwk.x.length > 0, "JWK has base64url public key coordinate x");

  // Convert JWK to KeyObject
  const importedKey = convertJwkToEd25519KeyObject(publicKeyJwk);
  ok(importedKey.asymmetricKeyType === "ed25519", "convertJwkToEd25519KeyObject creates valid Ed25519 KeyObject");

  // Valid Signature Verification
  const nowSec = Math.floor(Date.now() / 1000);
  const sampleBody = JSON.stringify({
    request_id: "req_test_001",
    status: "OK",
    payload: { video: { url: "https://v3.fal.media/output.mp4" } },
  });

  const { signatureHex, timestampStr } = signFalWebhookPayload({
    privateKey: privateKeyObject,
    requestId: "req_test_001",
    userId: "user_fal_123",
    timestampSeconds: nowSec,
    rawBody: sampleBody,
  });

  const validHeaders = {
    "x-fal-webhook-request-id": "req_test_001",
    "x-fal-webhook-user-id": "user_fal_123",
    "x-fal-webhook-timestamp": timestampStr,
    "x-fal-webhook-signature": signatureHex,
  };

  const validResult = await verifyFalWebhookSignature({
    rawBody: sampleBody,
    headers: validHeaders,
    keys: [publicKeyJwk],
  });

  ok(validResult.valid, "verifyFalWebhookSignature verifies authentic Ed25519 signature");
  ok(validResult.requestId === "req_test_001", "returns extracted requestId");
  ok(validResult.userId === "user_fal_123", "returns extracted userId");

  // Tampered Body Detection
  const tamperedBody = sampleBody + " ";
  const tamperedResult = await verifyFalWebhookSignature({
    rawBody: tamperedBody,
    headers: validHeaders,
    keys: [publicKeyJwk],
  });
  ok(!tamperedResult.valid, "rejects tampered request body");
  ok(Boolean(tamperedResult.error?.includes("verification failed")), "identifies cryptographic failure on tampered body");

  // Tampered Signature Detection
  const badSigHeaders = {
    ...validHeaders,
    "x-fal-webhook-signature": "00" + signatureHex.slice(2),
  };
  const badSigResult = await verifyFalWebhookSignature({
    rawBody: sampleBody,
    headers: badSigHeaders,
    keys: [publicKeyJwk],
  });
  ok(!badSigResult.valid, "rejects altered signature hex");

  // Missing Headers Detection
  const missingHeadersResult = await verifyFalWebhookSignature({
    rawBody: sampleBody,
    headers: { "x-fal-webhook-signature": signatureHex },
    keys: [publicKeyJwk],
  });
  ok(!missingHeadersResult.valid, "rejects request missing X-Fal-Webhook-Request-Id header");

  // Replay Attack Protection: Expired Timestamp (> 300s old)
  const expiredTimestampSec = nowSec - 305;
  const expiredSig = signFalWebhookPayload({
    privateKey: privateKeyObject,
    requestId: "req_test_expired",
    userId: "user_fal_123",
    timestampSeconds: expiredTimestampSec,
    rawBody: sampleBody,
  });

  const expiredHeaders = {
    "x-fal-webhook-request-id": "req_test_expired",
    "x-fal-webhook-user-id": "user_fal_123",
    "x-fal-webhook-timestamp": expiredSig.timestampStr,
    "x-fal-webhook-signature": expiredSig.signatureHex,
  };

  const expiredResult = await verifyFalWebhookSignature({
    rawBody: sampleBody,
    headers: expiredHeaders,
    keys: [publicKeyJwk],
  });
  ok(!expiredResult.valid, "rejects expired timestamp older than 300 seconds");
  ok(Boolean(expiredResult.error?.includes("timestamp expired")), "error explicitly cites expired timestamp");

  // Future Timestamp Protection (Clock Skew > 60s)
  const futureTimestampSec = nowSec + 120;
  const futureSig = signFalWebhookPayload({
    privateKey: privateKeyObject,
    requestId: "req_test_future",
    userId: "user_fal_123",
    timestampSeconds: futureTimestampSec,
    rawBody: sampleBody,
  });

  const futureHeaders = {
    "x-fal-webhook-request-id": "req_test_future",
    "x-fal-webhook-user-id": "user_fal_123",
    "x-fal-webhook-timestamp": futureSig.timestampStr,
    "x-fal-webhook-signature": futureSig.signatureHex,
  };

  const futureResult = await verifyFalWebhookSignature({
    rawBody: sampleBody,
    headers: futureHeaders,
    keys: [publicKeyJwk],
  });
  ok(!futureResult.valid, "rejects future timestamp beyond allowable clock skew");
}

console.log("\n# Section 2: FalVideoProvider Submission & Status Polling");
{
  // 1. Missing FAL_KEY configuration
  let threw = false;
  try {
    getFalVideoProvider({ apiKey: "" });
  } catch (e) {
    threw = (e as InstanceType<typeof VideoProviderError>).code === "CONFIG";
  }
  ok(threw, "getFalVideoProvider throws VideoProviderError(CONFIG) when FAL_KEY is missing");

  // 2. Successful Submit Mock
  let capturedSubmitUrl = "";
  let capturedAuthHeader = "";
  let capturedSubmitBody: any = null;

  const mockSubmitFetch = (async (url: any, opts: any) => {
    capturedSubmitUrl = String(url);
    capturedAuthHeader = opts.headers["Authorization"];
    capturedSubmitBody = JSON.parse(opts.body);

    return new Response(
      JSON.stringify({
        status: "IN_QUEUE",
        request_id: "fal-req-uuid-12345",
        queue_position: 2,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const provider = new FalVideoProvider({
    apiKey: "fal_secret_token_abc",
    model: DEFAULT_VIDEO_MODEL,
    webhookUrl: "https://pixora.test/api/webhooks/video/fal",
    fetchImpl: mockSubmitFetch,
  });

  const submitRes = await provider.submit({
    prompt: "Cinematic drone shot of snowy mountain peak at sunrise",
    settings: {
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      fps: 16,
    },
  });

  ok(submitRes.provider === "fal-ai", "submit returns provider = fal-ai");
  ok(submitRes.providerJobId === "fal-req-uuid-12345", "submit returns providerJobId from request_id");
  ok(submitRes.status === "PENDING", "submit status is PENDING");
  ok(submitRes.queuePosition === 2, "submit reports queue position 2");
  ok(capturedSubmitUrl.includes("fal_webhook="), "submit appends fal_webhook query parameter");
  ok(capturedAuthHeader === "Key fal_secret_token_abc", "submit sets Authorization: Key $FAL_KEY");
  ok(capturedSubmitBody.prompt.includes("snowy mountain"), "submit passes trimmed prompt");
  ok(capturedSubmitBody.aspect_ratio === "16:9", "submit passes aspect_ratio = 16:9");
  ok(capturedSubmitBody.num_frames === 81, "submit passes Wan 2.1 num_frames = 81 (~5s @ 16fps)");
  ok(capturedSubmitBody.frames_per_second === 16, "submit passes Wan 2.1 frames_per_second = 16");
  ok(capturedSubmitBody.resolution === "720p", "submit passes Wan 2.1 resolution = 720p");
  ok(capturedSubmitBody.enable_safety_checker === true, "submit enables safety checker");

  // Webhook jobId correlation embedding
  await provider.submit({
    prompt: "test prompt",
    jobId: "vjob-embed-999",
    correlationToken: "test-correlation-token-xyz.abc.123",
  });
  ok(decodeURIComponent(capturedSubmitUrl).includes("jobId=vjob-embed-999"), "submit embeds jobId query param into fal_webhook parameter");
  ok(decodeURIComponent(capturedSubmitUrl).includes("token=test-correlation-token-xyz.abc.123"), "submit embeds correlation token query param into fal_webhook parameter");

  // Pre-transmission cancellation
  const preAbortedCtrl = new AbortController();
  preAbortedCtrl.abort();
  threw = false;
  try {
    await provider.submit({ prompt: "test prompt", signal: preAbortedCtrl.signal });
  } catch (e: any) {
    threw = e.code === "CANCELLED" && e.outcome === "not_run";
  }
  ok(threw, "submit with pre-aborted signal throws CANCELLED/not_run without network call");

  // 3. Error Normalization on Submit
  const errorScenarios: Array<{
    status: number;
    body: string;
    expectedCode: string;
    expectedOutcome: string;
  }> = [
    { status: 400, body: "Invalid parameters", expectedCode: "INVALID_REQUEST", expectedOutcome: "not_run" },
    { status: 401, body: "Unauthorized key", expectedCode: "AUTH", expectedOutcome: "not_run" },
    { status: 404, body: "Model not found", expectedCode: "MODEL_NOT_FOUND", expectedOutcome: "not_run" },
    { status: 422, body: "Prompt contains NSFW safety violation", expectedCode: "CONTENT_POLICY", expectedOutcome: "not_run" },
    { status: 429, body: "Rate limit reached", expectedCode: "RATE_LIMITED", expectedOutcome: "not_run" },
    { status: 503, body: "Fal service unavailable", expectedCode: "UPSTREAM", expectedOutcome: "unknown" },
  ];

  for (const sc of errorScenarios) {
    const errorFetch = (async () => {
      return new Response(sc.body, { status: sc.status });
    }) as typeof fetch;

    const errProvider = new FalVideoProvider({
      apiKey: "fal_key_test",
      fetchImpl: errorFetch,
    });

    threw = false;
    let caughtErr: any = null;
    try {
      await errProvider.submit({ prompt: "test prompt" });
    } catch (e: any) {
      threw = e.code === sc.expectedCode && e.outcome === sc.expectedOutcome;
      caughtErr = e;
    }
    ok(threw, `submit maps HTTP ${sc.status} to ${sc.expectedCode} (${sc.expectedOutcome})`);
    ok(!caughtErr.message.includes("fal_key_test"), "error message never exposes API key");
  }

  // 4. Ambiguous vs Definite Failure Outcomes on Submit
  // A. Definite failure BEFORE connection: ENOTFOUND (not_run) -> safe to refund immediately
  const dnsFailFetch = (async () => {
    const err: any = new Error("getaddrinfo ENOTFOUND queue.fal.run");
    err.code = "ENOTFOUND";
    throw err;
  }) as typeof fetch;

  const dnsProvider = new FalVideoProvider({ apiKey: "fal_key_test", fetchImpl: dnsFailFetch });
  threw = false;
  try {
    await dnsProvider.submit({ prompt: "test prompt" });
  } catch (e: any) {
    threw = e.code === "NETWORK" && e.outcome === "not_run";
  }
  ok(threw, "submit maps ENOTFOUND to NETWORK/not_run (definite rejection before connection, safe to refund immediately)");

  // B. Ambiguous network drop AFTER transmission: ECONNRESET (unknown) -> requires reconciliation
  const networkDropFetch = (async () => {
    const err: any = new Error("Connection reset by peer");
    err.code = "ECONNRESET";
    throw err;
  }) as typeof fetch;

  const dropProvider = new FalVideoProvider({ apiKey: "fal_key_test", fetchImpl: networkDropFetch });
  threw = false;
  try {
    await dropProvider.submit({ prompt: "test prompt" });
  } catch (e: any) {
    threw = e.code === "NETWORK" && e.outcome === "unknown";
  }
  ok(threw, "submit maps ECONNRESET to NETWORK/unknown (requires reconciliation, never refunded immediately)");

  // C. Ambiguous timeout waiting for upstream response: TIMEOUT (unknown)
  const timeoutFetch = (async () => {
    const err: any = new Error("The operation was aborted due to timeout");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;

  const timeoutProvider = new FalVideoProvider({ apiKey: "fal_key_test", fetchImpl: timeoutFetch });
  threw = false;
  try {
    await timeoutProvider.submit({ prompt: "test prompt" });
  } catch (e: any) {
    threw = e.code === "TIMEOUT" && e.outcome === "unknown";
  }
  ok(threw, "submit maps timeout to TIMEOUT/unknown (ambiguous acceptance)");

  // D. Ambiguous HTTP 200 with malformed JSON body: MALFORMED_RESPONSE (unknown)
  const malformedJsonFetch = (async () => {
    return new Response("Not valid json {{{", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const malformedProvider = new FalVideoProvider({ apiKey: "fal_key_test", fetchImpl: malformedJsonFetch });
  threw = false;
  try {
    await malformedProvider.submit({ prompt: "test prompt" });
  } catch (e: any) {
    threw = e.code === "MALFORMED_RESPONSE" && e.outcome === "unknown";
  }
  ok(threw, "submit maps HTTP 200 with invalid JSON to MALFORMED_RESPONSE/unknown (ambiguous acceptance)");

  // E. Ambiguous HTTP 200 with missing request_id: MALFORMED_RESPONSE (unknown)
  const missingReqIdFetch = (async () => {
    return new Response(JSON.stringify({ status: "IN_QUEUE" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const missingReqIdProvider = new FalVideoProvider({ apiKey: "fal_key_test", fetchImpl: missingReqIdFetch });
  threw = false;
  try {
    await missingReqIdProvider.submit({ prompt: "test prompt" });
  } catch (e: any) {
    threw = e.code === "MALFORMED_RESPONSE" && e.outcome === "unknown";
  }
  ok(threw, "submit maps HTTP 200 with missing request_id to MALFORMED_RESPONSE/unknown (ambiguous acceptance)");

  // 5. Status Polling Checks
  const statusMockFetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("/status")) {
      return new Response(
        JSON.stringify({
          status: "COMPLETED",
          response_url: "https://queue.fal.run/fal-ai/wan/requests/fal-req-uuid-12345/response",
        }),
        { status: 200 },
      );
    }
    if (u.includes("/response")) {
      return new Response(
        JSON.stringify({
          video: {
            url: "https://v3.fal.media/files/monkey/output.mp4",
            content_type: "video/mp4",
            file_size: 1048576,
          },
          thumbnail: {
            url: "https://v3.fal.media/files/monkey/thumb.webp",
          },
        }),
        { status: 200 },
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const pollProvider = new FalVideoProvider({ apiKey: "fal_key_test", fetchImpl: statusMockFetch });
  const statusResult = await pollProvider.checkStatus("fal-req-uuid-12345");
  ok(statusResult.status === "COMPLETED", "checkStatus resolves status = COMPLETED");
  ok(statusResult.metadata?.videoUrl === "https://v3.fal.media/files/monkey/output.mp4", "metadata contains output videoUrl");
  ok(statusResult.metadata?.thumbnailUrl === "https://v3.fal.media/files/monkey/thumb.webp", "metadata contains thumbnailUrl");
}

console.log("\n# Section 3: Durable Webhook Ingestion & Fast-ACK Route Handler");
{
  const { publicKeyJwk, privateKeyObject } = generateFalTestKeypair();

  // In-memory Database Simulator for ProviderWebhookEvent & GenerationJob
  class MockDatabase {
    public webhookEvents = new Map<string, any>();
    public jobs = new Map<string, any>();
    public assets = new Map<string, any>();
    public failDbWrites = false;

    constructor() {
      this.jobs.set("vjob-live-1", {
        id: "vjob-live-1",
        userId: "user_owner_001",
        provider: "fal-ai",
        providerJobId: "fal-event-req-001",
        status: "PROCESSING",
        estimatedCredits: 10,
        chargedCredits: 0,
        settings: { aspectRatio: "16:9" },
      });
    }

    providerWebhookEvent = {
      upsert: async ({ where, create, update }: any) => {
        if (this.failDbWrites) {
          throw new Error("Simulated database write timeout / connection failure");
        }
        if (this.webhookEvents.has(where.eventId)) {
          const existing = this.webhookEvents.get(where.eventId);
          Object.assign(existing, update);
          return existing;
        }
        const created = {
          id: `wev-${Date.now()}`,
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.webhookEvents.set(where.eventId, created);
        return created;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const ev of this.webhookEvents.values()) {
          if (ev.eventId === where.eventId && (!where.status || ev.status === where.status)) {
            Object.assign(ev, data);
            count++;
          }
        }
        return { count };
      },
    };

    generationJob = {
      findUnique: async ({ where }: any) => {
        return this.jobs.get(where.id) ?? null;
      },
      findFirst: async ({ where }: any) => {
        for (const j of this.jobs.values()) {
          if (j.provider === where.provider && j.providerJobId === where.providerJobId) {
            return j;
          }
        }
        return null;
      },
    };

    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        $queryRaw: async ([q]: TemplateStringsArray, ...args: any[]) => {
          const sql = q.toString();
          // Claim webhook event
          if (sql.includes('UPDATE "ProviderWebhookEvent"')) {
            const token = args[0];
            const leaseExpiresAt = args[1];
            const eventId = args[2];
            const ev = this.webhookEvents.get(eventId);
            if (ev && (ev.status === "PENDING" || ev.status === "FAILED") && ev.attempts < 5) {
              ev.status = "PROCESSING";
              ev.processingToken = token;
              ev.leaseExpiresAt = leaseExpiresAt;
              ev.attempts += 1;
              return [ev];
            }
            return [];
          }
          // Claim video ingestion lease
          if (sql.includes('UPDATE "GenerationJob" SET "ingestionToken" =')) {
            const token = args[0];
            const leaseExpiresAt = args[1];
            const jobId = args[2];
            const job = this.jobs.get(jobId);
            if (job && job.status === "PROCESSING" && (!job.ingestionToken || job.ingestionLeaseExpiresAt < new Date())) {
              job.ingestionToken = token;
              job.ingestionLeaseExpiresAt = leaseExpiresAt;
              return [{ id: job.id, userId: job.userId, ingestionToken: token, ingestionLeaseExpiresAt: leaseExpiresAt }];
            }
            return [];
          }
          // Complete video job
          if (sql.includes('UPDATE "GenerationJob" j SET "status" = \'COMPLETED\'')) {
            const jobId = args[0];
            const token = args[1];
            const job = this.jobs.get(jobId);
            if (job && job.status === "PROCESSING" && job.ingestionToken === token) {
              job.status = "COMPLETED";
              job.chargedCredits = job.estimatedCredits;
              job.ingestionToken = null;
              job.ingestionLeaseExpiresAt = null;
              return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
            }
            return [];
          }
          // Fail video job
          if (sql.includes('UPDATE "GenerationJob" SET "status" = \'FAILED\'')) {
            const jobId = args[0];
            const job = this.jobs.get(jobId);
            if (job && (job.status === "PENDING" || job.status === "PROCESSING")) {
              job.status = "FAILED";
              job.ingestionToken = null;
              job.ingestionLeaseExpiresAt = null;
              return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
            }
            return [];
          }
          // Record provider result
          if (sql.includes('UPDATE "GenerationJob" SET "settings" =')) {
            return [{ id: "1" }];
          }
          return [];
        },
        generatedAsset: {
          create: async ({ data }: any) => {
            this.assets.set(data.id, data);
            return { id: data.id };
          },
        },
        generationJob: {
          findUnique: async ({ where }: any) => this.jobs.get(where.id) ?? null,
        },
      };
      return fn(tx);
    }
  }

  // 1. Durable Event Persistence & Idempotent Deduplication
  const db = new MockDatabase();
  const eventPayload = {
    request_id: "fal-event-req-001",
    status: "OK",
    payload: {
      video: { url: "https://v3.fal.media/files/valid.mp4" },
    },
  };

  const persist1 = await persistVerifiedWebhookEvent({
    provider: "fal-ai",
    eventId: "fal-event-req-001",
    payload: eventPayload,
    db: db as any,
  });
  ok(persist1.persisted, "persistVerifiedWebhookEvent stores event durably");
  ok(db.webhookEvents.has("fal-event-req-001"), "event stored in database with eventId");
  ok(db.webhookEvents.get("fal-event-req-001").status === "PENDING", "initial event status is PENDING");

  // Duplicate Delivery: Returns existing event without error
  const persist2 = await persistVerifiedWebhookEvent({
    provider: "fal-ai",
    eventId: "fal-event-req-001",
    payload: eventPayload,
    db: db as any,
  });
  ok(persist2.persisted, "duplicate delivery succeeds idempotently");
  ok(db.webhookEvents.size === 1, "no duplicate row inserted in database");

  // 2. HTTP Route Handler: Fast-ACK on Verified Signature
  const nowSec = Math.floor(Date.now() / 1000);
  const routeBodyStr = JSON.stringify(eventPayload);
  const { signatureHex, timestampStr } = signFalWebhookPayload({
    privateKey: privateKeyObject,
    requestId: "fal-event-req-001",
    userId: "user_fal_123",
    timestampSeconds: nowSec,
    rawBody: routeBodyStr,
  });

  const createValidReq = () =>
    new Request("https://pixora.test/api/webhooks/video/fal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fal-webhook-request-id": "fal-event-req-001",
        "x-fal-webhook-user-id": "user_fal_123",
        "x-fal-webhook-timestamp": timestampStr,
        "x-fal-webhook-signature": signatureHex,
      },
      body: routeBodyStr,
    });

  // Inject keys into global/verification options for test
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [publicKeyJwk] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const routeRes = await webhookRouteHandler(createValidReq(), { db: db as any });
    ok(routeRes.status === 200, "route handler returns HTTP 200 Fast ACK");
    const routeJson = await routeRes.json();
    ok(routeJson.received === true, "Fast ACK confirms received: true");
    ok(routeJson.requestId === "fal-event-req-001", "Fast ACK returns requestId");

    // Invalid Signature: Rejection with HTTP 401 (before parsing or correlation)
    const invalidReq = new Request("https://pixora.test/api/webhooks/video/fal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fal-webhook-request-id": "fal-event-req-001",
        "x-fal-webhook-user-id": "user_fal_123",
        "x-fal-webhook-timestamp": timestampStr,
        "x-fal-webhook-signature": "00" + signatureHex.slice(2),
      },
      body: routeBodyStr,
    });

    const invalidRes = await webhookRouteHandler(invalidReq, { db: db as any });
    ok(invalidRes.status === 401, "route handler returns HTTP 401 on invalid signature before parsing");

    // Identity Mismatch: Header X-Fal-Webhook-Request-Id != body request_id -> Rejection with HTTP 400
    const mismatchBody = JSON.stringify({
      request_id: "fal-body-id-MISMATCHED",
      status: "OK",
      payload: { video: { url: "https://v3.fal.media/files/valid.mp4" } },
    });
    const mismatchSig = signFalWebhookPayload({
      privateKey: privateKeyObject,
      requestId: "fal-event-req-001", // Header has 001, body has MISMATCHED
      userId: "user_fal_123",
      timestampSeconds: nowSec,
      rawBody: mismatchBody,
    });

    const mismatchReq = new Request("https://pixora.test/api/webhooks/video/fal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fal-webhook-request-id": "fal-event-req-001",
        "x-fal-webhook-user-id": "user_fal_123",
        "x-fal-webhook-timestamp": mismatchSig.timestampStr,
        "x-fal-webhook-signature": mismatchSig.signatureHex,
      },
      body: mismatchBody,
    });

    const mismatchRes = await webhookRouteHandler(mismatchReq, { db: db as any });
    ok(mismatchRes.status === 400, "route handler strictly rejects header/body request_id mismatch with HTTP 400");
    const mismatchJson = await mismatchRes.json();
    ok(mismatchJson.error === "Identity mismatch", "identifies identity mismatch error code");

    // Malformed Payload: Missing body request_id -> Rejection with HTTP 400
    const missingIdBody = JSON.stringify({
      status: "OK",
      payload: { video: { url: "https://v3.fal.media/files/valid.mp4" } },
    });
    const missingIdSig = signFalWebhookPayload({
      privateKey: privateKeyObject,
      requestId: "fal-event-req-001",
      userId: "user_fal_123",
      timestampSeconds: nowSec,
      rawBody: missingIdBody,
    });

    const missingIdReq = new Request("https://pixora.test/api/webhooks/video/fal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fal-webhook-request-id": "fal-event-req-001",
        "x-fal-webhook-user-id": "user_fal_123",
        "x-fal-webhook-timestamp": missingIdSig.timestampStr,
        "x-fal-webhook-signature": missingIdSig.signatureHex,
      },
      body: missingIdBody,
    });

    const missingIdRes = await webhookRouteHandler(missingIdReq, { db: db as any });
    ok(missingIdRes.status === 400, "route handler rejects payload missing body request_id with HTTP 400");

    // Webhook URL Query Parameter: Persisting jobId for ambiguous submission recovery
    const queryJobPayload = {
      request_id: "fal-query-job-001",
      status: "OK",
      payload: { video: { url: "https://v3.fal.media/files/valid.mp4" } },
    };
    const queryJobBodyStr = JSON.stringify(queryJobPayload);
    const queryJobSig = signFalWebhookPayload({
      privateKey: privateKeyObject,
      requestId: "fal-query-job-001",
      userId: "user_fal_123",
      timestampSeconds: nowSec,
      rawBody: queryJobBodyStr,
    });

    // 3a. Negative Test: Missing correlation token when jobId is provided
    const missingTokenReq = new Request("https://pixora.test/api/webhooks/video/fal?jobId=vjob-correlated-123", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fal-webhook-request-id": "fal-query-job-001",
        "x-fal-webhook-user-id": "user_fal_123",
        "x-fal-webhook-timestamp": queryJobSig.timestampStr,
        "x-fal-webhook-signature": queryJobSig.signatureHex,
      },
      body: queryJobBodyStr,
    });
    const missingTokenRes = await webhookRouteHandler(missingTokenReq, { db: db as any });
    ok(missingTokenRes.status === 400, "route handler strictly rejects jobId with missing correlation token (HTTP 400)");
    const missingTokenJson = await missingTokenRes.json();
    ok(missingTokenJson.error === "Invalid correlation", "identifies invalid correlation error");

    // 3b. Negative Test: Invalid / malformed correlation token
    const malformedTokenReq = new Request("https://pixora.test/api/webhooks/video/fal?jobId=vjob-correlated-123&token=malformed-xyz-123", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fal-webhook-request-id": "fal-query-job-001",
        "x-fal-webhook-user-id": "user_fal_123",
        "x-fal-webhook-timestamp": queryJobSig.timestampStr,
        "x-fal-webhook-signature": queryJobSig.signatureHex,
      },
      body: queryJobBodyStr,
    });
    const malformedTokenRes = await webhookRouteHandler(malformedTokenReq, { db: db as any });
    ok(malformedTokenRes.status === 400, "route handler rejects malformed correlation token (HTTP 400)");

    // 3c. Negative Test: Token belonging to another job (substitution attack)
    const otherJobToken = generateWebhookCorrelationToken({
      jobId: "vjob-other-job-999",
      provider: "fal-ai",
      submissionAttempt: "attempt-001",
    });
    const substitutedJobReq = new Request(
      `https://pixora.test/api/webhooks/video/fal?jobId=vjob-correlated-123&token=${otherJobToken}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fal-webhook-request-id": "fal-query-job-001",
          "x-fal-webhook-user-id": "user_fal_123",
          "x-fal-webhook-timestamp": queryJobSig.timestampStr,
          "x-fal-webhook-signature": queryJobSig.signatureHex,
        },
        body: queryJobBodyStr,
      },
    );
    const substitutedJobRes = await webhookRouteHandler(substitutedJobReq, { db: db as any });
    ok(substitutedJobRes.status === 400, "route handler rejects correlation token generated for different job (HTTP 400)");

    // 3d. Negative Test: Token belonging to another provider
    const otherProviderToken = generateWebhookCorrelationToken({
      jobId: "vjob-correlated-123",
      provider: "runway-gen3",
      submissionAttempt: "attempt-001",
    });
    const substitutedProvReq = new Request(
      `https://pixora.test/api/webhooks/video/fal?jobId=vjob-correlated-123&token=${otherProviderToken}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fal-webhook-request-id": "fal-query-job-001",
          "x-fal-webhook-user-id": "user_fal_123",
          "x-fal-webhook-timestamp": queryJobSig.timestampStr,
          "x-fal-webhook-signature": queryJobSig.signatureHex,
        },
        body: queryJobBodyStr,
      },
    );
    const substitutedProvRes = await webhookRouteHandler(substitutedProvReq, { db: db as any });
    ok(substitutedProvRes.status === 400, "route handler rejects correlation token generated for different provider (HTTP 400)");

    // 3e. Negative Test: Valid Fal webhook signature with tampered job ID
    // Attacker holds an authentic Fal signature, but modifies the jobId query param
    const validTokenForJobA = generateWebhookCorrelationToken({
      jobId: "vjob-legit-job-aaa",
      provider: "fal-ai",
      submissionAttempt: "attempt-001",
    });
    const tamperedJobIdReq = new Request(
      `https://pixora.test/api/webhooks/video/fal?jobId=vjob-tampered-victim-bbb&token=${validTokenForJobA}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fal-webhook-request-id": "fal-query-job-001",
          "x-fal-webhook-user-id": "user_fal_123",
          "x-fal-webhook-timestamp": queryJobSig.timestampStr,
          "x-fal-webhook-signature": queryJobSig.signatureHex,
        },
        body: queryJobBodyStr,
      },
    );
    const tamperedJobIdRes = await webhookRouteHandler(tamperedJobIdReq, { db: db as any });
    ok(
      tamperedJobIdRes.status === 400,
      "valid Fal signature ALONE cannot authorize tampered jobId query parameter (HTTP 400)",
    );

    // 3f. Positive Test: Valid correlation token bound to jobId, provider, and submission attempt
    const validCorrelationToken = generateWebhookCorrelationToken({
      jobId: "vjob-correlated-123",
      provider: "fal-ai",
      submissionAttempt: "attempt-valid-001",
    });
    const validQueryJobReq = new Request(
      `https://pixora.test/api/webhooks/video/fal?jobId=vjob-correlated-123&token=${validCorrelationToken}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fal-webhook-request-id": "fal-query-job-001",
          "x-fal-webhook-user-id": "user_fal_123",
          "x-fal-webhook-timestamp": queryJobSig.timestampStr,
          "x-fal-webhook-signature": queryJobSig.signatureHex,
        },
        body: queryJobBodyStr,
      },
    );

    const validQueryJobRes = await webhookRouteHandler(validQueryJobReq, { db: db as any });
    ok(validQueryJobRes.status === 200, "route handler accepts webhook with valid jobId and bound correlation token");
    ok(db.webhookEvents.get("fal-query-job-001").jobId === "vjob-correlated-123", "persists correlated jobId in ProviderWebhookEvent");
    ok(db.webhookEvents.get("fal-query-job-001").payload._correlationToken === validCorrelationToken, "stores _correlationToken in event payload");

    // Database Write Failure: Return HTTP 500 so provider retries
    db.failDbWrites = true;
    const dbFailRes = await webhookRouteHandler(createValidReq(), { db: db as any });
    ok(dbFailRes.status === 500, "route handler returns HTTP 500 when database persistence fails");
    db.failDbWrites = false;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("\n# Section 4: Leased Event Processing, Lifecycle & Crash Recovery");
{
  class MockDbHarness {
    public webhookEvents = new Map<string, any>();
    public jobs = new Map<string, any>();
    public assets = new Map<string, any>();

    constructor() {
      this.jobs.set("vjob-success-1", {
        id: "vjob-success-1",
        userId: "user_valid_123",
        provider: "fal-ai",
        providerJobId: "event-ok-001",
        status: "PROCESSING",
        estimatedCredits: 10,
        chargedCredits: 0,
        settings: {},
      });

      this.jobs.set("vjob-fail-1", {
        id: "vjob-fail-1",
        userId: "user_valid_123",
        provider: "fal-ai",
        providerJobId: "event-err-001",
        status: "PROCESSING",
        estimatedCredits: 10,
        chargedCredits: 0,
        settings: {},
      });

      this.jobs.set("vjob-completed-1", {
        id: "vjob-completed-1",
        userId: "user_valid_123",
        provider: "fal-ai",
        providerJobId: "event-late-err-001",
        status: "COMPLETED",
        estimatedCredits: 10,
        chargedCredits: 10,
        settings: {},
      });

      this.jobs.set("vjob-multi-del-1", {
        id: "vjob-multi-del-1",
        userId: "user_valid_123",
        provider: "fal-ai",
        providerJobId: "fal-job-shared-001",
        status: "PROCESSING",
        estimatedCredits: 10,
        chargedCredits: 0,
        settings: {},
      });
    }

    providerWebhookEvent = {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const ev of this.webhookEvents.values()) {
          const matchEventId = !where.eventId || ev.eventId === where.eventId;
          const matchStatus = !where.status || ev.status === where.status;
          const matchToken = !where.processingToken || ev.processingToken === where.processingToken;
          const matchLease =
            !where.leaseExpiresAt?.lt ||
            (ev.leaseExpiresAt && ev.leaseExpiresAt < where.leaseExpiresAt.lt);
          const matchAttempts =
            !where.attempts?.lt || (typeof ev.attempts === "number" && ev.attempts < where.attempts.lt);
          if (matchEventId && matchStatus && matchToken && matchLease && matchAttempts) {
            Object.assign(ev, data);
            count++;
          }
        }
        return { count };
      },
      findUnique: async ({ where }: any) => {
        return this.webhookEvents.get(where.eventId) ?? null;
      },
      findMany: async ({ where, take }: any) => {
        const results: any[] = [];
        for (const ev of this.webhookEvents.values()) {
          if (where.provider && ev.provider !== where.provider) continue;
          if (where.attempts?.lt && ev.attempts >= where.attempts.lt) continue;
          if (where.OR) {
            const matchesOr = where.OR.some((cond: any) => {
              if (cond.status && ev.status !== cond.status) return false;
              if (cond.leaseExpiresAt?.lt && (!ev.leaseExpiresAt || ev.leaseExpiresAt >= cond.leaseExpiresAt.lt)) return false;
              return true;
            });
            if (!matchesOr) continue;
          }
          results.push(ev);
          if (take && results.length >= take) break;
        }
        return results;
      },
    };

    generationJob = {
      findUnique: async ({ where }: any) => {
        return this.jobs.get(where.id) ?? null;
      },
      findFirst: async ({ where }: any) => {
        for (const j of this.jobs.values()) {
          if (where.id && j.id !== where.id) continue;
          if (where.provider && j.provider !== where.provider) continue;
          if (where.providerJobId && j.providerJobId !== where.providerJobId) continue;
          return j;
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        const job = this.jobs.get(where.id);
        if (job) {
          Object.assign(job, data);
          return job;
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        const results: any[] = [];
        for (const j of this.jobs.values()) {
          if (where.type && j.type !== where.type) continue;
          if (where.status && typeof where.status === "string" && j.status !== where.status) continue;
          if (where.status?.in && !where.status.in.includes(j.status)) continue;
          if (where.startedAt?.lt && (!j.startedAt || new Date(j.startedAt).getTime() >= new Date(where.startedAt.lt).getTime())) continue;
          if (where.createdAt?.lt && (!j.createdAt || new Date(j.createdAt).getTime() >= new Date(where.createdAt.lt).getTime())) continue;
          results.push(j);
        }
        return results;
      },
    };

    async $queryRaw(strings: any, ...args: any[]): Promise<any> {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      // Ambiguous submission record
      if (sql.includes("submission") && sql.includes("ambiguous")) {
        const jobId = args[2] ?? args[1];
        const job = this.jobs.get(jobId);
        if (job && job.status === "PENDING") {
          job.status = "PROCESSING";
          job.startedAt = args[0] ?? new Date();
          job.settings = { ...job.settings, submission: { state: "ambiguous" } };
          return [{ id: job.id }];
        }
        return [];
      }
      // Record provider result
      if (sql.includes("jsonb_set") || sql.includes("providerResult")) {
        const jobId = args[1];
        const job = this.jobs.get(jobId);
        if (job && job.status === "PROCESSING") {
          try {
            job.settings = { ...job.settings, providerResult: JSON.parse(args[0]) };
          } catch {
            job.settings = { ...job.settings, providerResult: args[0] };
          }
          return [{ id: job.id }];
        }
        return [];
      }
      // Claim video ingestion lease
      if (sql.includes('"ingestionToken" =')) {
        const token = args[0];
        const jobId = args[2];
        const job = this.jobs.get(jobId);
        if (
          job &&
          job.status === "PROCESSING" &&
          (!job.ingestionToken || job.ingestionLeaseExpiresAt < new Date())
        ) {
          job.ingestionToken = token;
          job.ingestionLeaseExpiresAt = new Date(Date.now() + 300_000);
          return [
            {
              id: job.id,
              userId: job.userId,
              ingestionToken: token,
              ingestionLeaseExpiresAt: job.ingestionLeaseExpiresAt,
            },
          ];
        }
        return [];
      }
      return [];
    }

    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        $queryRaw: async (strings: any, ...args: any[]) => {
          const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
          // Claim webhook event
          if (sql.includes('UPDATE "ProviderWebhookEvent"')) {
            const token = args[0];
            const leaseExpiresAt = args[1];
            const eventId = args[2];
            const ev = this.webhookEvents.get(eventId);
            if (
              ev &&
              (ev.status === "PENDING" || ev.status === "FAILED") &&
              ev.attempts < 5 &&
              (!ev.leaseExpiresAt || ev.leaseExpiresAt < new Date())
            ) {
              ev.status = "PROCESSING";
              ev.processingToken = token;
              ev.leaseExpiresAt = leaseExpiresAt;
              ev.attempts += 1;
              return [ev];
            }
            return [];
          }
          // Complete video job (guarded ingestion or operator resolution)
          if (sql.includes('j."status" = \'COMPLETED\'') || sql.includes('"status" = \'COMPLETED\'')) {
            const jobId = args.find((a: any) => typeof a === "string" && this.jobs.has(a)) ?? args[0];
            const token = args[1];
            const job = this.jobs.get(jobId);
            if (job && job.status === "PROCESSING") {
              if (sql.includes('j."status" = \'COMPLETED\'') && job.ingestionToken !== token) {
                return [];
              }
              job.status = "COMPLETED";
              job.chargedCredits = job.estimatedCredits;
              job.ingestionToken = null;
              job.ingestionLeaseExpiresAt = null;
              return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
            }
            return [];
          }
          // Fail video job (timeout fail or operator resolution)
          if (sql.includes('SET "status" = \'FAILED\'')) {
            const jobId = args.find((a: any) => typeof a === "string" && this.jobs.has(a)) ?? args[1];
            const reason = typeof args[0] === "string" ? args[0] : "FAILED";
            const job = this.jobs.get(jobId);
            if (job && (job.status === "PENDING" || job.status === "PROCESSING")) {
              job.status = "FAILED";
              job.errorMessage = reason;
              job.ingestionToken = null;
              job.ingestionLeaseExpiresAt = null;
              return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
            }
            return [];
          }
          // Credit refund wallet update
          if (sql.includes('UPDATE "CreditWallet"')) {
            return [{ id: "wallet-1", balance: 100 }];
          }
          return [];
        },
        creditTransaction: {
          findUnique: async ({ where }: any) => {
            if (where.idempotencyKey?.includes(":refund")) {
              return null; // Not yet refunded
            }
            return { id: "ctx-1", userId: "user_valid_123", amount: -10 };
          },
          findFirst: async () => ({ id: "ctx-1", userId: "user_valid_123", amount: -10 }),
          create: async () => ({ id: "ctx-ref-1" }),
        },
        creditWallet: {
          update: async () => ({ balance: 100 }),
        },
        generatedAsset: {
          create: async ({ data }: any) => {
            this.assets.set(data.id, data);
            return { id: data.id };
          },
        },
        generationJob: {
          findUnique: async ({ where }: any) => this.jobs.get(where.id) ?? null,
        },
      };
      return fn(tx);
    }
  }

  class MockStorage {
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

  // 1. Success Event Processing & Ingestion
  const db = new MockDbHarness();
  const storage = new MockStorage();
  const thumbnailExtractor = new MockThumbnailExtractor();

  db.webhookEvents.set("event-ok-001", {
    id: "wev-1",
    provider: "fal-ai",
    eventId: "event-ok-001",
    status: "PENDING",
    attempts: 0,
    payload: {
      status: "OK",
      payload: {
        video: { url: MOCK_MP4_PLAYABLE_DATA_URI },
      },
    },
  });

  const procResult = await processVideoWebhookEvent({
    eventId: "event-ok-001",
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });

  ok(procResult.processed, "processVideoWebhookEvent successfully processes OK event");
  ok(procResult.jobId === "vjob-success-1", "job correlated with providerJobId");
  ok(db.jobs.get("vjob-success-1").status === "COMPLETED", "job status transitioned to COMPLETED");
  ok(db.jobs.get("vjob-success-1").chargedCredits === 10, "chargedCredits settled to 10");
  ok(db.webhookEvents.get("event-ok-001").status === "PROCESSED", "webhook event settled to PROCESSED");

  // 2. Failure Event Processing & Credit Refund
  db.webhookEvents.set("event-err-001", {
    id: "wev-2",
    provider: "fal-ai",
    eventId: "event-err-001",
    status: "PENDING",
    attempts: 0,
    payload: {
      status: "ERROR",
      error: "Safety policy triggered on prompt",
    },
  });

  const failResult = await processVideoWebhookEvent({
    eventId: "event-err-001",
    storage: storage as any,
    db: db as any,
  });

  ok(failResult.processed, "processVideoWebhookEvent processes ERROR event");
  ok(db.jobs.get("vjob-fail-1").status === "FAILED", "job status transitioned to FAILED");
  ok(db.webhookEvents.get("event-err-001").status === "PROCESSED", "failed webhook event settled to PROCESSED");

  // 3. Out-Of-Order Event: Late Failure Delivered for Already COMPLETED Job
  // Invariant: Completed job can NEVER be refunded!
  db.webhookEvents.set("event-late-err-001", {
    id: "wev-3",
    provider: "fal-ai",
    eventId: "event-late-err-001",
    status: "PENDING",
    attempts: 0,
    payload: {
      status: "ERROR",
      error: "Late network error",
    },
  });

  await processVideoWebhookEvent({
    eventId: "event-late-err-001",
    storage: storage as any,
    db: db as any,
  });

  ok(db.jobs.get("vjob-completed-1").status === "COMPLETED", "completed job remains COMPLETED despite late failure event");
  ok(db.jobs.get("vjob-completed-1").chargedCredits === 10, "completed job retains charged credits (no refund issued)");

  // 4. Duplicate Provider Job Deliveries With Different Event IDs:
  // Delivery A arrives, completes job. Delivery B arrives later with different event ID for same provider job.
  // Invariant: Exactly one asset created, zero double refunds/charges!
  db.webhookEvents.set("event-del-A", {
    id: "wev-del-A",
    provider: "fal-ai",
    eventId: "event-del-A",
    status: "PENDING",
    attempts: 0,
    payload: {
      request_id: "fal-job-shared-001",
      status: "OK",
      payload: { video: { url: MOCK_MP4_PLAYABLE_DATA_URI } },
    },
  });

  const resDelA = await processVideoWebhookEvent({
    eventId: "event-del-A",
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });
  ok(resDelA.processed, "Delivery A completes the job successfully");
  ok(db.jobs.get("vjob-multi-del-1").status === "COMPLETED", "job status transitioned to COMPLETED by Delivery A");
  const assetCountAfterA = db.assets.size;

  db.webhookEvents.set("event-del-B", {
    id: "wev-del-B",
    provider: "fal-ai",
    eventId: "event-del-B",
    status: "PENDING",
    attempts: 0,
    payload: {
      request_id: "fal-job-shared-001",
      status: "OK",
      payload: { video: { url: MOCK_MP4_PLAYABLE_DATA_URI } },
    },
  });

  const resDelB = await processVideoWebhookEvent({
    eventId: "event-del-B",
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });
  ok(resDelB.processed, "Delivery B acknowledges existing terminal job without error");
  ok(resDelB.reason === "JOB_ALREADY_TERMINAL", "identifies job is already terminal");
  ok(db.assets.size === assetCountAfterA, "zero duplicate assets created by Delivery B");
  ok(db.jobs.get("vjob-multi-del-1").chargedCredits === 10, "credits remain charged exactly once");

  // 5. Concurrency Guard: Second Worker Excluded from Already Claimed Event
  db.webhookEvents.set("event-concurrent-001", {
    id: "wev-4",
    provider: "fal-ai",
    eventId: "event-concurrent-001",
    status: "PROCESSING", // held by worker A
    processingToken: "wtoken-worker-A",
    leaseExpiresAt: new Date(Date.now() + 300_000),
    attempts: 1,
    payload: { status: "OK" },
  });

  const concurrentResult = await processVideoWebhookEvent({
    eventId: "event-concurrent-001",
    storage: storage as any,
    db: db as any,
  });
  ok(!concurrentResult.processed, "concurrent worker excluded from event currently held by another worker");
  ok(concurrentResult.reason === "ALREADY_CLAIMED_OR_SETTLED", "identifies active claim exclusion");

  // 6. Crash Recovery: Sweeping Expired Webhook Lease
  db.webhookEvents.set("event-crashed-001", {
    id: "wev-5",
    provider: "fal-ai",
    eventId: "event-crashed-001",
    status: "PROCESSING",
    processingToken: "wtoken-crashed-worker",
    leaseExpiresAt: new Date(Date.now() - 1000), // expired!
    attempts: 1,
    payload: { status: "OK" },
  });

  const sweepRes = await sweepStaleWebhookEvents(db as any);
  ok(sweepRes.recoveredCount === 1, "sweepStaleWebhookEvents recovers crashed worker's expired event");
  ok(db.webhookEvents.get("event-crashed-001").status === "PENDING", "crashed event reset to PENDING for retry");
}

console.log("\n# Section 5: Ambiguous Submissions, Bounded Backoff, Batch Workers & Cron");
{
  const db = new (class {
    public webhookEvents = new Map<string, any>();
    public jobs = new Map<string, any>();
    public assets = new Map<string, any>();
    public creditTransactions = new Map<string, any>();
    public walletBalance = 100;

    constructor() {
      this.jobs.set("vjob-ambiguous-001", {
        id: "vjob-ambiguous-001",
        userId: "user_ambiguous_123",
        type: "VIDEO",
        provider: "fal-ai",
        providerJobId: null, // Unknown because submission dropped before receiving response
        status: "PENDING",
        estimatedCredits: 10,
        chargedCredits: 0,
        settings: {},
      });

      this.jobs.set("vjob-stale-001", {
        id: "vjob-stale-001",
        userId: "user_ambiguous_123",
        type: "VIDEO",
        provider: "fal-ai",
        providerJobId: null,
        status: "PENDING",
        estimatedCredits: 10,
        chargedCredits: 0,
        settings: {},
      });
    }

    providerWebhookEvent = {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const ev of this.webhookEvents.values()) {
          const matchEventId = !where.eventId || ev.eventId === where.eventId;
          const matchStatus = !where.status || ev.status === where.status;
          const matchToken = !where.processingToken || ev.processingToken === where.processingToken;
          const matchLease =
            !where.leaseExpiresAt?.lt ||
            (ev.leaseExpiresAt && ev.leaseExpiresAt < where.leaseExpiresAt.lt);
          const matchAttempts =
            !where.attempts?.lt || (typeof ev.attempts === "number" && ev.attempts < where.attempts.lt);
          if (matchEventId && matchStatus && matchToken && matchLease && matchAttempts) {
            Object.assign(ev, data);
            count++;
          }
        }
        return { count };
      },
      findUnique: async ({ where }: any) => {
        return this.webhookEvents.get(where.eventId) ?? null;
      },
      findMany: async ({ where, take }: any) => {
        const results: any[] = [];
        for (const ev of this.webhookEvents.values()) {
          if (where.provider && ev.provider !== where.provider) continue;
          if (where.attempts?.lt && ev.attempts >= where.attempts.lt) continue;
          if (where.OR) {
            const matchesOr = where.OR.some((cond: any) => {
              if (cond.status && ev.status !== cond.status) return false;
              if (cond.leaseExpiresAt?.lt && (!ev.leaseExpiresAt || ev.leaseExpiresAt >= cond.leaseExpiresAt.lt)) return false;
              return true;
            });
            if (!matchesOr) continue;
          }
          results.push(ev);
          if (take && results.length >= take) break;
        }
        return results;
      },
    };

    generationJob = {
      findUnique: async ({ where }: any) => {
        return this.jobs.get(where.id) ?? null;
      },
      findFirst: async ({ where }: any) => {
        for (const j of this.jobs.values()) {
          if (where.id && j.id !== where.id) continue;
          if (where.provider && j.provider !== where.provider) continue;
          if (where.providerJobId && j.providerJobId !== where.providerJobId) continue;
          return j;
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        const job = this.jobs.get(where.id);
        if (job) {
          Object.assign(job, data);
          return job;
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        const results: any[] = [];
        for (const j of this.jobs.values()) {
          if (where.type && j.type !== where.type) continue;
          if (where.status && j.status !== where.status) continue;
          if (where.status?.in && !where.status.in.includes(j.status)) continue;
          if (where.startedAt?.lt && (!j.startedAt || j.startedAt >= where.startedAt.lt)) continue;
          results.push(j);
        }
        return results;
      },
    };

    async $queryRaw(strings: any, ...args: any[]): Promise<any> {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes("submission")) {
        let jobId = "vjob-ambiguous-001";
        for (const arg of args) {
          if (typeof arg === "string" && this.jobs.has(arg)) {
            jobId = arg;
            break;
          }
        }
        const job = this.jobs.get(jobId);
        if (job && job.status === "PENDING") {
          job.status = "PROCESSING";
          job.startedAt = args[0] instanceof Date ? args[0] : new Date();
          const patchArg = args.find((a: any) => typeof a === "string" && a.startsWith("{"));
          const submissionPatch = patchArg ? JSON.parse(patchArg) : {};
          job.settings = {
            ...job.settings,
            submission: { ...(job.settings?.submission ?? {}), ...submissionPatch },
          };
          return [{ id: job.id }];
        }
        return [];
      }
      if (sql.includes("jsonb_set") || sql.includes("providerResult")) {
        const jobId = args[1];
        const job = this.jobs.get(jobId);
        if (job) {
          job.settings = { ...job.settings, providerResult: args[0] };
          return [{ id: job.id }];
        }
        return [];
      }
      if (sql.includes('"ingestionToken" =')) {
        const token = args[0];
        const jobId = args[2];
        const job = this.jobs.get(jobId);
        if (job && job.status === "PROCESSING") {
          job.ingestionToken = token;
          job.ingestionLeaseExpiresAt = new Date(Date.now() + 300_000);
          return [{ id: job.id, userId: job.userId, ingestionToken: token, ingestionLeaseExpiresAt: job.ingestionLeaseExpiresAt }];
        }
        return [];
      }
      return [];
    }

    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        $queryRaw: async (strings: any, ...args: any[]) => {
          const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
          if (sql.includes('UPDATE "ProviderWebhookEvent"')) {
            const token = args[0];
            const leaseExpiresAt = args[1];
            const eventId = args[2];
            const ev = this.webhookEvents.get(eventId);
            if (ev && (ev.status === "PENDING" || ev.status === "FAILED") && ev.attempts < 5) {
              ev.status = "PROCESSING";
              ev.processingToken = token;
              ev.leaseExpiresAt = leaseExpiresAt;
              ev.attempts += 1;
              return [ev];
            }
            return [];
          }
          if (sql.includes('j."status" = \'COMPLETED\'') || sql.includes('"status" = \'COMPLETED\'')) {
            const jobId = args.find((a: any) => typeof a === "string" && this.jobs.has(a)) ?? args[0];
            const job = this.jobs.get(jobId);
            if (job && job.status === "PROCESSING") {
              job.status = "COMPLETED";
              job.chargedCredits = job.estimatedCredits;
              job.ingestionToken = null;
              job.ingestionLeaseExpiresAt = null;
              const settingsArg = args.find((a: any) => typeof a === "string" && a.startsWith("{"));
              if (settingsArg) {
                try {
                  job.settings = JSON.parse(settingsArg);
                } catch {}
              }
              return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
            }
            return [];
          }
          if (sql.includes('SET "status" = \'FAILED\'')) {
            const jobId = args.find((a: any) => typeof a === "string" && this.jobs.has(a)) ?? args[1];
            const job = this.jobs.get(jobId);
            if (job && (job.status === "PENDING" || job.status === "PROCESSING")) {
              job.status = "FAILED";
              job.errorMessage = typeof args[0] === "string" ? args[0] : "FAILED";
              job.ingestionToken = null;
              job.ingestionLeaseExpiresAt = null;
              const settingsArg = args.find((a: any) => typeof a === "string" && a.startsWith("{"));
              if (settingsArg) {
                try {
                  job.settings = JSON.parse(settingsArg);
                } catch {}
              }
              this.walletBalance += 10;
              return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
            }
            return [];
          }
          if (sql.includes('UPDATE "CreditWallet"')) {
            this.walletBalance += 10;
            return [{ id: "wallet-1", balance: this.walletBalance }];
          }
          return [];
        },
        creditTransaction: {
          findUnique: async ({ where }: any) => {
            if (where?.idempotencyKey?.startsWith("job-refund:")) return null;
            return { id: "ctx-1", userId: "user_ambiguous_123", amount: -10 };
          },
          create: async () => ({ id: "ctx-ref-1" }),
        },
        creditWallet: {
          update: async () => ({ balance: this.walletBalance }),
        },
        generatedAsset: {
          create: async ({ data }: any) => {
            this.assets.set(data.id, data);
            return { id: data.id };
          },
        },
        generationJob: {
          findUnique: async ({ where }: any) => this.jobs.get(where.id) ?? null,
        },
      };
      return fn(tx);
    }
  })();

  class TestStorage {
    public files = new Map<string, Buffer>();
    public deleted: string[] = [];
    async put(key: string, body: Buffer) { this.files.set(key, body); }
    async putStream(key: string, stream: any) {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      this.files.set(key, Buffer.concat(chunks));
      return { sizeBytes: this.files.get(key)!.length };
    }
    async createSignedUrl(key: string, exp: number) { return `https://signed.supabase.test/${key}`; }
    async delete(key: string) { this.deleted.push(key); this.files.delete(key); }
  }

  const storage = new TestStorage();
  const thumbnailExtractor = new MockThumbnailExtractor();

  // 1. Ambiguous Submission State Recording (No Premature Refund!)
  const submissionAttemptToken = "attempt-ambig-token-001";
  const validAmbiguousCorrelationToken = generateWebhookCorrelationToken({
    jobId: "vjob-ambiguous-001",
    provider: "fal-ai",
    submissionAttempt: submissionAttemptToken,
  });

  const recorded = await recordVideoJobSubmissionAmbiguous({
    jobId: "vjob-ambiguous-001",
    error: "Connection dropped during Fal.ai submission: ECONNRESET",
    token: submissionAttemptToken,
    correlationToken: validAmbiguousCorrelationToken,
  }, db as any);
  ok(recorded, "recordVideoJobSubmissionAmbiguous transitions job PENDING -> PROCESSING");
  const ambiguousJob = db.jobs.get("vjob-ambiguous-001");
  ok(ambiguousJob.status === "PROCESSING", "job remains in PROCESSING to await webhook");
  ok(ambiguousJob.settings.submission?.state === "ambiguous", "records submission state = ambiguous in settings");
  ok(ambiguousJob.settings.submission?.token === submissionAttemptToken, "stores submission attempt token in settings");
  ok(ambiguousJob.settings.submission?.correlationToken === validAmbiguousCorrelationToken, "stores correlation token in settings");
  ok(db.walletBalance === 100, "wallet balance NOT refunded prematurely on ambiguous submission");

  // 2a. Negative Test: Worker rejects event with correlation token belonging to another submission attempt
  const wrongAttemptToken = generateWebhookCorrelationToken({
    jobId: "vjob-ambiguous-001",
    provider: "fal-ai",
    submissionAttempt: "attempt-old-expired-999",
  });
  db.webhookEvents.set("event-ambig-wrong-attempt", {
    id: "wev-ambig-wrong-attempt",
    provider: "fal-ai",
    eventId: "event-ambig-wrong-attempt",
    jobId: "vjob-ambiguous-001",
    status: "PENDING",
    attempts: 0,
    payload: {
      request_id: "fal-wrong-attempt-req-001",
      status: "OK",
      payload: { video: { url: MOCK_MP4_PLAYABLE_DATA_URI } },
      _correlationToken: wrongAttemptToken,
    },
  });

  const wrongAttemptRes = await processVideoWebhookEvent({
    eventId: "event-ambig-wrong-attempt",
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });
  ok(!wrongAttemptRes.processed, "worker rejects correlation token belonging to another submission attempt");
  ok(ambiguousJob.status === "PROCESSING", "job status NOT modified by mismatched attempt token");
  ok(ambiguousJob.providerJobId === null, "providerJobId NOT backfilled by mismatched attempt token");

  // 2b. Negative Test: Worker rejects event with correlation token belonging to another job
  const wrongJobToken = generateWebhookCorrelationToken({
    jobId: "vjob-unrelated-other-job",
    provider: "fal-ai",
    submissionAttempt: submissionAttemptToken,
  });
  db.webhookEvents.set("event-ambig-wrong-job", {
    id: "wev-ambig-wrong-job",
    provider: "fal-ai",
    eventId: "event-ambig-wrong-job",
    jobId: "vjob-ambiguous-001",
    status: "PENDING",
    attempts: 0,
    payload: {
      request_id: "fal-wrong-job-req-001",
      status: "OK",
      payload: { video: { url: MOCK_MP4_PLAYABLE_DATA_URI } },
      _correlationToken: wrongJobToken,
    },
  });

  const wrongJobRes = await processVideoWebhookEvent({
    eventId: "event-ambig-wrong-job",
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });
  ok(!wrongJobRes.processed, "worker rejects correlation token belonging to another job");
  ok(ambiguousJob.status === "PROCESSING", "job status remains PROCESSING");
  ok(ambiguousJob.providerJobId === null, "providerJobId NOT backfilled");

  // Clean up transient negative test events from memory map
  db.webhookEvents.delete("event-ambig-wrong-attempt");
  db.webhookEvents.delete("event-ambig-wrong-job");

  // 2c. Positive Test: Recovery of Ambiguous Submission with valid matching correlation token
  db.webhookEvents.set("event-ambig-recover", {
    id: "wev-ambig-1",
    provider: "fal-ai",
    eventId: "event-ambig-recover",
    jobId: "vjob-ambiguous-001",
    status: "PENDING",
    attempts: 0,
    payload: {
      request_id: "fal-late-generated-req-001",
      status: "OK",
      payload: { video: { url: MOCK_MP4_PLAYABLE_DATA_URI } },
      _correlationToken: validAmbiguousCorrelationToken,
    },
  });

  const recoverRes = await processVideoWebhookEvent({
    eventId: "event-ambig-recover",
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });

  ok(recoverRes.processed, "webhook recovers ambiguous submission using event.jobId with valid correlation token");
  ok(ambiguousJob.status === "COMPLETED", "ambiguous job transitioned to COMPLETED");
  ok(ambiguousJob.providerJobId === "fal-late-generated-req-001", "providerJobId backfilled from webhook payload");
  ok(ambiguousJob.chargedCredits === 10, "credits settled to 10 on successful recovery");

  // 2d. Negative Test: Replay of an already processed webhook
  // When provider retries or re-delivers the same event on an already COMPLETED job
  db.webhookEvents.set("event-ambig-replay", {
    id: "wev-ambig-replay",
    provider: "fal-ai",
    eventId: "event-ambig-replay",
    jobId: "vjob-ambiguous-001",
    status: "PENDING",
    attempts: 0,
    payload: {
      request_id: "fal-late-generated-req-001",
      status: "OK",
      payload: { video: { url: MOCK_MP4_PLAYABLE_DATA_URI } },
      _correlationToken: validAmbiguousCorrelationToken,
    },
  });

  const replayRes = await processVideoWebhookEvent({
    eventId: "event-ambig-replay",
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });
  ok(replayRes.processed, "replayed webhook recognized as terminal job without failure");
  ok((replayRes as any).reason === "JOB_ALREADY_TERMINAL", "reports JOB_ALREADY_TERMINAL reason code");
  ok(ambiguousJob.chargedCredits === 10, "credit charge NOT duplicated on replayed webhook");
  ok(db.walletBalance === 100, "wallet balance NOT modified on replayed webhook");

  // 3. Stale Ambiguous Job Sweep: Unanswered ambiguous job enters unresolved state (NEVER auto-refunded!)
  const staleJob = db.jobs.get("vjob-stale-001");
  await recordVideoJobSubmissionAmbiguous({
    jobId: "vjob-stale-001",
    error: "Timeout waiting for Fal.ai response",
    now: new Date(Date.now() - 16 * 60 * 1000), // 16 minutes ago (exceeds 15m threshold)
  }, db as any);

  ok(staleJob.status === "PROCESSING", "stale job was placed in PROCESSING");
  const staleSweepRes = await reconcileStaleVideoJobs({}, db as any);
  ok(staleSweepRes.unresolved >= 1, "reconcileStaleVideoJobs marks unanswered ambiguous job as unresolved");
  ok(staleSweepRes.settled === 0, "ambiguous job is NOT settled or refunded automatically");
  ok(staleJob.status === "PROCESSING", "unanswered ambiguous job remains in PROCESSING (debit preserved)");
  ok(staleJob.settings.submission?.unresolved === true, "job flagged as unresolved in settings");
  ok(staleJob.settings.submission?.reviewStatus === "pending_operator_review", "reviewStatus set to pending_operator_review");
  ok(db.walletBalance === 100, "user credit balance preserved (no premature refund)");

  // Duplicate reconciliation is strictly idempotent
  const dupeSweepRes = await reconcileStaleVideoJobs({}, db as any);
  ok(dupeSweepRes.settled === 0 && dupeSweepRes.unresolved === 0, "duplicate reconciliation is strictly idempotent");

  // Ordinary stale job (with confirmed providerJobId) DOES settle to FAILED and issue refund
  db.jobs.set("vjob-ord-stale-001", {
    id: "vjob-ord-stale-001",
    userId: "user-webhook-001",
    type: "VIDEO",
    status: "PROCESSING",
    provider: "fal-ai",
    providerJobId: "fal-confirmed-stale-req",
    startedAt: new Date(Date.now() - 16 * 60 * 1000),
    settings: { submission: { state: "submitted" } },
    estimatedCredits: 10,
    chargedCredits: 0,
  });
  const ordSweepRes = await reconcileStaleVideoJobs({}, db as any);
  ok(ordSweepRes.settled >= 1, "ordinary stale job with confirmed providerJobId settles to FAILED");
  const ordJob = db.jobs.get("vjob-ord-stale-001");
  ok(ordJob.status === "FAILED", "ordinary stale job transitioned to FAILED");

  // 3b. Operator Resolution: Confirmed Provider Non-Execution (Refund)
  const opAttemptToken = "attempt-op-fail-001";
  const opCorrelationToken = generateWebhookCorrelationToken({
    jobId: "vjob-operator-fail-001",
    provider: "fal-ai",
    submissionAttempt: opAttemptToken,
  });

  db.jobs.set("vjob-operator-fail-001", {
    id: "vjob-operator-fail-001",
    userId: "user-webhook-001",
    type: "VIDEO",
    status: "PROCESSING",
    provider: "fal-ai",
    startedAt: new Date(Date.now() - 20 * 60 * 1000),
    settings: {
      submission: {
        state: "ambiguous",
        unresolved: true,
        reviewStatus: "pending_operator_review",
        token: opAttemptToken,
        correlationToken: opCorrelationToken,
      },
    },
    estimatedCredits: 10,
    chargedCredits: 0,
  });
  const opFailRes = await resolveAmbiguousJobAsFailed(
    {
      jobId: "vjob-operator-fail-001",
      operatorId: "op-admin-001",
      reason: "Confirmed provider non-execution via Fal.ai operational logs",
    },
    db as any,
  );
  ok(opFailRes.settled === true, "operator resolution settles job as FAILED");
  const opFailedJob = db.jobs.get("vjob-operator-fail-001");
  ok(opFailedJob.status === "FAILED", "job transitioned to FAILED by operator");
  ok(opFailedJob.settings.resolution?.resolvedBy === "operator", "recorded audit trail: resolvedBy = operator");
  ok(opFailedJob.settings.resolution?.action === "refund", "recorded audit trail: action = refund");

  // Invariant: Prevention of late completion after job was refunded
  db.webhookEvents.set("event-late-after-refund", {
    id: "wev-late-after-refund",
    provider: "fal-ai",
    eventId: "event-late-after-refund",
    jobId: "vjob-operator-fail-001",
    status: "PENDING",
    attempts: 0,
    payload: {
      request_id: "fal-rogue-late-req-001",
      status: "OK",
      payload: { video: { url: MOCK_MP4_PLAYABLE_DATA_URI } },
      _correlationToken: opCorrelationToken,
    },
  });
  const lateAfterRefundRes = await processVideoWebhookEvent({
    eventId: "event-late-after-refund",
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });
  ok(lateAfterRefundRes.processed === true, "late webhook acknowledged");
  ok(lateAfterRefundRes.reason === "JOB_ALREADY_TERMINAL", "late webhook recognizes job was already terminal/refunded");
  ok(opFailedJob.status === "FAILED", "refunded job remains FAILED (never completed post-refund)");

  // 3c. Operator Resolution: Confirmed Provider Completion (Success)
  db.jobs.set("vjob-operator-complete-001", {
    id: "vjob-operator-complete-001",
    userId: "user-webhook-001",
    type: "VIDEO",
    status: "PROCESSING",
    provider: "fal-ai",
    startedAt: new Date(Date.now() - 20 * 60 * 1000),
    settings: {
      submission: { state: "ambiguous", unresolved: true, reviewStatus: "pending_operator_review" },
    },
    estimatedCredits: 10,
    chargedCredits: 0,
  });
  const opCompRes = await resolveAmbiguousJobAsCompleted(
    {
      jobId: "vjob-operator-complete-001",
      operatorId: "op-admin-002",
      reason: "Confirmed provider completion via Fal.ai support CDN record",
      asset: {
        userId: "user-webhook-001",
        assetId: "asset-op-001",
        storageKey: "users/user-webhook-001/videos/vjob-operator-complete-001/asset-op-001.mp4",
        thumbnailKey: null,
        mimeType: "video/mp4",
        width: 1280,
        height: 720,
        durationSeconds: 5,
        sizeBytes: 1024,
      },
    },
    db as any,
  );
  ok(opCompRes.settled === true, "operator resolution settles job as COMPLETED");
  const opCompJob = db.jobs.get("vjob-operator-complete-001");
  ok(opCompJob.status === "COMPLETED", "job transitioned to COMPLETED by operator");
  ok(opCompJob.chargedCredits === 10, "credits finalized to 10 (no refund)");
  ok(opCompJob.settings.resolution?.resolvedBy === "operator", "audit trail records operator resolution");
  ok(opCompJob.settings.resolution?.action === "complete", "audit trail records action = complete");

  // 3d. Scheduled Ingestion Recovery: Ingestion completes without ANY GET polling request
  db.jobs.set("vjob-ingest-no-get-001", {
    id: "vjob-ingest-no-get-001",
    userId: "user-webhook-001",
    type: "VIDEO",
    status: "PROCESSING",
    provider: "fal-ai",
    startedAt: new Date(Date.now() - 30_000),
    settings: {
      providerResult: {
        payload: {
          video: { url: MOCK_MP4_PLAYABLE_DATA_URI },
        },
      },
    },
    estimatedCredits: 10,
    chargedCredits: 0,
    ingestionToken: null,
    ingestionLeaseExpiresAt: null,
  });
  // Execute scheduled ingestion worker directly (no client GET poll was ever performed!)
  const schedIngestRes = await processPendingIngestionJobs({
    limit: 10,
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });
  ok(schedIngestRes.ingested >= 1, "scheduled recovery worker ingests pending video without any GET request");
  const noGetJob = db.jobs.get("vjob-ingest-no-get-001");
  ok(noGetJob.status === "COMPLETED", "job progresses to COMPLETED independently");
  ok(noGetJob.chargedCredits === 10, "chargedCredits finalized on independent ingestion");

  // 4. Bounded Exponential Backoff on FAILED Events
  ok(getWebhookRetryBackoffMs(0) === 0, "backoff for attempt 0 is 0ms");
  ok(getWebhookRetryBackoffMs(1) === 15_000, "attempt 1 backoff is 15 seconds");
  ok(getWebhookRetryBackoffMs(2) === 30_000, "attempt 2 backoff is 30 seconds");
  ok(getWebhookRetryBackoffMs(3) === 60_000, "attempt 3 backoff is 60 seconds");
  ok(getWebhookRetryBackoffMs(4) === 120_000, "attempt 4 backoff is 120 seconds");
  ok(getWebhookRetryBackoffMs(5) === 240_000, "attempt 5 backoff is 240 seconds");
  ok(getWebhookRetryBackoffMs(10) === 300_000, "backoff is capped at 5 minutes (300,000ms)");

  // 5. Settling FAILED Event Enforces Backoff Delay
  db.webhookEvents.set("event-fail-backoff", {
    id: "wev-fail-1",
    provider: "fal-ai",
    eventId: "event-fail-backoff",
    status: "PROCESSING",
    processingToken: "tok-fail-1",
    attempts: 1,
  });

  await settleWebhookEvent({
    eventId: "event-fail-backoff",
    processingToken: "tok-fail-1",
    status: "FAILED",
    error: "Simulated transient network timeout during ingestion",
    db: db as any,
  });

  const failedEv = db.webhookEvents.get("event-fail-backoff");
  ok(failedEv.status === "FAILED", "event settled to FAILED");
  ok(failedEv.processingToken === null, "processingToken cleared on FAILED");
  ok(failedEv.leaseExpiresAt !== null, "leaseExpiresAt set to backoff timestamp");
  ok(failedEv.leaseExpiresAt.getTime() > Date.now(), "leaseExpiresAt is in the future enforcing backoff delay");

  // 6. Exhausted Event Stays Observable After 5 Attempts
  failedEv.attempts = 5;
  const exhaustedClaim = await claimWebhookEvent("event-fail-backoff", 300_000, db as any);
  ok(!exhaustedClaim.acquired, "claimWebhookEvent strictly rejects event exhausted after 5 attempts");
  ok(failedEv.status === "FAILED", "exhausted event remains observable in FAILED status");

  // 7. Manual Operator Replay: resetExhaustedWebhookEvent
  const resetSuccess = await resetExhaustedWebhookEvent("event-fail-backoff", db as any);
  ok(resetSuccess, "resetExhaustedWebhookEvent successfully resets event");
  ok(failedEv.status === "PENDING", "event status reset to PENDING for replay");
  ok(failedEv.attempts === 0, "attempts reset to 0");
  ok(failedEv.leaseExpiresAt === null, "leaseExpiresAt cleared");

  // 8. Batch Worker Execution (processPendingWebhookBatch)
  db.webhookEvents.set("batch-event-1", {
    id: "wev-batch-1",
    provider: "fal-ai",
    eventId: "batch-event-1",
    jobId: "vjob-batch-job-1",
    status: "PENDING",
    attempts: 0,
    payload: {
      request_id: "batch-event-1",
      status: "OK",
      payload: { video: { url: MOCK_MP4_PLAYABLE_DATA_URI } },
    },
  });

  db.jobs.set("vjob-batch-job-1", {
    id: "vjob-batch-job-1",
    userId: "user_ambiguous_123",
    provider: "fal-ai",
    providerJobId: "batch-event-1",
    status: "PROCESSING",
    estimatedCredits: 10,
    chargedCredits: 0,
    settings: {},
  });

  const batchRes = await processPendingWebhookBatch({
    limit: 5,
    storage: storage as any,
    thumbnailExtractor,
    db: db as any,
  });

  ok(batchRes.inspected >= 1, "processPendingWebhookBatch inspects eligible pending events");
  ok(batchRes.processed >= 1, "processPendingWebhookBatch processes eligible events");

  // 9. Cron Reconciliation Route Handler (/api/cron/video-webhooks)
  const cronReq = new Request("https://pixora.test/api/cron/video-webhooks", {
    method: "GET",
  });
  const cronRes = await cronRouteHandler(cronReq, { db: db as any, storage: storage as any });
  ok(cronRes.status === 200, "cron reconciliation route handler returns HTTP 200");
  const cronJson = await cronRes.json();
  ok(cronJson.ok === true, "cron returns ok: true");
  ok(typeof cronJson.sweptExpiredLeases === "number", "reports swept expired leases");
  ok(typeof cronJson.batch?.processed === "number", "reports batch processed count");
  ok(typeof cronJson.staleJobsSettled === "number", "reports stale jobs settled count");
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
