// Stage 8, Batch 4: Video Generation APIs & Client Synchronization Layer
//
// Fully offline: NO real Fal.ai API calls, NO real Supabase calls, ₹0 spend.
// Tests:
//   1. Authentication, CSRF & Rate Limiting Guardrails
//   2. Request Input Validation & Entitlement Security
//   3. Accounting, Idempotency & Active Concurrency Guardrails
//   4. Asynchronous Submission, HTTP 202 & Ambiguous Provider Outcomes
//   5. Durable Submission Intent & Crash Recovery (No Blind Re-submissions)
//   6. Lightweight Polling, Ingestion Signaling & Signed URL Security
//   7. Client Controller State Machine, Polling Jitter/Backoff & Offline Recovery
//
// Run: npm run test:video-api

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

// Clear ambient environment keys to prevent accidental leaks
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
  DEFAULT_VIDEO_CREDIT_COST,
  DEFAULT_DAILY_USER_VIDEO_LIMIT,
  VIDEO_POLL_INTERVAL_MS,
} = await import("@/features/video/config");

const {
  createVideoGenerationHandlers,
} = await import("@/features/video/http");

const {
  claimVideoSubmissionLease,
  dispatchVideoSubmission,
  reconcileStaleSubmissionIntent,
  recordVideoSubmissionSucceeded,
  SUBMISSION_LEASE_DURATION_MS,
} = await import("@/features/video/durable-submission");

const {
  toVideoJobView,
  videoJobResponseStatus,
  VIDEO_POLL_AFTER_SECONDS,
} = await import("@/features/video/job-view");

const {
  getVideoJobForUser,
  getActiveVideoJob,
} = await import("@/features/video/queries");

const {
  VideoGenerationController,
} = await import("@/features/video/client/controller");

const {
  calculatePollDelay,
  decideNextVideoPoll,
  isTerminalJobStatus,
  VIDEO_POLLING,
} = await import("@/features/video/client/polling");

const {
  postVideoGeneration,
  getVideoJob,
} = await import("@/features/video/client/api");

const { VideoProviderError } = await import("@/features/video/types");
const { MOCK_MP4_PLAYABLE_DATA_URI } = await import("@/features/video/providers/fixture");

const {
  reconcileStaleVideoJobs,
  resolveAmbiguousJobAsFailed,
  resolveAmbiguousJobAsCompleted,
} = await import("@/features/video/lifecycle");

const {
  processPendingIngestionJobs,
} = await import("@/features/video/storage/ingestion");

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

// ---------------------------------------------------------------------------
// Mock Storage Adapter
// ---------------------------------------------------------------------------
class MockStorage {
  public files = new Map<string, Buffer>();
  public deleted: string[] = [];

  async put(key: string, body: Buffer): Promise<void> {
    this.files.set(key, body);
  }

  async putStream(key: string, stream: any): Promise<{ sizeBytes: number }> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    this.files.set(key, buf);
    return { sizeBytes: buf.length };
  }

  async createSignedUrl(key: string, exp: number): Promise<string> {
    return `https://signed.supabase.test/${key}?exp=${exp}`;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.files.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Mock Provider Adapter
// ---------------------------------------------------------------------------
class MockProvider {
  public id = "fal-ai";
  public model = "fal-ai/wan/v2.1/t2v-720p";
  public mode: "success" | "fail:not_run" | "fail:unknown" = "success";
  public submitCalls: any[] = [];

  async submit(req: any): Promise<any> {
    this.submitCalls.push(req);

    if (this.mode === "fail:not_run") {
      throw new VideoProviderError({
        code: "INVALID_REQUEST",
        outcome: "not_run",
        message: "Prompt failed provider content safety checks",
        httpStatus: 422,
      });
    }
    if (this.mode === "fail:unknown") {
      throw new VideoProviderError({
        code: "NETWORK",
        outcome: "unknown",
        message: "Connection reset during Fal.ai queue submission (ECONNRESET)",
        httpStatus: 500,
      });
    }

    return {
      provider: this.id,
      model: this.model,
      providerJobId: `fal-req-${this.submitCalls.length}`,
      status: "PENDING",
      queuePosition: 1,
    };
  }

  async checkStatus(jobId: string): Promise<any> {
    return { status: "PROCESSING" };
  }

  async cancel(jobId: string): Promise<any> {
    return { cancelled: true, status: "CANCELLED" };
  }
}

// ---------------------------------------------------------------------------
// Mock Transactional Database Harness
// ---------------------------------------------------------------------------
class GlobalMockDb {
  public jobs = new Map<string, any>();
  public walletBalance = 100;
  public dailyCount = 0;

  user = {
    findUnique: async ({ where }: any) => {
      const id = where?.id ?? "user-1";
      return { id, email: "qa@pixora.test", emailVerified: new Date() };
    },
  };

  creditWallet = {
    findUnique: async () => ({ balance: this.walletBalance }),
  };

  generationJob = {
    findUnique: async ({ where }: any) => {
      if (where?.userId_idempotencyKey) {
        const { userId, idempotencyKey } = where.userId_idempotencyKey;
        for (const j of this.jobs.values()) {
          if (j.userId === userId && j.idempotencyKey === idempotencyKey) return j;
        }
        return null;
      }
      return this.jobs.get(where.id) ?? null;
    },
    findFirst: async ({ where }: any) => {
      for (const j of this.jobs.values()) {
        if (where?.userId && j.userId !== where.userId) continue;
        if (where?.status?.in && !where.status.in.includes(j.status)) continue;
        return j;
      }
      return null;
    },
    count: async (_where?: any) => this.dailyCount,
  };

  async $queryRaw(strings: any, ...args: any[]): Promise<any> {
    const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
    if (sql.includes('SELECT "id" FROM "User"')) {
      const id = args[0] ?? "user-1";
      return [{ id }];
    }
    if (sql.includes('UPDATE "GenerationJob"') && sql.includes('submission')) {
      let jobId: any;
      for (const a of args) {
        if (typeof a === "string" && this.jobs.has(a)) {
          jobId = a;
          break;
        }
      }
      const job = jobId ? this.jobs.get(jobId) : Array.from(this.jobs.values())[0];
      if (job) {
        if (sql.includes('SET "status" = \'PROCESSING\'') || sql.includes('"status" = \'PROCESSING\'')) {
          job.status = "PROCESSING";
          job.providerJobId = "fal-prov-001";
          job.settings = { ...job.settings, submission: { state: "submitted" } };
        } else {
          job.settings = { ...job.settings, submission: { state: "dispatching" } };
        }
        return [{ id: job.id }];
      }
    }
    return [];
  }

  async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      $queryRaw: async (s: any, ...a: any[]) => this.$queryRaw(s, ...a),
      generationJob: {
        findUnique: async (args: any) => this.generationJob.findUnique(args),
        findFirst: async (args: any) => this.generationJob.findFirst(args),
        count: async (args: any) => this.generationJob.count(args),
        create: async ({ data }: any) => {
          const job = { id: `vjob-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...data };
          this.jobs.set(job.id, job);
          return job;
        },
      },
      creditWallet: {
        update: async () => ({ balance: this.walletBalance }),
      },
      creditTransaction: {
        findUnique: async () => null,
        create: async () => ({ id: "tx-1" }),
      },
    };
    return fn(tx);
  }
}

// ---------------------------------------------------------------------------
// Section 1: Authentication, CSRF & Rate Limiting Guardrails
// ---------------------------------------------------------------------------
console.log("\n# Section 1: Authentication, CSRF & Rate Limiting Guardrails");
{
  let currentUserId: string | null = null;
  const storage = new MockStorage();
  const provider = new MockProvider();
  const rateLimitMap = new Map<string, number>();

  const handlers = createVideoGenerationHandlers({
    getUserId: async () => currentUserId,
    trustedOrigins: () => ["https://pixora.test"],
    getProvider: () => provider as any,
    loadJob: async () => null,
    loadBalance: async () => 100,
    signAssetUrl: async (userId, assetId) => `https://signed.supabase.test/users/${userId}/${assetId}`,
    reconcileForUser: async () => {},
    scheduleBackground: (task) => { task(); },
    checkRateLimit: (key) => {
      const count = (rateLimitMap.get(key) ?? 0) + 1;
      rateLimitMap.set(key, count);
      if (count > 2) return { allowed: false, retryAfterSeconds: 30 };
      return { allowed: true, retryAfterSeconds: 0 };
    },
    nodeEnv: "development",
    db: new GlobalMockDb() as any,
  });

  // 1. Unauthenticated POST
  currentUserId = null;
  const unauthReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "idem-key-unauth-12345",
    },
    body: JSON.stringify({ prompt: "A cinematic flying drone shot" }),
  });
  const unauthRes = await handlers.postVideo(unauthReq);
  ok(unauthRes.status === 401, "unauthenticated POST returns HTTP 401");
  const unauthJson = await unauthRes.json();
  ok(unauthJson.error?.code === "UNAUTHENTICATED", "returns UNAUTHENTICATED error code");

  // 2. Untrusted Origin / CSRF Block
  currentUserId = "user-auth-001";
  const untrustedReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://attacker.evil.com",
      "content-type": "application/json",
      "idempotency-key": "idem-key-csrf-12345",
    },
    body: JSON.stringify({ prompt: "CSRF attack attempt" }),
  });
  const untrustedRes = await handlers.postVideo(untrustedReq);
  ok(untrustedRes.status === 403, "untrusted origin returns HTTP 403 FORBIDDEN_ORIGIN");
  const untrustedJson = await untrustedRes.json();
  ok(untrustedJson.error?.code === "FORBIDDEN_ORIGIN", "identifies FORBIDDEN_ORIGIN");

  // 3. Rate Limiting (Burst Throttle)
  const rlReq1 = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "x-forwarded-for": "198.51.100.5",
      "content-type": "application/json",
      "idempotency-key": "idem-rl-1",
    },
    body: JSON.stringify({ prompt: "Valid video prompt" }),
  });
  await handlers.postVideo(rlReq1);

  const rlReq2 = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "x-forwarded-for": "198.51.100.5",
      "content-type": "application/json",
      "idempotency-key": "idem-rl-2",
    },
    body: JSON.stringify({ prompt: "Valid video prompt" }),
  });
  await handlers.postVideo(rlReq2);

  const rlReq3 = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "x-forwarded-for": "198.51.100.5",
      "content-type": "application/json",
      "idempotency-key": "idem-rl-3",
    },
    body: JSON.stringify({ prompt: "Valid video prompt" }),
  });
  const rlRes3 = await handlers.postVideo(rlReq3);
  ok(rlRes3.status === 429, "burst rate limit returns HTTP 429 RATE_LIMITED");
  ok(rlRes3.headers.get("retry-after") === "30", "rate limit response includes Retry-After header");
}

