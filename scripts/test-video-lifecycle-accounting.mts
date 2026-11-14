// Stage 8, Batch 2A: Database Schema, Lifecycle State Machine, Ingestion Leases & Credit Accounting
//
// Fully offline: NO network access, NO real API credentials, NO live production database.
// Global fetch throws; database operations run against a high-fidelity transactional in-memory harness.
//
// Run: npm run test:video-lifecycle

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  throw new Error("Network access is strictly forbidden in video lifecycle unit tests");
}) as typeof fetch;

const {
  DEFAULT_DAILY_USER_VIDEO_LIMIT,
  DEFAULT_VIDEO_CREDIT_COST,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_PROVIDER,
  DEFAULT_VIDEO_SETTINGS,
  PROVISIONAL_PAID_DAILY_VIDEO_LIMIT,
  PROVISIONAL_QA_DAILY_VIDEO_LIMIT,
  VIDEO_INGESTION_LEASE_MS,
  VIDEO_PENDING_STALE_MS,
  VIDEO_PROCESSING_STALE_MS,
} = await import("@/features/video/config");

const {
  JobNotCompletableError,
  cancelVideoJob,
  claimVideoIngestionLease,
  completeVideoJobWithAsset,
  countDailyVideoJobs,
  createVideoJob,
  failVideoJob,
  markVideoJobStarted,
  reconcileStaleVideoJobs,
  recordVideoProviderResult,
  validateVideoRequestInput,
} = await import("@/features/video/lifecycle");

const { jobDebitKey, jobRefundKey } = await import("@/features/credits/ledger");
const { AccountingError } = await import("@/features/generations/errors");
const { AssetType, GenerationStatus, GenerationType } = await import("@/generated/prisma/client");

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
const section = (s: string) => console.log(`\n# ${s}`);

// ===========================================================================
// Section 1: Prisma Schema & Ingestion Lease Consistency Inspection
// ===========================================================================
section("Section 1: Prisma Schema & Ingestion Lease Consistency Inspection");

const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
const schemaContent = readFileSync(schemaPath, "utf-8");

ok(
  schemaContent.includes("ingestionToken          String?") &&
    schemaContent.includes("ingestionLeaseExpiresAt DateTime?"),
  "Prisma schema defines ingestionToken and ingestionLeaseExpiresAt on GenerationJob"
);

ok(
  schemaContent.includes("durationSeconds Float?") &&
    schemaContent.includes("thumbnailKey    String?"),
  "Prisma schema defines durationSeconds and thumbnailKey on GeneratedAsset"
);

ok(
  schemaContent.includes("@@index([status, ingestionLeaseExpiresAt])"),
  "Prisma schema indexes [status, ingestionLeaseExpiresAt] on GenerationJob for fast sweep queries"
);

const migrationPath = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20261111083000_add_video_generation_fields",
  "migration.sql"
);
const migrationContent = readFileSync(migrationPath, "utf-8");

ok(
  migrationContent.includes('ALTER TABLE "GenerationJob" ADD COLUMN "ingestionToken" TEXT;') &&
    migrationContent.includes('ALTER TABLE "GenerationJob" ADD COLUMN "ingestionLeaseExpiresAt" TIMESTAMP(3);'),
  "Migration SQL adds nullable ingestionToken and ingestionLeaseExpiresAt columns"
);

ok(
  migrationContent.includes('ALTER TABLE "GeneratedAsset" ADD COLUMN "durationSeconds" DOUBLE PRECISION;') &&
    migrationContent.includes('ALTER TABLE "GeneratedAsset" ADD COLUMN "thumbnailKey" TEXT;'),
  "Migration SQL adds nullable durationSeconds and thumbnailKey columns"
);

ok(
  migrationContent.includes('CREATE INDEX "GenerationJob_status_ingestionLeaseExpiresAt_idx"'),
  "Migration SQL creates index on GenerationJob(status, ingestionLeaseExpiresAt)"
);

// Verify exact two-state CHECK constraint in migration SQL
ok(
  migrationContent.includes('ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_ingestion_lease_consistency"') &&
    migrationContent.includes('("ingestionToken" IS NULL AND "ingestionLeaseExpiresAt" IS NULL)') &&
    migrationContent.includes('("ingestionToken" IS NOT NULL AND "ingestionLeaseExpiresAt" IS NOT NULL)'),
  "Migration SQL enforces exact two-state lease consistency: both NULL or both NOT NULL"
);

ok(
  migrationContent.includes('ALTER TABLE "GeneratedAsset" ADD CONSTRAINT "GeneratedAsset_duration_positive"') &&
    migrationContent.includes('CHECK ("durationSeconds" IS NULL OR "durationSeconds" > 0)'),
  "Migration SQL enforces duration integrity: durationSeconds must be strictly positive"
);

// Symmetrical two-state lease consistency invariant tests
function satisfiesIngestionLeaseConsistency(token: unknown, expiresAt: unknown): boolean {
  const tokenNull = token === null || token === undefined;
  const expiryNull = expiresAt === null || expiresAt === undefined;
  return (tokenNull && expiryNull) || (!tokenNull && !expiryNull);
}

ok(
  satisfiesIngestionLeaseConsistency(null, null) === true,
  "Lease consistency: (null, null) evaluates to valid (no lease held)"
);
ok(
  satisfiesIngestionLeaseConsistency("token-uuid-1", new Date()) === true,
  "Lease consistency: (token, expiry) evaluates to valid (active bounded lease)"
);
ok(
  satisfiesIngestionLeaseConsistency("token-uuid-1", null) === false,
  "Lease consistency: (token, null) evaluates to invalid (prevents unreclaimable lease)"
);
ok(
  satisfiesIngestionLeaseConsistency(null, new Date()) === false,
  "Lease consistency: (null, expiry) evaluates to invalid (prevents expiry without token)"
);