// ---------------------------------------------------------------------------
// Section 2: Input Validation & Entitlement Security
// ---------------------------------------------------------------------------
console.log("\n# Section 2: Input Validation & Entitlement Security");
{
  const provider = new MockProvider();
  const handlers = createVideoGenerationHandlers({
    getUserId: async () => "user-qa-001",
    getUser: async (id) => ({
      id,
      email: "qa@pixora.test",
      emailVerified: new Date(),
    }),
    trustedOrigins: () => ["https://pixora.test"],
    getProvider: () => provider as any,
    loadJob: async () => null,
    loadBalance: async () => 100,
    signAssetUrl: async () => "https://signed.supabase.test/url",
    reconcileForUser: async () => {},
    scheduleBackground: () => {},
    allowlistRaw: "user-qa-001",
    nodeEnv: "production", // Production requires Stage 8 QA authorization
  });

  // 1. Missing Idempotency Key
  const noKeyReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: { origin: "https://pixora.test", "content-type": "application/json" },
    body: JSON.stringify({ prompt: "A drone shot" }),
  });
  const noKeyRes = await handlers.postVideo(noKeyReq);
  ok(noKeyRes.status === 400, "missing idempotency key returns HTTP 400");
  const noKeyJson = await noKeyRes.json();
  ok(noKeyJson.error?.code === "INVALID_INPUT", "identifies INVALID_INPUT");

  // 2. Short Idempotency Key (< 8 chars)
  const shortKeyReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "short",
    },
    body: JSON.stringify({ prompt: "A drone shot" }),
  });
  const shortKeyRes = await handlers.postVideo(shortKeyReq);
  ok(shortKeyRes.status === 400, "short idempotency key (<8 chars) returns HTTP 400");

  // 3. Empty / Whitespace Prompt
  const emptyPromptReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "valid-idem-key-001",
    },
    body: JSON.stringify({ prompt: "   " }),
  });
  const emptyPromptRes = await handlers.postVideo(emptyPromptReq);
  ok(emptyPromptRes.status === 400, "whitespace prompt returns HTTP 400");

  // 4. Prompt Exceeding 2048 Characters
  const longPromptReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "valid-idem-key-002",
    },
    body: JSON.stringify({ prompt: "a".repeat(2049) }),
  });
  const longPromptRes = await handlers.postVideo(longPromptReq);
  ok(longPromptRes.status === 400, "prompt > 2048 characters returns HTTP 400");

  // 5. Unsupported Aspect Ratio
  const badAspectReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "valid-idem-key-003",
    },
    body: JSON.stringify({ prompt: "A drone shot", aspectRatio: "4:3" }),
  });
  const badAspectRes = await handlers.postVideo(badAspectReq);
  ok(badAspectRes.status === 400, "unsupported aspect ratio (4:3) returns HTTP 400");

  // 5b. Unsupported Frame Rate (model operates at 16 fps, claims of 24 fps are strictly rejected)
  const badFpsReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "valid-idem-key-003b",
    },
    body: JSON.stringify({ prompt: "A drone shot", fps: 24 }),
  });
  const badFpsRes = await handlers.postVideo(badFpsReq);
  ok(badFpsRes.status === 400, "unsupported frame rate (24fps when model runs at 16fps) returns HTTP 400");

  // 6. Client Tier Manipulation: Attacker sends tier: "paid", isQa: true
  const spoofHandler = createVideoGenerationHandlers({
    getUserId: async () => "user-unauthorized-001",
    getUser: async (id) => ({ id, email: "regular@pixora.test", emailVerified: new Date() }),
    trustedOrigins: () => ["https://pixora.test"],
    getProvider: () => provider as any,
    loadJob: async () => null,
    loadBalance: async () => 100,
    signAssetUrl: async () => "https://signed.supabase.test/url",
    reconcileForUser: async () => {},
    scheduleBackground: () => {},
    allowlistRaw: "user-qa-001", // user-unauthorized-001 is NOT in allowlist
    nodeEnv: "production",
  });

  const spoofReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "valid-idem-spoof-001",
    },
    body: JSON.stringify({
      prompt: "A drone shot",
      tier: "paid",
      isQa: true,
      creditCost: 0,
    }),
  });
  const spoofRes = await spoofHandler.postVideo(spoofReq);
  ok(spoofRes.status === 403, "client tier/QA spoofing strictly rejected with HTTP 403 in production");
  const spoofJson = await spoofRes.json();
  ok(spoofJson.error?.code === "FORBIDDEN", "returns FORBIDDEN error code");
  ok(spoofJson.error?.message.includes("authorized QA accounts"), "cites Stage 8 QA authorization requirement");
}