// Verify global one_active_per_user partial index in baseline migration applies across all job types
const baselinePipelineMigrationPath = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20261109064509_image_generation_pipeline",
  "migration.sql"
);
const baselineContent = readFileSync(baselinePipelineMigrationPath, "utf-8");
ok(
  baselineContent.includes('CREATE UNIQUE INDEX "GenerationJob_one_active_per_user"') &&
    baselineContent.includes('ON "GenerationJob" ("userId")') &&
    baselineContent.includes("WHERE \"status\" IN ('PENDING', 'PROCESSING')"),
  "Existing GenerationJob_one_active_per_user unique index is unpartitioned by type (protects IMAGE and VIDEO concurrently)"
);

// ===========================================================================
// Section 2: Input Validation & Guardrails
// ===========================================================================
section("Section 2: Input Validation & Guardrails");

const validReq = validateVideoRequestInput({
  prompt: "A drone flying over a misty pine forest at sunrise",
  aspectRatio: "16:9",
  duration: 5,
  resolution: "720p",
  fps: 16,
  idempotencyKey: "idem-valid-1",
});
ok(
  validReq.prompt === "A drone flying over a misty pine forest at sunrise" &&
    validReq.settings.aspectRatio === "16:9" &&
    validReq.settings.duration === 5 &&
    validReq.settings.resolution === "720p" &&
    validReq.settings.fps === 16 &&
    validReq.idempotencyKey === "idem-valid-1",
  "validateVideoRequestInput correctly parses and returns valid request"
);

// Default fallback values
const defaultReq = validateVideoRequestInput({
  prompt: "Default settings video prompt",
  idempotencyKey: "idem-default-1",
});
ok(
  defaultReq.settings.aspectRatio === "16:9" &&
    defaultReq.settings.duration === 5 &&
    defaultReq.settings.resolution === "720p" &&
    defaultReq.settings.fps === 16,
  "validateVideoRequestInput populates default 16:9, 5s, 720p, 16fps settings"
);

// Validation errors
let promptEmptyFailed = false;
try {
  validateVideoRequestInput({ prompt: "   ", idempotencyKey: "k1" });
} catch (err) {
  if (err instanceof AccountingError && err.code === "INVALID_INPUT") {
    promptEmptyFailed = true;
  }
}
ok(promptEmptyFailed, "validateVideoRequestInput rejects empty/whitespace prompt");

let promptTooLongFailed = false;
try {
  validateVideoRequestInput({ prompt: "a".repeat(2049), idempotencyKey: "k1" });
} catch (err) {
  if (err instanceof AccountingError && err.code === "INVALID_INPUT") {
    promptTooLongFailed = true;
  }
}
ok(promptTooLongFailed, "validateVideoRequestInput rejects prompt > 2048 chars");

let badAspectFailed = false;
try {
  validateVideoRequestInput({ prompt: "A car", aspectRatio: "4:3", idempotencyKey: "k1" });
} catch (err) {
  if (err instanceof AccountingError && err.code === "INVALID_INPUT") {
    badAspectFailed = true;
  }
}
ok(badAspectFailed, "validateVideoRequestInput rejects unsupported aspect ratio (4:3)");

let badDurationFailed = false;
try {
  validateVideoRequestInput({ prompt: "A car", duration: 10, idempotencyKey: "k1" });
} catch (err) {
  if (err instanceof AccountingError && err.code === "INVALID_INPUT") {
    badDurationFailed = true;
  }
}
ok(badDurationFailed, "validateVideoRequestInput rejects unsupported duration (10s)");

let badResolutionFailed = false;
try {
  validateVideoRequestInput({ prompt: "A car", resolution: "1080p", idempotencyKey: "k1" });
} catch (err) {
  if (err instanceof AccountingError && err.code === "INVALID_INPUT") {
    badResolutionFailed = true;
  }
}
ok(badResolutionFailed, "validateVideoRequestInput rejects unsupported resolution (1080p)");

let badFpsFailed = false;
try {
  validateVideoRequestInput({ prompt: "A car", fps: 60, idempotencyKey: "k1" });
} catch (err) {
  if (err instanceof AccountingError && err.code === "INVALID_INPUT") {
    badFpsFailed = true;
  }
}
ok(badFpsFailed, "validateVideoRequestInput rejects unsupported fps (60fps)");

let missingIdemFailed = false;
try {
  validateVideoRequestInput({ prompt: "A car", idempotencyKey: "" });
} catch (err) {
  if (err instanceof AccountingError && err.code === "INVALID_INPUT") {
    missingIdemFailed = true;
  }
}
ok(missingIdemFailed, "validateVideoRequestInput rejects empty idempotency key");

// ===========================================================================
// Section 3: High-Fidelity Transactional DB Simulator Harness
// ===========================================================================
section("Section 3: Transactional Lifecycle & Ingestion State Machine");

interface MockDbState {
  users: Map<string, { id: string; email: string; emailVerified: boolean | Date | null }>;
  wallets: Map<string, { id: string; userId: string; balance: number }>;
  transactions: Map<string, { id: string; userId: string; walletId: string; jobId?: string; type: string; amount: number; balanceAfter: number; idempotencyKey: string; description?: string }>;
  jobs: Map<string, {
    id: string;
    userId: string;
    type: string;
    status: string;
    prompt: string | null;
    provider: string | null;
    providerJobId: string | null;
    model: string | null;
    settings: any;
    estimatedCredits: number;
    chargedCredits: number;
    errorMessage: string | null;
    idempotencyKey: string | null;
    ingestionToken: string | null;
    ingestionLeaseExpiresAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    updatedAt: Date;
  }>;
  assets: Map<string, {
    id: string;
    userId: string;
    jobId: string;
    type: string;
    storageKey: string;
    thumbnailKey: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    mimeType: string | null;
    fileSize: bigint | null;
    createdAt: Date;
  }>;
}

function createMockDb(): { db: any; state: MockDbState } {
  const state: MockDbState = {
    users: new Map(),
    wallets: new Map(),
    transactions: new Map(),
    jobs: new Map(),
    assets: new Map(),
  };

  let idCounter = 1;
  const genId = (p: string) => `${p}_${idCounter++}`;

  const userLockQueues = new Map<string, Promise<void>>();

  const client = {
    $transaction: async <T,>(fn: (tx: any) => Promise<T>): Promise<T> => {
      let activeRelease: (() => void) | undefined;
      const txClient = {
        ...client,
        $queryRaw: async (query: any, ...args: any[]): Promise<any[]> => {
          let sql = "";
          let values = args;
          if (query && typeof query === "object" && "strings" in query && "values" in query) {
            sql = query.strings.join("?");
            values = query.values;
          } else if (Array.isArray(query)) {
            sql = query.join("?");
            values = args;
          } else {
            sql = String(query);
          }
          const p = values;

          // 1. SELECT "id" FROM "User" WHERE "id" = ... FOR UPDATE
          if (sql.includes('SELECT "id" FROM "User"')) {
            const userId = p[0];
            const user = state.users.get(userId);
            if (!user) return [];

            // Simulate PostgreSQL FOR UPDATE row lock queue
            const priorLock = userLockQueues.get(userId);
            let resolveLock!: () => void;
            const myLock = new Promise<void>((r) => {
              resolveLock = r;
            });
            activeRelease = resolveLock;
            userLockQueues.set(userId, myLock);

            if (priorLock) {
              await priorLock;
            }

            return [{ id: user.id }];
          }

          // Forward to general query handler
          return (client as any).$queryRaw(query, ...args);
        },
      };

      try {
        return await fn(txClient);
      } finally {
        if (activeRelease) {
          activeRelease();
        }
      }
    },

    $queryRaw: async (query: any, ...args: any[]): Promise<any[]> => {
      let sql = "";
      let values = args;
      if (query && typeof query === "object" && "strings" in query && "values" in query) {
        sql = query.strings.join("?");
        values = query.values;
      } else if (Array.isArray(query)) {
        sql = query.join("?");
        values = args;
      } else {
        sql = String(query);
      }
      const p = values;

      // 1. SELECT "id" FROM "User" WHERE "id" = ... FOR UPDATE
      if (sql.includes('SELECT "id" FROM "User"')) {
        const userId = p[0];
        const user = state.users.get(userId);
        return user ? [{ id: user.id }] : [];
      }

      // 2. UPDATE "CreditWallet" SET "balance" = "balance" - ...
      if (sql.includes('UPDATE "CreditWallet"') && sql.includes('"balance" -')) {
        const amount = p[0];
        const userId = p[1];
        const wallet = Array.from(state.wallets.values()).find((w) => w.userId === userId);
        if (!wallet || wallet.balance < amount) {
          return [];
        }
        wallet.balance -= amount;
        return [{ id: wallet.id, balance: wallet.balance }];
      }

      // 3. UPDATE "CreditWallet" SET "balance" = "balance" + ...
      if (sql.includes('UPDATE "CreditWallet"') && sql.includes('"balance" +')) {
        const amount = p[0];
        const userId = p[1];
        const wallet = Array.from(state.wallets.values()).find((w) => w.userId === userId);
        if (!wallet) {
          return [];
        }
        wallet.balance += amount;
        return [{ id: wallet.id, balance: wallet.balance }];
      }

      // 4. claimVideoIngestionLease: SET "ingestionToken" = ...
      if (sql.includes('UPDATE "GenerationJob"') && sql.includes('SET "ingestionToken" =')) {
        const token = p[0];
        const leaseMs = p[1];
        const jobId = p[2];
        const job = state.jobs.get(jobId);
        if (!job || job.status !== "PROCESSING") {
          return [];
        }
        const now = new Date();
        const leaseExpired = !job.ingestionLeaseExpiresAt || job.ingestionLeaseExpiresAt.getTime() < now.getTime();
        const canClaim = !job.ingestionToken || leaseExpired;
        if (!canClaim) {
          return [];
        }
        job.ingestionToken = token;
        job.ingestionLeaseExpiresAt = new Date(now.getTime() + leaseMs);
        job.updatedAt = now;

        // Enforce CHECK constraint
        if (!satisfiesIngestionLeaseConsistency(job.ingestionToken, job.ingestionLeaseExpiresAt)) {
          throw new Error("CHECK constraint violation: GenerationJob_ingestion_lease_consistency");
        }

        return [{ id: job.id, userId: job.userId, ingestionToken: job.ingestionToken, ingestionLeaseExpiresAt: job.ingestionLeaseExpiresAt }];
      }

      // 5. recordVideoProviderResult
      if (sql.includes('UPDATE "GenerationJob"') && sql.includes('jsonb_set')) {
        const payloadStr = p[0];
        const jobId = p[1];
        const job = state.jobs.get(jobId);
        if (!job || job.status !== "PROCESSING") {
          return [];
        }
        job.settings = { ...job.settings, providerResult: JSON.parse(payloadStr) };
        job.updatedAt = new Date();
        return [{ id: job.id }];
      }

      // 6. completeVideoJobWithAsset guarded transition: SET "status" = 'COMPLETED'
      if (sql.includes('UPDATE "GenerationJob"') && sql.includes("SET \"status\" = 'COMPLETED'")) {
        const jobId = p[0];
        const token = p[1];
        const job = state.jobs.get(jobId);
        if (!job || job.status !== "PROCESSING" || job.ingestionToken !== token) {
          return [];
        }
        job.status = "COMPLETED";
        job.chargedCredits = job.estimatedCredits;
        // Atomic lease cleanup
        job.ingestionToken = null;
        job.ingestionLeaseExpiresAt = null;
        job.completedAt = new Date();
        job.updatedAt = new Date();

        // Enforce CHECK constraint
        if (!satisfiesIngestionLeaseConsistency(job.ingestionToken, job.ingestionLeaseExpiresAt)) {
          throw new Error("CHECK constraint violation: GenerationJob_ingestion_lease_consistency");
        }

        return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits }];
      }

      // 7. failVideoJob guarded transition: SET "status" = 'FAILED'
      if (sql.includes('UPDATE "GenerationJob"') && sql.includes("SET \"status\" = 'FAILED'")) {
        const reason = p[0];
        const jobId = p[1];
        const job = state.jobs.get(jobId);
        if (!job || (job.status !== "PENDING" && job.status !== "PROCESSING")) {
          return [];
        }
        job.status = "FAILED";
        job.errorMessage = reason;
        // Atomic lease cleanup
        job.ingestionToken = null;
        job.ingestionLeaseExpiresAt = null;
        job.completedAt = new Date();
        job.updatedAt = new Date();

        // Enforce CHECK constraint
        if (!satisfiesIngestionLeaseConsistency(job.ingestionToken, job.ingestionLeaseExpiresAt)) {
          throw new Error("CHECK constraint violation: GenerationJob_ingestion_lease_consistency");
        }

        return [{ id: job.id }];
      }

      // 8. cancelVideoJob guarded transition: SET "status" = 'CANCELLED'
      if (sql.includes('UPDATE "GenerationJob"') && sql.includes("SET \"status\" = 'CANCELLED'")) {
        const reason = p[0];
        const jobId = p[1];
        const job = state.jobs.get(jobId);
        if (!job || (job.status !== "PENDING" && job.status !== "PROCESSING")) {
          return [];
        }
        job.status = "CANCELLED";
        job.errorMessage = reason;
        // Atomic lease cleanup
        job.ingestionToken = null;
        job.ingestionLeaseExpiresAt = null;
        job.completedAt = new Date();
        job.updatedAt = new Date();

        // Enforce CHECK constraint
        if (!satisfiesIngestionLeaseConsistency(job.ingestionToken, job.ingestionLeaseExpiresAt)) {
          throw new Error("CHECK constraint violation: GenerationJob_ingestion_lease_consistency");
        }

        return [{ id: job.id }];
      }

      return [];
    },

    generationJob: {
      findUnique: async ({ where }: any) => {
        if (where?.id) return state.jobs.get(where.id) ?? null;
        if (where?.userId_idempotencyKey) {
          const { userId, idempotencyKey } = where.userId_idempotencyKey;
          return (
            Array.from(state.jobs.values()).find(
              (j) => j.userId === userId && j.idempotencyKey === idempotencyKey
            ) ?? null
          );
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        return (
          Array.from(state.jobs.values()).find((j) => {
            if (where.userId && j.userId !== where.userId) return false;
            if (where.status?.in && !where.status.in.includes(j.status)) return false;
            return true;
          }) ?? null
        );
      },
      findMany: async ({ where, take }: any) => {
        const results = Array.from(state.jobs.values()).filter((j) => {
          if (where.userId && j.userId !== where.userId) return false;
          if (where.type && j.type !== where.type) return false;
          if (where.status && j.status !== where.status) return false;
          if (where.createdAt?.lt && j.createdAt >= where.createdAt.lt) return false;
          if (where.startedAt?.lt && (!j.startedAt || j.startedAt >= where.startedAt.lt)) return false;
          return true;
        });
        return take ? results.slice(0, take) : results;
      },
      count: async ({ where }: any) => {
        return Array.from(state.jobs.values()).filter((j) => {
          if (where.userId && j.userId !== where.userId) return false;
          if (where.type && j.type !== where.type) return false;
          if (where.status?.in && !where.status.in.includes(j.status)) return false;
          if (where.createdAt?.gte && j.createdAt < where.createdAt.gte) return false;
          if (where.createdAt?.lt && j.createdAt >= where.createdAt.lt) return false;
          return true;
        }).length;
      },
      create: async ({ data }: any) => {
        // Enforce @@unique([userId, idempotencyKey])
        if (data.idempotencyKey) {
          const duplicate = Array.from(state.jobs.values()).find(
            (j) => j.userId === data.userId && j.idempotencyKey === data.idempotencyKey
          );
          if (duplicate) {
            const err: any = new Error("Unique constraint failed on userId_idempotencyKey");
            err.code = "P2002";
            err.message = "Unique constraint failed on the fields: (`userId`,`idempotencyKey`)";
            throw err;
          }
        }

        const id = genId("job");
        const job = {
          id,
          userId: data.userId,
          type: data.type,
          status: data.status,
          prompt: data.prompt ?? null,
          provider: data.provider ?? null,
          providerJobId: data.providerJobId ?? null,
          model: data.model ?? null,
          settings: data.settings,
          estimatedCredits: data.estimatedCredits ?? 0,
          chargedCredits: data.chargedCredits ?? 0,
          errorMessage: data.errorMessage ?? null,
          idempotencyKey: data.idempotencyKey ?? null,
          ingestionToken: null,
          ingestionLeaseExpiresAt: null,
          createdAt: data.createdAt ?? new Date(),
          startedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        };
        state.jobs.set(id, job);
        return job;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const job of state.jobs.values()) {
          if (where.id && job.id !== where.id) continue;
          if (where.status && job.status !== where.status) continue;
          Object.assign(job, data);
          job.updatedAt = new Date();
          count++;
        }
        return { count };
      },
    },

    creditTransaction: {
      findUnique: async ({ where }: any) => {
        if (where.idempotencyKey) {
          return (
            Array.from(state.transactions.values()).find(
              (t) => t.idempotencyKey === where.idempotencyKey
            ) ?? null
          );
        }
        return null;
      },
      create: async ({ data }: any) => {
        if (state.transactions.has(data.idempotencyKey)) {
          throw new Error(`Unique constraint failed on idempotencyKey: ${data.idempotencyKey}`);
        }
        const id = genId("tx");
        const txRecord = { id, ...data };
        state.transactions.set(data.idempotencyKey, txRecord);
        return txRecord;
      },
    },

    generatedAsset: {
      create: async ({ data }: any) => {
        const id = data.id ?? genId("asset");
        const asset = { id, ...data };
        state.assets.set(id, asset);
        return asset;
      },
    },
  };

  return { db: client, state };
}