// ---------------------------------------------------------------------------
// Section 3: Accounting, Idempotency & Concurrency Guardrails
// ---------------------------------------------------------------------------
console.log("\n# Section 3: Accounting, Idempotency & Concurrency Guardrails");
{
  class MockDb {
    public jobs = new Map<string, any>();
    public walletBalance = 5; // Insufficient for 10 credits default cost
    public dailyCount = 0;

    user = {
      findUnique: async () => ({ id: "user-acct-001", email: "qa@pixora.test", emailVerified: new Date() }),
    };

    creditWallet = {
      findUnique: async () => ({ balance: this.walletBalance }),
    };

    generationJob = {
      findUnique: async ({ where }: any) => {
        if (where?.userId_idempotencyKey) {
          const { userId, idempotencyKey } = where.userId_idempotencyKey;
          for (const j of this.jobs.values()) {
            if (j.userId === userId && j.idempotencyKey === idempotencyKey) return j;
          }
          return null;
        }
        return this.jobs.get(where.id) ?? null;
      },
      findFirst: async ({ where }: any) => {
        for (const j of this.jobs.values()) {
          if (where.userId && j.userId !== where.userId) continue;
          if (where.status?.in && !where.status.in.includes(j.status)) continue;
          return j;
        }
        return null;
      },
      count: async (_where?: any) => this.dailyCount,
    };

    async $queryRaw(strings: any, ...args: any[]): Promise<any> {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes('SELECT "id" FROM "User"')) {
        return [{ id: "user-acct-001" }];
      }
      if (sql.includes('UPDATE "GenerationJob"') && sql.includes('"settings" = jsonb_set')) {
        const jobId = args[3] || args[2] || args[0];
        const job = this.jobs.get(jobId);
        if (job) {
          job.status = "PROCESSING";
          job.providerJobId = "fal-prov-001";
          job.settings = { ...job.settings, submission: { state: "submitted" } };
          return [{ id: job.id }];
        }
      }
      if (sql.includes('SET "status" = \'FAILED\'') || sql.includes('"status" = \'FAILED\'')) {
        let jobId: any;
        for (const a of args) {
          if (typeof a === "string" && this.jobs.has(a)) {
            jobId = a;
            break;
          }
        }
        const job = jobId ? this.jobs.get(jobId) : Array.from(this.jobs.values())[0];
        if (job) {
          job.status = "FAILED";
          job.errorMessage = args[0];
          return [{ id: job.id }];
        }
      }
      if (sql.includes('UPDATE "CreditWallet"')) {
        if (sql.includes('+')) {
          this.walletBalance += 10;
        } else {
          if (this.walletBalance < 10) return [];
          this.walletBalance -= 10;
        }
        return [{ id: "wallet-1", balance: this.walletBalance }];
      }
      return [];
    }

    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        $queryRaw: async (s: any, ...a: any[]) => this.$queryRaw(s, ...a),
        generationJob: {
          findUnique: async (args: any) => this.generationJob.findUnique(args),
          findFirst: async (args: any) => this.generationJob.findFirst(args),
          count: async (args: any) => this.generationJob.count(args),
          create: async ({ data }: any) => {
            const job = { id: `vjob-${Date.now()}`, ...data };
            this.jobs.set(job.id, job);
            return job;
          },
        },
        creditWallet: {
          update: async () => ({ balance: this.walletBalance }),
        },
        creditTransaction: {
          findUnique: async ({ where }: any) => {
            if (where?.idempotencyKey?.startsWith("job-refund:")) return null;
            return { id: "tx-debit-1", userId: "user-async-001", amount: -10 };
          },
          create: async () => ({ id: "tx-ref-1" }),
        },
      };
      return fn(tx);
    }
  }

  const db = new MockDb();
  const provider = new MockProvider();

  const handlers = createVideoGenerationHandlers({
    getUserId: async () => "user-acct-001",
    getUser: async (id) => ({ id, email: "qa@pixora.test", emailVerified: new Date() }),
    trustedOrigins: () => ["https://pixora.test"],
    getProvider: () => provider as any,
    loadJob: async (u, j) => db.jobs.get(j) ?? null,
    loadBalance: async () => db.walletBalance,
    signAssetUrl: async () => "https://signed.supabase.test/url",
    reconcileForUser: async () => {},
    scheduleBackground: () => {},
    nodeEnv: "development",
    db: db as any,
  });

  // 1. Insufficient Credits (Wallet balance = 5, cost = 10)
  const brokeReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "idem-broke-001",
    },
    body: JSON.stringify({ prompt: "A drone shot" }),
  });
  const brokeRes = await handlers.postVideo(brokeReq);
  ok(brokeRes.status === 402, "insufficient credits returns HTTP 402");
  const brokeJson = await brokeRes.json();
  ok(brokeJson.error?.code === "INSUFFICIENT_CREDITS", "returns INSUFFICIENT_CREDITS error code");

  // Deposit credits and test quota
  db.walletBalance = 100;
  db.dailyCount = 1; // Promotional limit is 1 per day

  const promoLimitHandler = createVideoGenerationHandlers({
    getUserId: async () => "user-promo-001",
    getUser: async (id) => ({ id, email: "promo@pixora.test", emailVerified: new Date() }),
    trustedOrigins: () => ["https://pixora.test"],
    getProvider: () => provider as any,
    loadJob: async (u, j) => db.jobs.get(j) ?? null,
    loadBalance: async () => db.walletBalance,
    signAssetUrl: async () => "https://signed.supabase.test/url",
    reconcileForUser: async () => {},
    scheduleBackground: () => {},
    nodeEnv: "development",
    db: db as any,
  });

  // 2. Promotional Quota Exceeded (1 generation/day)
  const quotaReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "idem-quota-001",
    },
    body: JSON.stringify({ prompt: "A drone shot" }),
  });
  const quotaRes = await promoLimitHandler.postVideo(quotaReq);
  ok(quotaRes.status === 429, "exceeding daily promotional quota (1/day) returns HTTP 429");
  const quotaJson = await quotaRes.json();
  ok(quotaJson.error?.code === "DAILY_LIMIT_REACHED", "returns DAILY_LIMIT_REACHED error code");

  // 3. Active Concurrency Limit (1 active generation across all types)
  db.dailyCount = 0;
  db.jobs.set("existing-active-job", {
    id: "existing-active-job",
    userId: "user-acct-001",
    type: "IMAGE",
    status: "PROCESSING",
  });

  const activeJobReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "idem-active-001",
    },
    body: JSON.stringify({ prompt: "A drone shot" }),
  });
  const activeJobRes = await handlers.postVideo(activeJobReq);
  ok(activeJobRes.status === 409, "active generation concurrency constraint returns HTTP 409");
  const activeJson = await activeJobRes.json();
  ok(activeJson.error?.code === "ACTIVE_JOB_EXISTS", "returns ACTIVE_JOB_EXISTS error code");
}