// Setup test users & wallets
const { db: mockPrisma, state: mockState } = createMockDb();

const qaUser = { id: "cuser_qa_100", email: "qa@pixora.test", emailVerified: true };
const promoUser = { id: "cuser_promo_200", email: "promo@pixora.test", emailVerified: true };
const poorUser = { id: "cuser_poor_300", email: "poor@pixora.test", emailVerified: true };

mockState.users.set(qaUser.id, qaUser);
mockState.users.set(promoUser.id, promoUser);
mockState.users.set(poorUser.id, poorUser);

mockState.wallets.set("w_qa", { id: "w_qa", userId: qaUser.id, balance: 100 });
mockState.wallets.set("w_promo", { id: "w_promo", userId: promoUser.id, balance: 100 });
mockState.wallets.set("w_poor", { id: "w_poor", userId: poorUser.id, balance: 5 }); // Insufficient balance

// 1. Initial State: PENDING -> PROCESSING -> Lease Claim -> COMPLETED
const testJobId = "job_test_lifecycle_1";
const initialJob = {
  id: testJobId,
  userId: qaUser.id,
  type: GenerationType.VIDEO,
  status: GenerationStatus.PENDING,
  prompt: "A drone shot of turquoise ocean waves",
  provider: DEFAULT_VIDEO_PROVIDER,
  providerJobId: null,
  model: DEFAULT_VIDEO_MODEL,
  settings: { aspectRatio: "16:9", duration: 5, resolution: "720p", fps: 16, creditCost: 10 },
  estimatedCredits: 10,
  chargedCredits: 0,
  errorMessage: null,
  idempotencyKey: "idem_lifecycle_1",
  ingestionToken: null,
  ingestionLeaseExpiresAt: null,
  createdAt: new Date(),
  startedAt: null,
  completedAt: null,
  updatedAt: new Date(),
};
mockState.jobs.set(testJobId, initialJob);