// ---------------------------------------------------------------------------
// Section 4: Asynchronous Dispatch, Fast 202 & Ambiguous Provider Outcomes
// ---------------------------------------------------------------------------
console.log("\n# Section 4: Asynchronous Dispatch, Fast 202 & Ambiguous Provider Outcomes");
{
  class AsyncMockDb {
    public jobs = new Map<string, any>();
    public walletBalance = 100;

    user = {
      findUnique: async () => ({ id: "user-async-001", email: "qa@pixora.test", emailVerified: new Date() }),
    };

    creditWallet = {
      findUnique: async () => ({ balance: this.walletBalance }),
    };

    generationJob = {
      findUnique: async ({ where }: any) => {
        if (where?.userId_idempotencyKey) {
          const { userId, idempotencyKey } = where.userId_idempotencyKey;
          for (const j of this.jobs.values()) {
            if (j.userId === userId && j.idempotencyKey === idempotencyKey) return j;
          }
          return null;
        }
        return this.jobs.get(where.id) ?? null;
      },
      findFirst: async (_args?: any) => null,
      count: async (_args?: any) => 0,
    };

    async $queryRaw(strings: any, ...args: any[]): Promise<any> {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes('SELECT "id" FROM "User"')) return [{ id: "user-async-001" }];

      if (sql.includes('UPDATE "GenerationJob"') && sql.includes('submission')) {
        let jobId: any;
        for (const a of args) {
          if (typeof a === "string" && this.jobs.has(a)) {
            jobId = a;
            break;
          }
        }
        const job = jobId ? this.jobs.get(jobId) : Array.from(this.jobs.values())[0];
        if (job) {
          if (sql.includes('SET "status" = \'PROCESSING\'') || sql.includes('"status" = \'PROCESSING\'')) {
            job.status = "PROCESSING";
            job.providerJobId = "fal-prov-ok-001";
            job.settings = { ...job.settings, submission: { state: "submitted" } };
          } else {
            job.settings = { ...job.settings, submission: { state: "dispatching" } };
          }
          return [{ id: job.id }];
        }
      }
      if (sql.includes('SET "status" = \'FAILED\'') || sql.includes('"status" = \'FAILED\'')) {
        let jobId: any;
        for (const a of args) {
          if (typeof a === "string" && this.jobs.has(a)) {
            jobId = a;
            break;
          }
        }
        const job = jobId ? this.jobs.get(jobId) : Array.from(this.jobs.values())[0];
        if (job) {
          job.status = "FAILED";
          job.errorMessage = args[0];
          return [{ id: job.id }];
        }
      }
      if (sql.includes('UPDATE "CreditWallet"')) {
        if (sql.includes('+')) {
          this.walletBalance += 10;
        } else {
          if (this.walletBalance < 10) return [];
          this.walletBalance -= 10;
        }
        return [{ id: "wallet-1", balance: this.walletBalance }];
      }
      return [];
    }

    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        $queryRaw: async (s: any, ...a: any[]) => this.$queryRaw(s, ...a),
        generationJob: {
          findUnique: async (args: any) => this.generationJob.findUnique(args),
          findFirst: async (args: any) => this.generationJob.findFirst(args),
          count: async (args: any) => this.generationJob.count(args),
          create: async ({ data }: any) => {
            const job = { id: `vjob-${Date.now()}`, ...data };
            this.jobs.set(job.id, job);
            return job;
          },
        },
        creditWallet: {
          update: async () => ({ balance: this.walletBalance }),
        },
        creditTransaction: {
          findUnique: async ({ where }: any) => {
            if (where?.idempotencyKey?.startsWith("job-refund:")) return null;
            return { id: "tx-debit-1", userId: "user-async-001", amount: -10 };
          },
          create: async () => ({ id: "tx-ref-1" }),
        },
      };
      return fn(tx);
    }
  }

  const db = new AsyncMockDb();
  const provider = new MockProvider();

  const handlers = createVideoGenerationHandlers({
    getUserId: async () => "user-async-001",
    getUser: async (id) => ({ id, email: "qa@pixora.test", emailVerified: new Date() }),
    trustedOrigins: () => ["https://pixora.test"],
    getProvider: () => provider as any,
    loadJob: async (u, j) => db.jobs.get(j) ?? null,
    loadBalance: async () => db.walletBalance,
    signAssetUrl: async () => "https://signed.supabase.test/url",
    reconcileForUser: async () => {},
    scheduleBackground: () => {},
    nodeEnv: "development",
    db: db as any,
  });

  // 1. Successful Asynchronous Submission -> HTTP 202 Accepted
  provider.mode = "success";
  const submitReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "idem-async-ok-001",
    },
    body: JSON.stringify({ prompt: "A majestic eagle soaring over snow-capped mountains" }),
  });
  const submitRes = await handlers.postVideo(submitReq);
  ok(submitRes.status === 202, "successful submission returns HTTP 202 Accepted");
  ok(Boolean(submitRes.headers.get("Location")?.startsWith("/api/generations/video/vjob-")), "Location header points to video job status route");
  ok(submitRes.headers.get("Retry-After") === "4", "Retry-After header set to 4 seconds");
  const submitJson = await submitRes.json();
  ok(submitJson.job?.status === "PROCESSING", "job status is in PROCESSING");
  ok(submitJson.job?.estimatedCredits === 10, "reports 10 credits estimated cost");
  ok(submitJson.job?.frameRate === 16, "job view reports model native frame rate of 16 fps");
  ok(submitJson.job?.durationSeconds === 5, "job view reports duration of 5 seconds");
  ok(submitJson.replayed === false, "fresh job reports replayed: false");

  // 2. Verified provider dispatch payload
  const lastSubmit = provider.submitCalls[provider.submitCalls.length - 1];
  ok(lastSubmit.prompt === "A majestic eagle soaring over snow-capped mountains", "passes trimmed prompt to provider");
  ok(lastSubmit.settings?.aspectRatio === "16:9", "passes aspect ratio 16:9 to provider");
  ok(typeof lastSubmit.jobId === "string" && lastSubmit.jobId.startsWith("vjob-"), "embeds jobId for webhook correlation");

  // 3. Definite Provider Rejection (not_run) -> HTTP 502 with immediate refund
  provider.mode = "fail:not_run";
  const rejectReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "idem-async-reject-001",
    },
    body: JSON.stringify({ prompt: "Violent unsafe prompt" }),
  });
  const rejectRes = await handlers.postVideo(rejectReq);
  ok(rejectRes.status === 502, "definite provider rejection returns HTTP 502");
  const rejectJson = await rejectRes.json();
  ok(rejectJson.error?.code === "UPSTREAM_REJECTED", "identifies UPSTREAM_REJECTED error code");

  // 4. Ambiguous Provider Acceptance (unknown: e.g. ECONNRESET or timeout) -> HTTP 202 Accepted (credits preserved)
  provider.mode = "fail:unknown";
  const ambigReq = new Request("https://pixora.test/api/generations/video", {
    method: "POST",
    headers: {
      origin: "https://pixora.test",
      "content-type": "application/json",
      "idempotency-key": "idem-async-ambig-001",
    },
    body: JSON.stringify({ prompt: "A time-lapse of blooming flowers" }),
  });
  const ambigRes = await handlers.postVideo(ambigReq);
  ok(ambigRes.status === 202, "ambiguous provider outcome returns HTTP 202 Accepted (never prematurely refunded)");
}