// markVideoJobStarted: PENDING -> PROCESSING
const started = await markVideoJobStarted(
  {
    jobId: testJobId,
    providerJobId: "fal-vjob-123",
    provider: DEFAULT_VIDEO_PROVIDER,
    model: DEFAULT_VIDEO_MODEL,
  },
  mockPrisma
);
ok(started === true, "markVideoJobStarted successfully transitions PENDING -> PROCESSING");

const afterStart = mockState.jobs.get(testJobId);
ok(
  afterStart?.status === GenerationStatus.PROCESSING &&
    afterStart.providerJobId === "fal-vjob-123" &&
    afterStart.startedAt !== null,
  "Job record accurately updated with status PROCESSING, providerJobId, and startedAt"
);

// Second markVideoJobStarted should fail (status is already PROCESSING)
const repeatStart = await markVideoJobStarted({ jobId: testJobId, providerJobId: "fal-vjob-123" }, mockPrisma);
ok(repeatStart === false, "markVideoJobStarted is strictly idempotent (returns false when job not PENDING)");

// Fast-ACK Provider Result recording
const recordedPayload = { videoUrl: "https://fal.media/files/monkey/sample.mp4", duration: 5 };
const recordedOk = await recordVideoProviderResult(testJobId, recordedPayload, mockPrisma);
ok(recordedOk === true, "recordVideoProviderResult successfully writes providerResult into settings");
ok(
  mockState.jobs.get(testJobId)?.settings.providerResult.videoUrl === "https://fal.media/files/monkey/sample.mp4",
  "Provider result payload accurately preserved in job settings JSONB"
);

// Atomic Ingestion Lease Claim (Winner vs Loser)
const lease1 = await claimVideoIngestionLease({ jobId: testJobId }, mockPrisma);
ok(lease1.claimed === true && typeof lease1.token === "string", "First worker successfully claims ingestion lease");

const lease2 = await claimVideoIngestionLease({ jobId: testJobId }, mockPrisma);
ok(
  lease2.claimed === false && lease2.reason === "already_claimed_or_not_processing",
  "Concurrent worker attempting to claim held lease is rejected"
);

// Expired lease recovery
const jobForExpiry = mockState.jobs.get(testJobId)!;
jobForExpiry.ingestionLeaseExpiresAt = new Date(Date.now() - 1000); // Backdate lease to past

const recoveredLease = await claimVideoIngestionLease({ jobId: testJobId, customToken: "recovered-token-xyz" }, mockPrisma);
ok(
  recoveredLease.claimed === true && recoveredLease.token === "recovered-token-xyz",
  "Worker successfully re-claims expired ingestion lease (crash recovery)"
);

// Guarded Completion with Asset and Atomic Lease Cleanup
const completeRes = await completeVideoJobWithAsset(
  {
    jobId: testJobId,
    ingestionToken: "recovered-token-xyz",
    asset: {
      userId: qaUser.id,
      assetId: "asset_test_001",
      storageKey: `users/${qaUser.id}/videos/${testJobId}/asset_test_001.mp4`,
      thumbnailKey: `users/${qaUser.id}/videos/${testJobId}/asset_test_001-thumb.webp`,
      width: 1280,
      height: 720,
      durationSeconds: 5.0,
      sizeBytes: 15_000_000,
    },
  },
  mockPrisma
);