// ---------------------------------------------------------------------------
// Section 5: Durable Submission Intent & Crash Recovery
// ---------------------------------------------------------------------------
console.log("\n# Section 5: Durable Submission Intent & Crash Recovery");
{
  class RecoveryDb {
    public jobs = new Map<string, any>();
    public walletBalance = 100;

    constructor() {
      // 1. A job committed with state: 'intent' whose process crashed before dispatch began
      this.jobs.set("vjob-crashed-intent", {
        id: "vjob-crashed-intent",
        status: "PENDING",
        prompt: "A neon cyberpunk cityscape in rain",
        settings: {
          aspectRatio: "16:9",
          submission: { state: "intent", createdAt: new Date(Date.now() - 30_000).toISOString() },
        },
      });

      // 2. A job whose process crashed DURING dispatch (lease expired after 60s)
      this.jobs.set("vjob-crashed-dispatching", {
        id: "vjob-crashed-dispatching",
        status: "PENDING",
        prompt: "An underwater coral reef",
        settings: {
          aspectRatio: "9:16",
          submission: {
            state: "dispatching",
            token: "tok-expired",
            expiresAt: new Date(Date.now() - 65_000).toISOString(), // expired > 60s ago
          },
        },
      });
    }

    async $queryRaw(strings: any, ...args: any[]): Promise<any> {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);

      if (sql.includes('UPDATE "GenerationJob"') && sql.includes('submission')) {
        let jobId = args[3] || args[0];
        for (const arg of args) {
          if (typeof arg === "string" && this.jobs.has(arg)) {
            jobId = arg;
            break;
          }
        }
        const job = this.jobs.get(jobId);
        if (job) {
          const isAmbiguous = args.some((a) => typeof a === "string" && a.includes("ambiguous"));
          if (isAmbiguous) {
            job.status = "PROCESSING";
            job.settings = { ...job.settings, submission: { state: "ambiguous" } };
            return [{ id: job.id }];
          }
          job.status = "PROCESSING";
          job.providerJobId = "fal-recovered-001";
          job.settings = { ...job.settings, submission: { state: "submitted" } };
          return [{ id: job.id }];
        }
      }
      if (sql.includes('SET "status" = \'FAILED\'')) {
        let jobId = args.find((a: any) => typeof a === "string" && this.jobs.has(a));
        const job = jobId ? this.jobs.get(jobId) : null;
        if (job && (job.status === "PENDING" || job.status === "PROCESSING")) {
          job.status = "FAILED";
          job.errorMessage = typeof args[0] === "string" ? args[0] : "FAILED";
          job.ingestionToken = null;
          job.ingestionLeaseExpiresAt = null;
          const settingsArg = args.find((a: any) => typeof a === "string" && a.startsWith("{"));
          if (settingsArg) {
            try { job.settings = JSON.parse(settingsArg); } catch {}
          }
          this.walletBalance += 10;
          return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
        }
        return [];
      }
      if (sql.includes('SET "status" = \'COMPLETED\'')) {
        let jobId = args.find((a: any) => typeof a === "string" && this.jobs.has(a));
        const job = jobId ? this.jobs.get(jobId) : null;
        if (job && job.status === "PROCESSING") {
          job.status = "COMPLETED";
          job.chargedCredits = job.estimatedCredits;
          job.ingestionToken = null;
          job.ingestionLeaseExpiresAt = null;
          const settingsArg = args.find((a: any) => typeof a === "string" && a.startsWith("{"));
          if (settingsArg) {
            try { job.settings = JSON.parse(settingsArg); } catch {}
          }
          return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
        }
        return [];
      }
      if (sql.includes('UPDATE "CreditWallet"')) {
        if (this.walletBalance < 10) return [];
        this.walletBalance -= 10;
        return [{ id: "wallet-1", balance: this.walletBalance }];
      }
      return [];
    }

    generationJob = {
      findUnique: async ({ where }: any) => this.jobs.get(where.id) ?? null,
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
      update: async ({ where, data }: any) => {
        const job = this.jobs.get(where.id);
        if (job) {
          Object.assign(job, data);
          return job;
        }
        return null;
      },
    };

    creditTransaction = {
      findUnique: async () => null,
      findFirst: async () => ({ id: "ctx-1", userId: "user-rec-001", amount: -10 }),
      create: async () => ({ id: "ctx-ref-1" }),
    };

    creditWallet = {
      update: async () => ({ balance: this.walletBalance }),
    };

    generatedAsset = {
      create: async ({ data }: any) => ({ id: data.id }),
    };

    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn({
        generationJob: this.generationJob,
        creditTransaction: this.creditTransaction,
        creditWallet: this.creditWallet,
        generatedAsset: this.generatedAsset,
        $queryRaw: async (s: any, ...a: any[]) => this.$queryRaw(s, ...a),
      });
    }
  }

  const recDb = new RecoveryDb();
  const provider = new MockProvider();

  // 1. Crash before dispatch (state: "intent") is safely recovered and submitted
  const intentJob = recDb.jobs.get("vjob-crashed-intent");
  ok(intentJob.status === "PENDING", "unsubmitted job was in PENDING");
  ok(intentJob.settings.submission.state === "intent", "submission state is 'intent'");

  const dispatchRes = await dispatchVideoSubmission({
    jobId: intentJob.id,
    prompt: intentJob.prompt,
    aspectRatio: intentJob.settings.aspectRatio,
    provider: provider as any,
    db: recDb as any,
  });

  ok(dispatchRes.outcome === "submitted", "crashed intent job successfully claimed and submitted");
  ok(intentJob.status === "PROCESSING", "job transitioned to PROCESSING");

  // 2. Crash during dispatch (state: "dispatching") with expired lease:
  // MUST NOT blindly re-submit to Fal.ai (which could double charge). Transitions to ambiguous!
  const dispatchingJob = recDb.jobs.get("vjob-crashed-dispatching");
  const staleReconcile = await reconcileStaleSubmissionIntent(dispatchingJob.id, recDb as any);
  ok(staleReconcile === true, "reconcileStaleSubmissionIntent succeeds");
  ok(dispatchingJob.status === "PROCESSING", "unconfirmed dispatch transitioned to PROCESSING");
  ok(dispatchingJob.settings.submission.state === "ambiguous", "marked ambiguous to await webhook or operational review (never auto-refunded)");

  // 3. Ambiguous job beyond 15 minutes: MUST NOT be automatically refunded!
  dispatchingJob.startedAt = new Date(Date.now() - 16 * 60 * 1000); // 16 minutes old
  dispatchingJob.type = "VIDEO";
  const staleRes = await reconcileStaleVideoJobs({}, recDb as any);
  ok(staleRes.unresolved >= 1, "reconcileStaleVideoJobs marks ambiguous job as unresolved");
  ok(staleRes.settled === 0, "ambiguous job is NOT auto-refunded or failed");
  ok(dispatchingJob.status === "PROCESSING", "ambiguous job remains in PROCESSING (debit preserved)");
  ok(dispatchingJob.settings.submission?.unresolved === true, "job flagged as unresolved in settings");
  ok(dispatchingJob.settings.submission?.reviewStatus === "pending_operator_review", "reviewStatus set to pending_operator_review");
  ok(recDb.walletBalance === 100, "user credit balance preserved (no premature refund)");

  // 4. Duplicate reconciliation is strictly idempotent
  const dupeRes = await reconcileStaleVideoJobs({}, recDb as any);
  ok(dupeRes.settled === 0 && dupeRes.unresolved === 0, "duplicate reconciliation is strictly idempotent");

  // 5. Operator Resolution: Confirmed Provider Non-Execution (Refund)
  const opFailRes = await resolveAmbiguousJobAsFailed(
    {
      jobId: dispatchingJob.id,
      operatorId: "admin-op-sec5",
      reason: "Confirmed non-execution via Fal.ai operational logs",
    },
    recDb as any,
  );
  ok(opFailRes.settled === true, "operator resolution settles ambiguous job as FAILED");
  ok(dispatchingJob.status === "FAILED", "job status updated to FAILED by operator");
  ok(dispatchingJob.settings.resolution?.resolvedBy === "operator", "operator audit trail records resolvedBy = operator");
  ok(dispatchingJob.settings.resolution?.action === "refund", "operator audit trail records action = refund");
  ok(recDb.walletBalance === 110, "credits refunded back to user wallet");

  // 6. Invariant: Prevention of refund followed by late completion
  let lateCompleteFailed = false;
  try {
    const { completeVideoJobWithAsset } = await import("@/features/video/lifecycle");
    await completeVideoJobWithAsset(
      {
        jobId: dispatchingJob.id,
        ingestionToken: "tok-late-forbidden",
        asset: {
          userId: "user-rec-001",
          assetId: "asset-forbidden",
          storageKey: "users/u/v/j/a.mp4",
          width: 1280,
          height: 720,
          durationSeconds: 5,
          sizeBytes: 1000,
        },
      },
      recDb as any,
    );
  } catch (err: any) {
    if (err.name === "JobNotCompletableError") lateCompleteFailed = true;
  }
  ok(lateCompleteFailed, "completeVideoJobWithAsset on refunded job strictly throws JobNotCompletableError");
  ok(dispatchingJob.status === "FAILED", "refunded job remains FAILED (late completion prevented)");

  // 7. Operator Resolution: Confirmed Provider Completion (Success)
  recDb.jobs.set("vjob-ambig-complete", {
    id: "vjob-ambig-complete",
    userId: "user-rec-001",
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
      jobId: "vjob-ambig-complete",
      operatorId: "admin-op-sec5b",
      reason: "Confirmed provider completion via Fal.ai support CDN record",
      asset: {
        userId: "user-rec-001",
        assetId: "asset-comp-sec5",
        storageKey: "users/user-rec-001/videos/vjob-ambig-complete/asset-comp-sec5.mp4",
        thumbnailKey: null,
        mimeType: "video/mp4",
        width: 1280,
        height: 720,
        durationSeconds: 5,
        sizeBytes: 2048,
      },
    },
    recDb as any,
  );
  ok(opCompRes.settled === true, "operator resolution settles job as COMPLETED");
  const compJob = recDb.jobs.get("vjob-ambig-complete");
  ok(compJob.status === "COMPLETED", "job status updated to COMPLETED by operator");
  ok(compJob.chargedCredits === 10, "chargedCredits finalized to 10 (no refund)");
  ok(compJob.settings.resolution?.resolvedBy === "operator", "operator audit trail records resolvedBy = operator");
  ok(compJob.settings.resolution?.action === "complete", "operator audit trail records action = complete");
}

// ---------------------------------------------------------------------------
// Section 6: Lightweight Polling, Ingestion Signaling & Signed URLs
// ---------------------------------------------------------------------------
console.log("\n# Section 6: Lightweight Polling, Ingestion Signaling & Signed URLs");
{
  class PollingDb {
    public jobs = new Map<string, any>();
    public signaledJobId: string | null = null;

    constructor() {
      // 1. User A's processing job with pending providerResult
      this.jobs.set("vjob-user-a-proc", {
        id: "vjob-user-a-proc",
        userId: "user-alpha",
        status: "PROCESSING",
        prompt: "A futuristic hyperloop train",
        settings: {
          aspectRatio: "16:9",
          providerResult: { payload: { video: { url: "https://v3.fal.media/output.mp4" } } },
        },
        chargedCredits: 0,
        estimatedCredits: 10,
        createdAt: new Date(),
        completedAt: null,
      });

      // 2. User A's completed job with assets
      this.jobs.set("vjob-user-a-comp", {
        id: "vjob-user-a-comp",
        userId: "user-alpha",
        status: "COMPLETED",
        prompt: "A sunset over the Pacific",
        settings: { aspectRatio: "16:9" },
        chargedCredits: 10,
        estimatedCredits: 10,
        createdAt: new Date(Date.now() - 60_000),
        completedAt: new Date(),
        assets: [
          {
            id: "asset-video-001",
            width: 1280,
            height: 720,
            mimeType: "video/mp4",
            fileSize: BigInt(19190),
            durationSeconds: 5.0,
            thumbnailKey: "users/user-alpha/videos/vjob-user-a-comp/asset-video-001-thumb.webp",
          },
        ],
      });
    }

    async findJob(userId: string, jobId: string) {
      const job = this.jobs.get(jobId);
      if (!job || job.userId !== userId) return null; // strictly owner scoped
      return job;
    }
  }

  const pollDb = new PollingDb();
  let currentUserId = "user-alpha";

  const handlers = createVideoGenerationHandlers({
    getUserId: async () => currentUserId,
    trustedOrigins: () => ["https://pixora.test"],
    getProvider: () => new MockProvider() as any,
    loadJob: async (userId, jobId) => pollDb.findJob(userId, jobId),
    loadBalance: async () => 90,
    signAssetUrl: async (userId, assetId, kind) =>
      `https://signed.supabase.test/users/${userId}/${assetId}-${kind}.url`,
    reconcileForUser: async () => {},
    scheduleBackground: (task) => { task(); },
    triggerPendingIngestion: async (jobId) => {
      pollDb.signaledJobId = jobId;
    },
    nodeEnv: "development",
  });

  // 1. Cross-User ID Probing (User Bravo tries to fetch User Alpha's job)
  currentUserId = "user-bravo";
  const probeReq = new Request("https://pixora.test/api/generations/video/vjob-user-a-comp", {
    method: "GET",
  });
  const probeRes = await handlers.getJob(probeReq, "vjob-user-a-comp");
  ok(probeRes.status === 404, "cross-user job ID query returns HTTP 404 NOT_FOUND (never leaks existence)");
  const probeJson = await probeRes.json();
  ok(probeJson.error?.code === "NOT_FOUND", "returns safe NOT_FOUND error code");

  // 2. Lightweight Polling & Pending Ingestion Signaling
  currentUserId = "user-alpha";
  const pollProcReq = new Request("https://pixora.test/api/generations/video/vjob-user-a-proc", {
    method: "GET",
  });
  const pollProcRes = await handlers.getJob(pollProcReq, "vjob-user-a-proc");
  ok(pollProcRes.status === 200, "in-progress job polling returns HTTP 200");
  ok(pollProcRes.headers.get("retry-after") === "4", "Retry-After header set to 4 seconds");
  const pollProcJson = await pollProcRes.json();
  ok(pollProcJson.job?.status === "PROCESSING", "reports job status PROCESSING");
  ok(pollProcJson.asset === null, "asset is null while generation is in progress");
  ok(pollDb.signaledJobId === "vjob-user-a-proc", "lightweight GET signals background worker for pending ingestion");

  // 3. Completed Job Polling & Authenticated Signed URLs
  const pollCompReq = new Request("https://pixora.test/api/generations/video/vjob-user-a-comp", {
    method: "GET",
  });
  const pollCompRes = await handlers.getJob(pollCompReq, "vjob-user-a-comp");
  ok(pollCompRes.status === 200, "completed job polling returns HTTP 200");
  const pollCompJson = await pollCompRes.json();
  ok(pollCompJson.job?.status === "COMPLETED", "reports status COMPLETED");
  ok(pollCompJson.job?.creditsCharged === 10, "reports creditsCharged: 10");
  ok(typeof pollCompJson.asset?.videoUrl === "string", "includes authenticated signed video URL");
  ok(pollCompJson.asset?.videoUrl.includes("users/user-alpha/"), "signed URL verifies user ownership prefix");
  ok(typeof pollCompJson.asset?.thumbnailUrl === "string", "includes authenticated signed thumbnail URL");
  ok(pollCompJson.asset?.durationSeconds === 5, "reports asset duration: 5 seconds");

  // 4. Scheduled Recovery Worker: Independent durable ingestion without GET polling
  class SchedIngestDb {
    public jobs = new Map<string, any>();
    public assets = new Map<string, any>();

    constructor() {
      this.jobs.set("vjob-sched-ingest-001", {
        id: "vjob-sched-ingest-001",
        userId: "user-alpha",
        type: "VIDEO",
        status: "PROCESSING",
        provider: "fal-ai",
        settings: {
          providerResult: {
            payload: {
              video: { url: MOCK_MP4_PLAYABLE_DATA_URI },
              thumbnail: { url: "data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA" },
            },
          },
        },
        estimatedCredits: 10,
        chargedCredits: 0,
        ingestionToken: null,
        ingestionLeaseExpiresAt: null,
      });

      // A job whose immediate trigger crashed and lease expired
      this.jobs.set("vjob-crashed-trigger", {
        id: "vjob-crashed-trigger",
        userId: "user-alpha",
        type: "VIDEO",
        status: "PROCESSING",
        provider: "fal-ai",
        settings: {
          providerResult: {
            payload: {
              video: { url: MOCK_MP4_PLAYABLE_DATA_URI },
            },
          },
        },
        estimatedCredits: 10,
        chargedCredits: 0,
        ingestionToken: "tok-expired-worker",
        ingestionLeaseExpiresAt: new Date(Date.now() - 10_000), // expired 10s ago
      });

      // A job actively being ingested by another live worker (unexpired lease)
      this.jobs.set("vjob-active-live-worker", {
        id: "vjob-active-live-worker",
        userId: "user-alpha",
        type: "VIDEO",
        status: "PROCESSING",
        provider: "fal-ai",
        settings: {
          providerResult: {
            payload: {
              video: { url: MOCK_MP4_PLAYABLE_DATA_URI },
            },
          },
        },
        estimatedCredits: 10,
        chargedCredits: 0,
        ingestionToken: "tok-live-worker",
        ingestionLeaseExpiresAt: new Date(Date.now() + 120_000), // active for 2 more minutes
      });
    }

    generationJob = {
      findMany: async ({ where }: any) => {
        const results: any[] = [];
        for (const j of this.jobs.values()) {
          if (where.type && j.type !== where.type) continue;
          if (where.status && typeof where.status === "string" && j.status !== where.status) continue;
          results.push(j);
        }
        return results;
      },
      update: async ({ where, data }: any) => {
        const j = this.jobs.get(where.id);
        if (j) Object.assign(j, data);
        return j;
      },
    };

    generatedAsset = {
      create: async ({ data }: any) => {
        this.assets.set(data.id, data);
        return { id: data.id };
      },
    };

    async $queryRaw(strings: any, ...args: any[]): Promise<any> {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes('"ingestionToken" =')) {
        const token = args[0];
        const jobId = args.find((a: any) => typeof a === "string" && this.jobs.has(a));
        const job = jobId ? this.jobs.get(jobId) : null;
        if (job && job.status === "PROCESSING") {
          const isLeaseActive =
            job.ingestionToken &&
            job.ingestionLeaseExpiresAt &&
            new Date(job.ingestionLeaseExpiresAt).getTime() > Date.now();
          if (isLeaseActive) return [];
          job.ingestionToken = token;
          job.ingestionLeaseExpiresAt = new Date(Date.now() + 300_000);
          return [{ id: job.id, userId: job.userId, ingestionToken: token, ingestionLeaseExpiresAt: job.ingestionLeaseExpiresAt }];
        }
        return [];
      }
      return [];
    }

    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn({
        generationJob: this.generationJob,
        generatedAsset: this.generatedAsset,
        $queryRaw: async (s: any, ...a: any[]) => {
          const sql = Array.isArray(s) ? s.join("?") : String(s);
          if (sql.includes('j."status" = \'COMPLETED\'') || sql.includes('"status" = \'COMPLETED\'')) {
            const jobId = a.find((x: any) => typeof x === "string" && this.jobs.has(x)) ?? a[0];
            const token = a[1];
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
          return [];
        },
      });
    }
  }

  class MockStorageSec6 {
    public objects = new Map<string, Buffer>();
    async put(key: string, body: Buffer) { this.objects.set(key, body); }
    async putStream(key: string, stream: any) {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      this.objects.set(key, Buffer.concat(chunks));
      return { sizeBytes: this.objects.get(key)!.length };
    }
    async delete() {}
    async createSignedUrl(key: string) { return `https://signed.mock/${key}`; }
  }

  const schedDb = new SchedIngestDb();
  const schedStorage = new MockStorageSec6();

  // Run scheduled durable worker directly without any GET polling
  const ingestWorkerRes = await processPendingIngestionJobs({
    limit: 10,
    storage: schedStorage as any,
    db: schedDb as any,
  });

  ok(ingestWorkerRes.ingested === 2, "scheduled worker independently ingests ready jobs (completed 2 jobs)");
  const completedNoGet = schedDb.jobs.get("vjob-sched-ingest-001");
  ok(completedNoGet.status === "COMPLETED", "job without any GET poll progressed to COMPLETED");
  ok(completedNoGet.chargedCredits === 10, "credits charged finalized to 10 on independent completion");

  const recoveredCrashJob = schedDb.jobs.get("vjob-crashed-trigger");
  ok(recoveredCrashJob.status === "COMPLETED", "crashed immediate trigger recovered when lease expired");

  const activeWorkerJob = schedDb.jobs.get("vjob-active-live-worker");
  ok(activeWorkerJob.status === "PROCESSING", "active live worker lease excluded from duplicate ingestion");
  ok(activeWorkerJob.ingestionToken === "tok-live-worker", "live worker lease token preserved");
}