ok(completeRes.jobId === testJobId && completeRes.assetId === "asset_test_001", "completeVideoJobWithAsset returns completed IDs");

const finalJob = mockState.jobs.get(testJobId)!;
ok(
  finalJob.status === GenerationStatus.COMPLETED &&
    finalJob.chargedCredits === 10 &&
    finalJob.completedAt !== null,
  "Job status is COMPLETED with chargedCredits = 10"
);

ok(
  finalJob.ingestionToken === null && finalJob.ingestionLeaseExpiresAt === null,
  "Atomic lease cleanup: ingestionToken and ingestionLeaseExpiresAt cleared to NULL on COMPLETED"
);

const createdAsset = mockState.assets.get("asset_test_001")!;
ok(
  createdAsset.type === AssetType.VIDEO &&
    createdAsset.durationSeconds === 5.0 &&
    createdAsset.thumbnailKey?.includes("-thumb.webp") === true &&
    createdAsset.storageKey.endsWith(".mp4"),
  "GeneratedAsset record created with type VIDEO, durationSeconds, thumbnailKey and storageKey"
);

// Mismatched token or already completed completion attempt must fail
let badTokenCompleteFailed = false;
try {
  await completeVideoJobWithAsset(
    {
      jobId: testJobId,
      ingestionToken: "stale-or-wrong-token",
      asset: {
        userId: qaUser.id,
        assetId: "asset_bad_002",
        storageKey: "...",
        width: 1280,
        height: 720,
        durationSeconds: 5,
        sizeBytes: 100,
      },
    },
    mockPrisma
  );
} catch (err) {
  if (err instanceof JobNotCompletableError) {
    badTokenCompleteFailed = true;
  }
}
ok(badTokenCompleteFailed, "completeVideoJobWithAsset rejects wrong/stale ingestion token");

// ===========================================================================
// Section 4: Dynamic Credit Accounting (Non-Hardcoded 17 Credits Test)
// ===========================================================================
section("Section 4: Dynamic Credit Accounting (Non-Hardcoded 17 Credits Test)");

ok(jobDebitKey("job_123") === "job-debit:job_123", "jobDebitKey format is job-debit:<jobId>");
ok(jobRefundKey("job_123") === "job-refund:job_123", "jobRefundKey format is job-refund:<jobId>");

// Create a job with arbitrary creditCost (17 credits) to verify zero hardcoding
mockState.wallets.get("w_qa")!.balance = 100;
const job17Res = await createVideoJob(
  {
    userId: qaUser.id,
    user: qaUser,
    prompt: "A cinematic 17-credit video generation",
    idempotencyKey: "idem_17_credits_1",
  },
  { creditCost: 17, allowlistRaw: qaUser.email },
  mockPrisma
);

ok(job17Res.job.estimatedCredits === 17, "createVideoJob assigns estimatedCredits = 17 dynamically");
ok(
  mockState.wallets.get("w_qa")!.balance === 83,
  "Wallet debited by exactly 17 credits (100 - 17 = 83)"
);

const debit17Tx = mockState.transactions.get(jobDebitKey(job17Res.job.id))!;
ok(
  debit17Tx !== undefined && debit17Tx.amount === -17 && debit17Tx.balanceAfter === 83,
  "CreditTransaction record created with amount: -17"
);

// Start and claim lease on 17-credit job
await markVideoJobStarted({ jobId: job17Res.job.id, providerJobId: "fal-17-001" }, mockPrisma);
const lease17 = await claimVideoIngestionLease({ jobId: job17Res.job.id }, mockPrisma);
ok(lease17.claimed === true && typeof lease17.token === "string", "Lease claimed on 17-credit job");

// Complete 17-credit job: chargedCredits must equal exactly 17
await completeVideoJobWithAsset(
  {
    jobId: job17Res.job.id,
    ingestionToken: lease17.token!,
    asset: {
      userId: qaUser.id,
      assetId: "asset_17_001",
      storageKey: `users/${qaUser.id}/videos/${job17Res.job.id}/v.mp4`,
      width: 1280,
      height: 720,
      durationSeconds: 5,
      sizeBytes: 1000,
    },
  },
  mockPrisma
);

const completed17Job = mockState.jobs.get(job17Res.job.id)!;
ok(
  completed17Job.status === GenerationStatus.COMPLETED && completed17Job.chargedCredits === 17,
  "Completion settlement records chargedCredits = 17 (derived from estimatedCredits, not hardcoded)"
);
ok(
  completed17Job.ingestionToken === null && completed17Job.ingestionLeaseExpiresAt === null,
  "Lease cleared to NULL on 17-credit completion"
);
ok(
  mockState.transactions.get(jobRefundKey(job17Res.job.id)) === undefined,
  "Completed 17-credit job has NO refund transaction"
);

// Test Dynamic Refund with 17 credits
const job17FailRes = await createVideoJob(
  {
    userId: qaUser.id,
    user: qaUser,
    prompt: "A failing 17-credit video generation",
    idempotencyKey: "idem_17_credits_fail",
  },
  { creditCost: 17, allowlistRaw: qaUser.email },
  mockPrisma
);
ok(mockState.wallets.get("w_qa")!.balance === 66, "Wallet debited second 17 credits (83 - 17 = 66)");

// Fail the 17-credit job: refund must be derived from the debit record (+17)
const fail17Res = await failVideoJob(job17FailRes.job.id, "Provider failed upstream", mockPrisma);
ok(fail17Res.settled === true, "failVideoJob settled the 17-credit job");
ok(
  fail17Res.refund?.refunded === true && fail17Res.refund.amount === 17,
  "failVideoJob derived exact refund amount from debit ledger (+17 credits, not hardcoded)"
);
ok(
  mockState.wallets.get("w_qa")!.balance === 83,
  "Wallet balance restored by exactly +17 credits (66 + 17 = 83)"
);

const failed17Job = mockState.jobs.get(job17FailRes.job.id)!;
ok(
  failed17Job.status === GenerationStatus.FAILED &&
    failed17Job.ingestionToken === null &&
    failed17Job.ingestionLeaseExpiresAt === null,
  "Lease fields cleared to NULL on FAILED job"
);

// Test Cancellation with 17 credits
const job17CancelRes = await createVideoJob(
  {
    userId: qaUser.id,
    user: qaUser,
    prompt: "A cancelled 17-credit video generation",
    idempotencyKey: "idem_17_credits_cancel",
  },
  { creditCost: 17, allowlistRaw: qaUser.email },
  mockPrisma
);
ok(mockState.wallets.get("w_qa")!.balance === 66, "Wallet debited third 17 credits (83 - 17 = 66)");

const cancel17Res = await cancelVideoJob(job17CancelRes.job.id, "User cancelled", mockPrisma);
ok(
  cancel17Res.refund?.refunded === true && cancel17Res.refund.amount === 17,
  "cancelVideoJob refunded exact 17 credits derived from debit transaction"
);
ok(
  mockState.wallets.get("w_qa")!.balance === 83,
  "Wallet restored by exactly +17 credits (66 + 17 = 83)"
);
const cancelled17Job = mockState.jobs.get(job17CancelRes.job.id)!;
ok(
  cancelled17Job.ingestionToken === null && cancelled17Job.ingestionLeaseExpiresAt === null,
  "Lease fields cleared to NULL on CANCELLED job"
);

// ===========================================================================
// Section 5: Mutual Exclusivity & Post-Terminal Invariants
// ===========================================================================
section("Section 5: Mutual Exclusivity & Post-Terminal Invariants");

// 1. Completed job cannot be refunded or cancelled
const completedRefundAttempt = await failVideoJob(job17Res.job.id, "Attempt to refund completed job", mockPrisma);
ok(
  completedRefundAttempt.settled === false && completedRefundAttempt.refund === null,
  "failVideoJob on COMPLETED job matches 0 rows and issues NO refund"
);

const completedCancelAttempt = await cancelVideoJob(job17Res.job.id, "Attempt to cancel completed job", mockPrisma);
ok(
  completedCancelAttempt.settled === false && completedCancelAttempt.refund === null,
  "cancelVideoJob on COMPLETED job matches 0 rows and issues NO refund"
);

ok(
  mockState.wallets.get("w_qa")!.balance === 83,
  "Wallet balance remains unchanged after attempted settlement of completed job"
);

// 2. Refunded/Failed job cannot produce an asset
let refundedJobAssetAttemptFailed = false;
try {
  await completeVideoJobWithAsset(
    {
      jobId: job17FailRes.job.id,
      ingestionToken: "stale-token",
      asset: {
        userId: qaUser.id,
        assetId: "asset_forbidden",
        storageKey: "...",
        width: 1280,
        height: 720,
        durationSeconds: 5,
        sizeBytes: 100,
      },
    },
    mockPrisma
  );
} catch (err) {
  if (err instanceof JobNotCompletableError) {
    refundedJobAssetAttemptFailed = true;
  }
}
ok(
  refundedJobAssetAttemptFailed,
  "completeVideoJobWithAsset on FAILED/refunded job strictly aborts and throws JobNotCompletableError"
);
ok(
  mockState.assets.get("asset_forbidden") === undefined,
  "Zero assets created for refunded/failed job (prevent orphan asset creation)"
);

// 3. Duplicate refund prevention
const duplicateRefundAttempt = await failVideoJob(job17FailRes.job.id, "Duplicate failure call", mockPrisma);
ok(
  duplicateRefundAttempt.settled === false && duplicateRefundAttempt.refund === null,
  "Second call to failVideoJob matches 0 rows and issues 0 duplicate refunds"
);

// ===========================================================================
// Section 6: Concurrency & PostgreSQL Integration Test Suite Simulation
// ===========================================================================
section("Section 6: Concurrency & PostgreSQL Integration Test Suite Simulation");

// 1. Concurrent duplicate idempotency requests
const concUser = { id: "cuser_conc_888", email: "conc@pixora.test", emailVerified: true };
mockState.users.set(concUser.id, concUser);
mockState.wallets.set("w_conc", { id: "w_conc", userId: concUser.id, balance: 100 });

const idemConcurrentKey = "idem_concurrent_race_1";
const [concurrentReq1, concurrentReq2] = await Promise.all([
  createVideoJob(
    { userId: concUser.id, prompt: "Concurrent video", idempotencyKey: idemConcurrentKey },
    { creditCost: 10, allowlistRaw: concUser.email },
    mockPrisma
  ),
  createVideoJob(
    { userId: concUser.id, prompt: "Concurrent video", idempotencyKey: idemConcurrentKey },
    { creditCost: 10, allowlistRaw: concUser.email },
    mockPrisma
  ),
]);

ok(
  (concurrentReq1.replayed && !concurrentReq2.replayed) || (!concurrentReq1.replayed && concurrentReq2.replayed),
  "Concurrent duplicate idempotency requests: exactly one creates the job and one replays"
);
ok(
  concurrentReq1.job.id === concurrentReq2.job.id,
  "Both concurrent callers receive the identical job ID"
);

// 2. Concurrent wallet debits on insufficient balance
const poorUserId = poorUser.id;
mockState.wallets.get("w_poor")!.balance = 25; // Can afford ONE 17-credit debit, but NOT two (25 < 34)

const { debitWallet } = await import("@/features/credits/ledger");