// ---------------------------------------------------------------------------
// Section 7: Client Controller & State Machine (VideoGenerationController)
// ---------------------------------------------------------------------------
console.log("\n# Section 7: Client Controller & State Machine (VideoGenerationController)");
{
  // 1. Polling backoff and jitter formula checks
  const delay0 = calculatePollDelay(0, null, false);
  ok(delay0 === 4000, "initial poll delay without failures is 4,000ms");

  const delayRetryHeader = calculatePollDelay(0, 10, false);
  ok(delayRetryHeader === 10000, "honors Retry-After header of 10s (10,000ms)");

  const delayFail1 = calculatePollDelay(1, null, false);
  ok(delayFail1 === 4000, "attempt 1 backoff is 4,000ms");

  const delayFail2 = calculatePollDelay(2, null, false);
  ok(delayFail2 === 8000, "attempt 2 backoff is 8,000ms");

  const delayFail3 = calculatePollDelay(3, null, false);
  ok(delayFail3 === 16000, "attempt 3 backoff is 16,000ms");

  const delayFail4 = calculatePollDelay(4, null, false);
  ok(delayFail4 === 30000, "attempt 4 backoff capped at 30,000ms");

  const delayJitter = calculatePollDelay(0, null, true);
  ok(delayJitter >= 3400 && delayJitter <= 4600, "jitter applied within ±15% (3,400ms - 4,600ms)");

  // 2. Terminal State Decision
  ok(isTerminalJobStatus("COMPLETED"), "COMPLETED recognized as terminal");
  ok(isTerminalJobStatus("FAILED"), "FAILED recognized as terminal");
  ok(isTerminalJobStatus("CANCELLED"), "CANCELLED recognized as terminal");
  ok(!isTerminalJobStatus("PENDING"), "PENDING recognized as non-terminal");
  ok(!isTerminalJobStatus("PROCESSING"), "PROCESSING recognized as non-terminal");

  // 3. Client State Machine Progression
  let mockFetchCallCount = 0;
  const mockFetch = async (url: string, init: any): Promise<Response> => {
    mockFetchCallCount++;
    const urlStr = String(url);

    if (urlStr.includes("/api/generations/video") && init.method === "POST") {
      return new Response(
        JSON.stringify({
          job: { id: "vjob-client-1", status: "PROCESSING", prompt: "A robot painting", settings: { aspectRatio: "16:9" }, creditsCharged: 0, estimatedCredits: 10, createdAt: new Date().toISOString() },
          asset: null,
          replayed: false,
          balance: 90,
        }),
        { status: 202, headers: { "Content-Type": "application/json", "Retry-After": "1" } },
      );
    }

    if (urlStr.includes("/api/generations/video/vjob-client-1") && init.method === "GET") {
      // First poll returns PROCESSING; second poll returns COMPLETED
      if (mockFetchCallCount === 2) {
        return new Response(
          JSON.stringify({
            job: { id: "vjob-client-1", status: "PROCESSING", prompt: "A robot painting", settings: { aspectRatio: "16:9" }, creditsCharged: 0, estimatedCredits: 10, createdAt: new Date().toISOString() },
            asset: null,
            replayed: false,
            balance: 90,
          }),
          { status: 200, headers: { "Content-Type": "application/json", "Retry-After": "1" } },
        );
      }
      return new Response(
        JSON.stringify({
          job: { id: "vjob-client-1", status: "COMPLETED", prompt: "A robot painting", settings: { aspectRatio: "16:9" }, creditsCharged: 10, estimatedCredits: 10, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
          asset: { id: "asset-1", videoUrl: "https://signed.supabase.test/v.mp4", thumbnailUrl: null, durationSeconds: 5, width: 1280, height: 720, mimeType: "video/mp4", sizeBytes: 19190 },
          replayed: false,
          balance: 90,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(null, { status: 404 });
  };

  const stateHistory: string[] = [];
  const controller = new VideoGenerationController({
    fetchImpl: mockFetch as any,
    sleep: async () => {}, // Instant sleep for testing
  });

  controller.subscribe((s) => stateHistory.push(s.phase));

  ok(controller.getState().phase === "idle", "initial state is 'idle'");

  await controller.submit({ prompt: "A robot painting a mural" });

  ok(stateHistory.includes("submitting"), "transitions to 'submitting' during POST");
  ok(stateHistory.includes("polling"), "transitions to 'polling' upon receiving HTTP 202 Accepted");

  // Wait for the simulated instant polling loop to finish
  await new Promise((r) => setTimeout(r, 50));

  ok(controller.getState().phase === "completed", "terminates in 'completed' state");
  const finalState = controller.getState();
  if (finalState.phase === "completed") {
    ok(finalState.asset?.videoUrl === "https://signed.supabase.test/v.mp4", "completed state holds signed asset URL");
  }

  // 4. Abort & Stop does NOT cancel server job
  const stopController = new VideoGenerationController({
    fetchImpl: (async () => new Promise(() => {})) as any, // Hanging fetch
  });
  stopController.submit({ prompt: "A space shuttle launch" });
  ok(stopController.getState().phase === "submitting", "submit is in flight");
  stopController.stop();
  ok(stopController.getState().phase === "idle", "stop() aborts fetch and transitions to idle without calling server cancel");

  // 5. Unauthenticated session stops polling
  let sessionExpiredCalled = false;
  const unauthController = new VideoGenerationController({
    fetchImpl: (async () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), { status: 401 })) as any,
    onUnauthenticated: () => { sessionExpiredCalled = true; },
  });
  await unauthController.submit({ prompt: "Testing unauth session" });
  ok(unauthController.getState().phase === "failed", "unauthenticated response sets phase to 'failed'");
  ok(sessionExpiredCalled, "onUnauthenticated callback triggered on HTTP 401");

  // 6. Controller cleanup on destroy
  controller.destroy();
  stopController.destroy();
  unauthController.destroy();
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