const directDebitResults = await Promise.allSettled([
  mockPrisma.$transaction((tx: any) =>
    debitWallet(tx, { userId: poorUserId, amount: 17, idempotencyKey: "direct_debit_1" })
  ),
  mockPrisma.$transaction((tx: any) =>
    debitWallet(tx, { userId: poorUserId, amount: 17, idempotencyKey: "direct_debit_2" })
  ),
]);

const fulfilledDirect = directDebitResults.filter((r) => r.status === "fulfilled");
const rejectedDirect = directDebitResults.filter((r) => r.status === "rejected");

ok(
  fulfilledDirect.length === 1 && rejectedDirect.length === 1,
  "Concurrent direct wallet debits: exactly 1 succeeds and 1 fails when balance is insufficient"
);

const rejectedDirectReason = (rejectedDirect[0] as PromiseRejectedResult).reason;
ok(
  rejectedDirectReason instanceof AccountingError && rejectedDirectReason.code === "INSUFFICIENT_CREDITS",
  "Failing concurrent debit throws AccountingError(INSUFFICIENT_CREDITS)"
);

ok(
  mockState.wallets.get("w_poor")!.balance === 8,
  "Wallet balance safely decremented to 8 (25 - 17 = 8) and never drops below zero"
);

// Concurrent generation requests with active job block
const activeUser = { id: "cuser_active_002", email: "active@pixora.test", emailVerified: true };
mockState.users.set(activeUser.id, activeUser);
mockState.wallets.set("w_active", { id: "w_active", userId: activeUser.id, balance: 100 });

const debitResults = await Promise.allSettled([
  createVideoJob(
    { userId: activeUser.id, user: activeUser, prompt: "Concurrent active test 1", idempotencyKey: "idem_active_race_1" },
    { creditCost: 10, allowlistRaw: activeUser.id },
    mockPrisma
  ),
  createVideoJob(
    { userId: activeUser.id, user: activeUser, prompt: "Concurrent active test 2", idempotencyKey: "idem_active_race_2" },
    { creditCost: 10, allowlistRaw: activeUser.id },
    mockPrisma
  ),
]);

const fulfilledDebits = debitResults.filter((r) => r.status === "fulfilled");
const rejectedDebits = debitResults.filter((r) => r.status === "rejected");

ok(
  fulfilledDebits.length === 1 && rejectedDebits.length === 1,
  "Concurrent generation requests: exactly 1 creates job and 1 rejected by active job concurrency limit"
);

const activeRejectedReason = (rejectedDebits[0] as PromiseRejectedResult).reason;
ok(
  activeRejectedReason instanceof AccountingError && activeRejectedReason.code === "ACTIVE_JOB_EXISTS",
  "Second concurrent request rejected with AccountingError(ACTIVE_JOB_EXISTS)"
);

// 3. Concurrent ingestion lease claims
const concJobId = (fulfilledDebits[0] as PromiseFulfilledResult<any>).value.job.id;
await markVideoJobStarted({ jobId: concJobId, providerJobId: "fal-conc-1" }, mockPrisma);

const [claimWorker1, claimWorker2] = await Promise.all([
  claimVideoIngestionLease({ jobId: concJobId, customToken: "worker-1-token" }, mockPrisma),
  claimVideoIngestionLease({ jobId: concJobId, customToken: "worker-2-token" }, mockPrisma),
]);

ok(
  (claimWorker1.claimed && !claimWorker2.claimed) || (!claimWorker1.claimed && claimWorker2.claimed),
  "Concurrent lease claims: exactly one worker wins the lease and the second is rejected"
);

// 4. Stale reconciliation of stuck jobs
const nowMs = Date.now();
const stuckJobId = "job_stuck_recon_test";
mockState.jobs.set(stuckJobId, {
  id: stuckJobId,
  userId: qaUser.id,
  type: GenerationType.VIDEO,
  status: GenerationStatus.PENDING,
  prompt: "Stuck job for recon",
  provider: DEFAULT_VIDEO_PROVIDER,
  providerJobId: null,
  model: DEFAULT_VIDEO_MODEL,
  settings: { creditCost: 17 },
  estimatedCredits: 17,
  chargedCredits: 0,
  errorMessage: null,
  idempotencyKey: "idem_stuck_recon",
  ingestionToken: null,
  ingestionLeaseExpiresAt: null,
  createdAt: new Date(nowMs - VIDEO_PENDING_STALE_MS - 1000),
  startedAt: null,
  completedAt: null,
  updatedAt: new Date(nowMs - VIDEO_PENDING_STALE_MS - 1000),
});
mockState.transactions.set(jobDebitKey(stuckJobId), {
  id: "tx_stuck_recon",
  userId: qaUser.id,
  walletId: "w_qa",
  jobId: stuckJobId,
  type: "GENERATION_DEBIT",
  amount: -17,
  balanceAfter: 66,
  idempotencyKey: jobDebitKey(stuckJobId),
});
mockState.wallets.get("w_qa")!.balance = 66;

// Concurrent reconciliation sweeps
const [sweep1, sweep2] = await Promise.all([
  reconcileStaleVideoJobs({ now: new Date(nowMs) }, mockPrisma),
  reconcileStaleVideoJobs({ now: new Date(nowMs) }, mockPrisma),
]);

ok(
  (sweep1.settled === 1 && sweep2.settled === 0) || (sweep1.settled === 0 && sweep2.settled === 1),
  "Concurrent stale sweeps: exactly 1 sweep settles the stuck job, second matches 0"
);
ok(
  mockState.wallets.get("w_qa")!.balance === 83,
  "Wallet restored by exactly 17 credits from reconciliation refund (66 + 17 = 83)"
);
ok(
  mockState.jobs.get(stuckJobId)?.ingestionToken === null &&
    mockState.jobs.get(stuckJobId)?.ingestionLeaseExpiresAt === null,
  "Stale reconciliation clears lease fields on settled job"
);

// ===========================================================================
// Test Summary
// ===========================================================================
console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
