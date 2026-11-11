/**
 * Stage 9 — Batch 2: AI Video Clipper Lifecycle, Concurrency & Accounting Offline Test Suite
 *
 * Fully offline test suite verifying:
 * 1. Prisma schema & relational alignment.
 * 2. Request input validation and default settings.
 * 3. Atomic job creation and dynamic credit debit (per requested clip count).
 * 4. Idempotency replay vs conflict detection.
 * 5. Daily quota enforcement across tiers.
 * 6. Global active generation concurrency guard (IMAGE, VIDEO, VIDEO_CLIP).
 * 7. State transitions: PENDING -> PROCESSING -> COMPLETED / FAILED / CANCELLED.
 * 8. Exclusive worker lease claiming, collision defense, and renewal.
 * 9. Guarded multi-clip completion and GeneratedAsset creation.
 * 10. Strictly idempotent refunds through double-entry ledger.
 * 11. Terminal state guards: completed cannot be refunded, failed cannot create assets.
 * 12. Stale job reconciliation for expired leases.
 * 13. Decoupled source storage cleanup tracking (pendingCleanups & audit log).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  AssetType,
  GenerationStatus,
  GenerationType,
  CreditTransactionType,
} = await import("@/generated/prisma/client");

import {
  CLIPPER_INGESTION_LEASE_MS,
  CLIPPER_PENDING_STALE_MS,
  CLIPPER_PROCESSING_STALE_MS,
  JobNotCompletableError,
  cancelClipperJob,
  claimClipperLease,
  completeClipperJobWithAssets,
  countDailyClipJobs,
  createClipperJob,
  failClipperJob,
  failClipperJobFenced,
  recordClipperCleanupResults,
  markClipperJobStarted,
  reconcileStaleClipperJobs,
  recordClipperSourceCleanup,
  renewClipperLease,
  validateClipperRequestInput,
} from "../src/features/clipper/lifecycle";

import {
  DEFAULT_CLIPPER_ENGINE,
  DEFAULT_CREDIT_COST_PER_CLIP,
  DEFAULT_DAILY_USER_CLIP_LIMIT,
  getClipperCreditCost,
} from "../src/features/clipper/config";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) await res;
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}:`, err);
  }
}

// ---------------------------------------------------------------------------
// High-Fidelity Transactional In-Memory Mock Database Harness
// ---------------------------------------------------------------------------
interface MockDbState {
  users: Map<string, { id: string; email: string }>;
  wallets: Map<string, { id: string; userId: string; balance: number }>;
  transactions: Map<
    string,
    {
      id: string;
      userId: string;
      walletId: string;
      jobId?: string | null;
      type: typeof CreditTransactionType.GENERATION_DEBIT;
      amount: number;
      balanceAfter: number;
      idempotencyKey: string;
      description?: string | null;
      createdAt: Date;
    }
  >;
  jobs: Map<
    string,
    {
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
    }
  >;
  assets: Map<
    string,
    {
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
    }
  >;
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

  const client = {
    $transaction: async <T,>(fn: (tx: any) => Promise<T>): Promise<T> => {
      // Snapshot state for atomic transaction rollback
      const snapshot = {
        users: new Map(state.users),
        wallets: new Map(Array.from(state.wallets.entries()).map(([k, v]) => [k, { ...v }])),
        transactions: new Map(state.transactions),
        jobs: new Map(Array.from(state.jobs.entries()).map(([k, v]) => [k, { ...v }])),
        assets: new Map(state.assets),
      };

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

          // 1. SELECT "id" FROM "User" WHERE "id" = ? FOR UPDATE
          if (sql.includes('SELECT "id" FROM "User"') && sql.includes('WHERE "id" =')) {
            const uid = String(p[0]);
            return state.users.has(uid) ? [{ id: uid }] : [];
          }

          // 2. UPDATE "CreditWallet" SET "balance" = "balance" - ? WHERE "userId" = ? AND "balance" >= ?
          if (sql.includes('UPDATE "CreditWallet"') && sql.includes('"balance" -')) {
            const amount = Number(p[0]);
            const userId = String(p[1]);
            const wallet = Array.from(state.wallets.values()).find((w) => w.userId === userId);
            if (!wallet || wallet.balance < amount) return [];
            wallet.balance -= amount;
            return [{ id: wallet.id, balance: wallet.balance }];
          }

          // 3. UPDATE "CreditWallet" SET "balance" = "balance" + ? WHERE "userId" = ?
          if (sql.includes('UPDATE "CreditWallet"') && sql.includes('"balance" +')) {
            const amount = Number(p[0]);
            const userId = String(p[1]);
            const wallet = Array.from(state.wallets.values()).find((w) => w.userId === userId);
            if (!wallet) return [];
            wallet.balance += amount;
            return [{ id: wallet.id, balance: wallet.balance }];
          }

          // 4. Lease claim: UPDATE "GenerationJob" SET "ingestionToken" = ?, "ingestionLeaseExpiresAt" = ...
          if (sql.includes('UPDATE "GenerationJob"') && sql.includes('"ingestionToken" =') && sql.includes('("ingestionToken" IS NULL OR')) {
            const token = String(p[0]);
            const leaseMs = Number(p[1]);
            const jobId = String(p[2]);
            const job = state.jobs.get(jobId);
            if (!job || job.status !== GenerationStatus.PROCESSING) return [];
            const now = new Date();
            if (job.ingestionToken && job.ingestionLeaseExpiresAt && job.ingestionLeaseExpiresAt > now) {
              return []; // Already claimed and not expired
            }
            job.ingestionToken = token;
            job.ingestionLeaseExpiresAt = new Date(now.getTime() + leaseMs);
            job.updatedAt = now;
            return [{ id: job.id, userId: job.userId, ingestionToken: job.ingestionToken, ingestionLeaseExpiresAt: job.ingestionLeaseExpiresAt }];
          }

          // 5. Lease renewal: UPDATE "GenerationJob" SET "ingestionLeaseExpiresAt" = ... WHERE "ingestionToken" = ?
          if (sql.includes('UPDATE "GenerationJob"') && sql.includes('"ingestionLeaseExpiresAt" = now() +') && sql.includes('"ingestionToken" =')) {
            const extMs = Number(p[0]);
            const jobId = String(p[1]);
            const token = String(p[2]);
            const job = state.jobs.get(jobId);
            const now = new Date();
            if (!job || job.status !== GenerationStatus.PROCESSING || job.ingestionToken !== token) return [];
            if (job.ingestionLeaseExpiresAt && job.ingestionLeaseExpiresAt <= now) return [];
            job.ingestionLeaseExpiresAt = new Date(Date.now() + extMs);
            job.updatedAt = new Date();
            return [{ id: job.id }];
          }

          // 6. Guarded completion: UPDATE "GenerationJob" SET "status" = 'COMPLETED' ... WHERE "ingestionToken" = ?
          if (sql.includes('UPDATE "GenerationJob"') && sql.includes("'COMPLETED'") && sql.includes('"ingestionToken" =')) {
            const jobId = String(p[0]);
            const token = String(p[1]);
            const job = state.jobs.get(jobId);
            const now = new Date();
            if (!job || job.status !== GenerationStatus.PROCESSING || job.ingestionToken !== token) return [];
            if (job.ingestionLeaseExpiresAt && job.ingestionLeaseExpiresAt <= now) return [];
            job.status = GenerationStatus.COMPLETED;
            job.chargedCredits = job.estimatedCredits;
            job.ingestionToken = null;
            job.ingestionLeaseExpiresAt = null;
            job.completedAt = new Date();
            job.updatedAt = new Date();
            return [{ id: job.id, userId: job.userId, estimatedCredits: job.estimatedCredits, settings: job.settings }];
          }

          // 6b. Lease-fenced FAILED (Batch 4): ... WHERE status = 'PROCESSING' AND "ingestionToken" = ? AND lease unexpired
          if (sql.includes('UPDATE "GenerationJob"') && sql.includes("'FAILED'") && sql.includes('AND "ingestionToken" =')) {
            const reason = String(p[0]);
            const jobId = String(p[1]);
            const token = String(p[2]);
            const job = state.jobs.get(jobId);
            const now = new Date();
            if (!job || job.status !== GenerationStatus.PROCESSING || job.ingestionToken !== token) return [];
            if (job.ingestionLeaseExpiresAt && job.ingestionLeaseExpiresAt <= now) return [];
            job.status = GenerationStatus.FAILED;
            job.errorMessage = reason;
            job.ingestionToken = null;
            job.ingestionLeaseExpiresAt = null;
            job.completedAt = now;
            job.updatedAt = now;
            return [{ id: job.id }];
          }

          // 6c. Row-locked settings read (Batch 4): SELECT "id", "settings" FROM "GenerationJob" ... FOR UPDATE
          if (sql.includes('SELECT "id", "settings" FROM "GenerationJob"') && sql.includes("FOR UPDATE")) {
            const job = state.jobs.get(String(p[0]));
            return job ? [{ id: job.id, settings: job.settings }] : [];
          }

          // 7. Settle FAILED: UPDATE "GenerationJob" SET "status" = 'FAILED' ... WHERE status IN ('PENDING', 'PROCESSING')
          if (sql.includes('UPDATE "GenerationJob"') && sql.includes("'FAILED'")) {
            const reason = String(p[0]);
            const jobId = String(p[1]);
            const job = state.jobs.get(jobId);
            if (!job || (job.status !== GenerationStatus.PENDING && job.status !== GenerationStatus.PROCESSING)) return [];
            job.status = GenerationStatus.FAILED;
            job.errorMessage = reason;
            job.ingestionToken = null;
            job.ingestionLeaseExpiresAt = null;
            job.completedAt = new Date();
            job.updatedAt = new Date();
            return [{ id: job.id }];
          }

          // 8. Settle CANCELLED: UPDATE "GenerationJob" SET "status" = 'CANCELLED' ...
          if (sql.includes('UPDATE "GenerationJob"') && sql.includes("'CANCELLED'")) {
            const reason = String(p[0]);
            const jobId = String(p[1]);
            const job = state.jobs.get(jobId);
            if (!job || (job.status !== GenerationStatus.PENDING && job.status !== GenerationStatus.PROCESSING)) return [];
            job.status = GenerationStatus.CANCELLED;
            job.errorMessage = reason;
            job.ingestionToken = null;
            job.ingestionLeaseExpiresAt = null;
            job.completedAt = new Date();
            job.updatedAt = new Date();
            return [{ id: job.id }];
          }

          return [];
        },
      };

      try {
        return await fn(txClient);
      } catch (err) {
        // Roll back state on transaction abort
        state.users = snapshot.users;
        state.wallets = snapshot.wallets;
        state.transactions = snapshot.transactions;
        state.jobs = snapshot.jobs;
        state.assets = snapshot.assets;
        throw err;
      }
    },

    $queryRaw: async (query: any, ...args: any[]): Promise<any[]> => {
      return (client.$transaction as any)((tx: any) => tx.$queryRaw(query, ...args));
    },

    generationJob: {
      findUnique: async (args: any) => {
        if (args.where?.id) {
          return state.jobs.get(args.where.id) || null;
        }
        if (args.where?.userId_idempotencyKey) {
          const { userId, idempotencyKey } = args.where.userId_idempotencyKey;
          for (const job of state.jobs.values()) {
            if (job.userId === userId && job.idempotencyKey === idempotencyKey) return job;
          }
        }
        return null;
      },
      findFirst: async (args: any) => {
        const { userId, status } = args.where;
        for (const job of state.jobs.values()) {
          if (job.userId === userId) {
            if (status?.in && status.in.includes(job.status)) return job;
            if (status && job.status === status) return job;
          }
        }
        return null;
      },
      findMany: async (args: any) => {
        const res: any[] = [];
        for (const job of state.jobs.values()) {
          if (args.where?.type && job.type !== args.where.type) continue;
          if (args.where?.OR) {
            const matchesOr = args.where.OR.some((cond: any) => {
              if (cond.status && job.status !== cond.status) return false;
              if (cond.createdAt?.lt && job.createdAt >= cond.createdAt.lt) return false;
              if (cond.startedAt?.lt && (!job.startedAt || job.startedAt >= cond.startedAt.lt)) return false;
              if (cond.ingestionLeaseExpiresAt?.lt && (!job.ingestionLeaseExpiresAt || job.ingestionLeaseExpiresAt >= cond.ingestionLeaseExpiresAt.lt)) return false;
              return true;
            });
            if (matchesOr) res.push(job);
          } else {
            res.push(job);
          }
        }
        return res;
      },
      count: async (args: any) => {
        let cnt = 0;
        const { userId, type, createdAt, status } = args.where;
        for (const job of state.jobs.values()) {
          if (userId && job.userId !== userId) continue;
          if (type && job.type !== type) continue;
          if (status?.in && !status.in.includes(job.status)) continue;
          if (createdAt?.gte && job.createdAt < createdAt.gte) continue;
          if (createdAt?.lt && job.createdAt >= createdAt.lt) continue;
          cnt++;
        }
        return cnt;
      },
      create: async (args: any) => {
        const id = genId("vclip");
        const entry = {
          id,
          userId: args.data.userId,
          type: args.data.type,
          status: args.data.status,
          prompt: args.data.prompt ?? null,
          provider: args.data.provider ?? null,
          providerJobId: args.data.providerJobId ?? null,
          model: args.data.model ?? null,
          settings: args.data.settings ?? {},
          estimatedCredits: args.data.estimatedCredits ?? 0,
          chargedCredits: args.data.chargedCredits ?? 0,
          errorMessage: args.data.errorMessage ?? null,
          idempotencyKey: args.data.idempotencyKey ?? null,
          ingestionToken: null,
          ingestionLeaseExpiresAt: null,
          createdAt: args.data.createdAt ?? new Date(),
          startedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        };
        state.jobs.set(id, entry);
        return entry;
      },
      update: async (args: any) => {
        const job = state.jobs.get(args.where.id);
        if (!job) throw new Error("Job not found");
        Object.assign(job, args.data, { updatedAt: new Date() });
        return job;
      },
      updateMany: async (args: any) => {
        let count = 0;
        const { id, status } = args.where;
        const job = state.jobs.get(id);
        if (job && job.status === status) {
          Object.assign(job, args.data, { updatedAt: new Date() });
          count = 1;
        }
        return { count };
      },
    },

    creditTransaction: {
      findUnique: async (args: any) => {
        const key = args.where.idempotencyKey;
        for (const tx of state.transactions.values()) {
          if (tx.idempotencyKey === key) return tx;
        }
        return null;
      },
      create: async (args: any) => {
        const id = genId("ctx");
        const entry = {
          id,
          userId: args.data.userId,
          walletId: args.data.walletId,
          jobId: args.data.jobId ?? null,
          type: args.data.type,
          amount: args.data.amount,
          balanceAfter: args.data.balanceAfter,
          idempotencyKey: args.data.idempotencyKey,
          description: args.data.description ?? null,
          createdAt: new Date(),
        };
        state.transactions.set(id, entry);
        return entry;
      },
    },

    generatedAsset: {
      create: async (args: any) => {
        const id = args.data.id ?? genId("asset");
        const entry = {
          id,
          userId: args.data.userId,
          jobId: args.data.jobId,
          type: args.data.type,
          storageKey: args.data.storageKey,
          thumbnailKey: args.data.thumbnailKey ?? null,
          width: args.data.width ?? null,
          height: args.data.height ?? null,
          durationSeconds: args.data.durationSeconds ?? null,
          mimeType: args.data.mimeType ?? null,
          fileSize: args.data.fileSize ? BigInt(args.data.fileSize) : null,
          createdAt: new Date(),
        };
        state.assets.set(id, entry);
        return entry;
      },
    },
  };

  return { db: client, state };
}

// ---------------------------------------------------------------------------
// Main Test Runner
// ---------------------------------------------------------------------------
async function run() {
  console.log("\n=======================================================");
  console.log("  Stage 9 — Batch 2: AI Video Clipper Lifecycle Tests");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------------
  // 1. Prisma Schema & Enum Invariant Verification
  // -------------------------------------------------------------------------
  console.log("# 1. Prisma Schema & Enum Alignment");

  await test("Prisma schema defines GenerationType.VIDEO_CLIP and AssetType.VIDEO", () => {
    assert.equal(GenerationType.VIDEO_CLIP, "VIDEO_CLIP");
    assert.equal(AssetType.VIDEO, "VIDEO");
    assert.equal(GenerationStatus.PENDING, "PENDING");
    assert.equal(GenerationStatus.PROCESSING, "PROCESSING");
    assert.equal(GenerationStatus.COMPLETED, "COMPLETED");
    assert.equal(GenerationStatus.FAILED, "FAILED");
    assert.equal(GenerationStatus.CANCELLED, "CANCELLED");
  });

  await test("Baseline migration creates GenerationJob_one_active_per_user partial index across all types", () => {
    const migrationPath = path.resolve(process.cwd(), "prisma/migrations/20261109064509_image_generation_pipeline/migration.sql");
    const sql = fs.readFileSync(migrationPath, "utf-8");
    assert.ok(sql.includes('CREATE UNIQUE INDEX "GenerationJob_one_active_per_user"'));
    assert.ok(sql.includes("WHERE \"status\" IN ('PENDING', 'PROCESSING')"));
  });

  // -------------------------------------------------------------------------
  // 2. Request Input Validation & Default Settings
  // -------------------------------------------------------------------------
  console.log("\n# 2. Clipper Request Input Validation");

  await test("validateClipperRequestInput parses valid input and assigns defaults", () => {
    const parsed = validateClipperRequestInput(
      {
        sourceKey: "ephemeral/users/usr_12345678/uploads/upl_source001.mp4",
        sourceDurationSeconds: 120.5,
        sourceWidth: 1920,
        sourceHeight: 1080,
        idempotencyKey: "idem_clip_1",
      },
      "usr_12345678",
    );

    assert.equal(parsed.sourceType, "upload");
    assert.equal(parsed.sourceKey, "ephemeral/users/usr_12345678/uploads/upl_source001.mp4");
    assert.equal(parsed.sourceDurationSeconds, 120.5);
    assert.equal(parsed.targetAspectRatio, "9:16");
    assert.equal(parsed.targetFraming, "pillarbox_blur");
    assert.equal(parsed.requestedClipsCount, 1);
    assert.equal(parsed.burnSubtitles, true);
    assert.equal(parsed.isVisualOnly, false);
    assert.equal(parsed.idempotencyKey, "idem_clip_1");
  });

  await test("validateClipperRequestInput respects visualOnly and disables subtitles", () => {
    const parsed = validateClipperRequestInput(
      {
        sourceKey: "ephemeral/users/usr_12345678/uploads/upl_silent001.mp4",
        sourceDurationSeconds: 60.0,
        isVisualOnly: true,
        burnSubtitles: true, // Should be overridden to false because visualOnly is true
        idempotencyKey: "idem_silent_1",
      },
      "usr_12345678",
    );

    assert.equal(parsed.isVisualOnly, true);
    assert.equal(parsed.burnSubtitles, false);
  });

  await test("validateClipperRequestInput clamps requestedClipsCount to max (3)", () => {
    const parsed = validateClipperRequestInput(
      {
        sourceKey: "ephemeral/users/usr_12345678/uploads/upl_source001.mp4",
        sourceDurationSeconds: 180,
        requestedClipsCount: 10,
        idempotencyKey: "idem_clamp_1",
      },
      "usr_12345678",
    );

    assert.equal(parsed.requestedClipsCount, 3);
  });

  await test("validateClipperRequestInput rejects unowned source key", () => {
    assert.throws(
      () =>
        validateClipperRequestInput(
          {
            sourceKey: "ephemeral/users/usr_attacker001/uploads/upl_stolen001.mp4",
            sourceDurationSeconds: 60,
            idempotencyKey: "idem_attack_1",
          },
          "usr_victim00001",
        ),
      (err: any) => err.name === "AccountingError" && err.code === "INVALID_INPUT",
    );
  });

  // -------------------------------------------------------------------------
  // 3. Atomic Job Creation & Dynamic Credit Debit
  // -------------------------------------------------------------------------
  console.log("\n# 3. Atomic Job Creation & Dynamic Credit Debit");

  await test("createClipperJob creates PENDING job and debits credits dynamically based on clip count", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_alice123";

    state.users.set(userId, { id: userId, email: "alice@example.com" });
    state.wallets.set(userId, { id: "w_1", userId, balance: 100 });

    // Request 2 clips -> cost = 10 credits
    const { job, replayed } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_alice123/uploads/upl_source001.mp4",
        sourceDurationSeconds: 90,
        requestedClipsCount: 2,
        idempotencyKey: "idem_clip_create_1",
      },
      {},
      db,
    );

    assert.equal(replayed, false);
    assert.equal(job.status, GenerationStatus.PENDING);
    assert.equal(job.type, GenerationType.VIDEO_CLIP);
    assert.equal(job.estimatedCredits, 10);
    assert.equal(job.chargedCredits, 0);

    // Verify wallet debit
    const wallet = state.wallets.get(userId);
    assert.equal(wallet?.balance, 90);

    // Verify transaction record
    const tx = Array.from(state.transactions.values()).find((t) => t.jobId === job.id);
    assert.ok(tx);
    assert.equal(tx.type, CreditTransactionType.GENERATION_DEBIT);
    assert.equal(tx.amount, -10);
    assert.equal(tx.balanceAfter, 90);
  });

  await test("createClipperJob fails if user has insufficient credits", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_poor1234";

    state.users.set(userId, { id: userId, email: "poor@example.com" });
    state.wallets.set(userId, { id: "w_poor", userId, balance: 4 }); // Needs 5 for 1 clip

    await assert.rejects(
      async () =>
        await createClipperJob(
          {
            userId,
            sourceKey: "ephemeral/users/usr_poor1234/uploads/upl_source001.mp4",
            sourceDurationSeconds: 30,
            requestedClipsCount: 1,
            idempotencyKey: "idem_poor_1",
          },
          {},
          db,
        ),
      (err: any) => err.name === "AccountingError" && err.code === "INSUFFICIENT_CREDITS",
    );

    // Balance remains untouched
    assert.equal(state.wallets.get(userId)?.balance, 4);
    assert.equal(state.jobs.size, 0);
  });

  // -------------------------------------------------------------------------
  // 4. Idempotency Replay vs Conflict
  // -------------------------------------------------------------------------
  console.log("\n# 4. Idempotency Replay vs Conflict Detection");

  await test("createClipperJob replay with identical key and settings returns existing job without second debit", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_bob12345";

    state.users.set(userId, { id: userId, email: "bob@example.com" });
    state.wallets.set(userId, { id: "w_bob", userId, balance: 100 });

    const payload = {
      userId,
      sourceKey: "ephemeral/users/usr_bob12345/uploads/upl_source001.mp4",
      sourceDurationSeconds: 60,
      requestedClipsCount: 1,
      targetAspectRatio: "9:16" as const,
      idempotencyKey: "idem_replay_key_1",
    };

    const first = await createClipperJob(payload, {}, db);
    assert.equal(first.replayed, false);
    assert.equal(state.wallets.get(userId)?.balance, 95);

    // Replay identical request
    const second = await createClipperJob(payload, {}, db);
    assert.equal(second.replayed, true);
    assert.equal(second.job.id, first.job.id);

    // Balance must STILL be 95 (no second debit)
    assert.equal(state.wallets.get(userId)?.balance, 95);
    assert.equal(state.transactions.size, 1);
  });

  await test("createClipperJob throws IDEMPOTENCY_CONFLICT if same key used with different settings", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_charlie1";

    state.users.set(userId, { id: userId, email: "charlie@example.com" });
    state.wallets.set(userId, { id: "w_charlie", userId, balance: 100 });

    const first = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_charlie1/uploads/upl_source001.mp4",
        sourceDurationSeconds: 60,
        requestedClipsCount: 1,
        idempotencyKey: "idem_conflict_key_1",
      },
      {},
      db,
    );
    assert.equal(first.replayed, false);

    // Second request with same key but different requestedClipsCount (2 vs 1)
    await assert.rejects(
      async () =>
        await createClipperJob(
          {
            userId,
            sourceKey: "ephemeral/users/usr_charlie1/uploads/upl_source001.mp4",
            sourceDurationSeconds: 60,
            requestedClipsCount: 2, // Mismatch!
            idempotencyKey: "idem_conflict_key_1",
          },
          {},
          db,
        ),
      (err: any) => err.name === "AccountingError" && err.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  // -------------------------------------------------------------------------
  // 5. Daily Quota Enforcement
  // -------------------------------------------------------------------------
  console.log("\n# 5. Daily Quota Enforcement");

  await test("createClipperJob enforces daily limit (2/day for promotional)", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_quota123";

    state.users.set(userId, { id: userId, email: "quota@example.com" });
    state.wallets.set(userId, { id: "w_q", userId, balance: 100 });

    // Job 1 (succeeds)
    await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_quota123/uploads/upl_quota001.mp4",
        sourceDurationSeconds: 30,
        idempotencyKey: "idem_q_1",
      },
      {},
      db,
    );

    // Complete Job 1
    const job1 = Array.from(state.jobs.values())[0];
    job1.status = GenerationStatus.COMPLETED;

    // Job 2 (succeeds)
    await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_quota123/uploads/upl_quota002.mp4",
        sourceDurationSeconds: 30,
        idempotencyKey: "idem_q_2",
      },
      {},
      db,
    );

    // Complete Job 2
    const job2 = Array.from(state.jobs.values())[1];
    job2.status = GenerationStatus.COMPLETED;

    // Job 3 (exceeds promotional limit of 2)
    await assert.rejects(
      async () =>
        await createClipperJob(
          {
            userId,
            sourceKey: "ephemeral/users/usr_quota123/uploads/upl_quota003.mp4",
            sourceDurationSeconds: 30,
            idempotencyKey: "idem_q_3",
            userTier: "promotional",
          },
          {},
          db,
        ),
      (err: any) => err.name === "AccountingError" && err.code === "DAILY_LIMIT_REACHED",
    );
  });

  // -------------------------------------------------------------------------
  // 6. Global Active Generation Concurrency Guard (Across All Types)
  // -------------------------------------------------------------------------
  console.log("\n# 6. Global Active Concurrency Guard");

  await test("createClipperJob rejects creation if active IMAGE job is in-flight", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_concurrent1";

    state.users.set(userId, { id: userId, email: "con@example.com" });
    state.wallets.set(userId, { id: "w_c", userId, balance: 100 });

    // Insert active IMAGE job
    state.jobs.set("img_active", {
      id: "img_active",
      userId,
      type: GenerationType.IMAGE,
      status: GenerationStatus.PROCESSING,
      prompt: "A photo",
      provider: "cloudflare",
      providerJobId: "cf_1",
      model: "flux-schnell",
      settings: {},
      estimatedCredits: 1,
      chargedCredits: 0,
      errorMessage: null,
      idempotencyKey: "idem_img_1",
      ingestionToken: null,
      ingestionLeaseExpiresAt: null,
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    });

    await assert.rejects(
      async () =>
        await createClipperJob(
          {
            userId,
            sourceKey: "ephemeral/users/usr_concurrent1/uploads/upl_concurrent01.mp4",
            sourceDurationSeconds: 40,
            idempotencyKey: "idem_clip_blocked",
          },
          {},
          db,
        ),
      (err: any) => err.name === "AccountingError" && err.code === "ACTIVE_JOB_EXISTS",
    );
  });

  await test("createClipperJob rejects creation if active VIDEO job is in-flight", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_concurrent2";

    state.users.set(userId, { id: userId, email: "con2@example.com" });
    state.wallets.set(userId, { id: "w_c2", userId, balance: 100 });

    // Insert active VIDEO job
    state.jobs.set("vid_active", {
      id: "vid_active",
      userId,
      type: GenerationType.VIDEO,
      status: GenerationStatus.PROCESSING,
      prompt: "A video",
      provider: "fal-ai",
      providerJobId: "fal_1",
      model: "wan-2.1",
      settings: {},
      estimatedCredits: 10,
      chargedCredits: 0,
      errorMessage: null,
      idempotencyKey: "idem_vid_1",
      ingestionToken: "token_vid",
      ingestionLeaseExpiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    });

    await assert.rejects(
      async () =>
        await createClipperJob(
          {
            userId,
            sourceKey: "ephemeral/users/usr_concurrent2/uploads/upl_concurrent02.mp4",
            sourceDurationSeconds: 40,
            idempotencyKey: "idem_clip_blocked_2",
          },
          {},
          db,
        ),
      (err: any) => err.name === "AccountingError" && err.code === "ACTIVE_JOB_EXISTS",
    );
  });

  // -------------------------------------------------------------------------
  // 7. State Transitions & Lease Management
  // -------------------------------------------------------------------------
  console.log("\n# 7. State Transitions & Worker Leases");

  await test("markClipperJobStarted transitions PENDING to PROCESSING", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_state1234";

    state.users.set(userId, { id: userId, email: "s@example.com" });
    state.wallets.set(userId, { id: "w_s", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_state1234/uploads/upl_source001.mp4",
        sourceDurationSeconds: 45,
        idempotencyKey: "idem_state_1",
      },
      {},
      db,
    );

    const started = await markClipperJobStarted({ jobId: job.id, engine: "mock-clipper-engine" }, db);
    assert.equal(started, true);

    const updated = state.jobs.get(job.id);
    assert.equal(updated?.status, GenerationStatus.PROCESSING);
    assert.ok(updated?.startedAt);

    // Duplicate call returns false
    const duplicate = await markClipperJobStarted({ jobId: job.id }, db);
    assert.equal(duplicate, false);
  });

  await test("claimClipperLease claims exclusive lease and blocks second caller", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_lease1234";

    state.users.set(userId, { id: userId, email: "l@example.com" });
    state.wallets.set(userId, { id: "w_l", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_lease1234/uploads/upl_source001.mp4",
        sourceDurationSeconds: 50,
        idempotencyKey: "idem_lease_1",
      },
      {},
      db,
    );

    await markClipperJobStarted({ jobId: job.id }, db);

    // First caller claims lease
    const claim1 = await claimClipperLease({ jobId: job.id, leaseDurationMs: 60000 }, db);
    assert.equal(claim1.claimed, true);
    assert.ok(claim1.token);
    assert.ok(claim1.expiresAt);

    // Second caller attempts to claim active lease -> blocked
    const claim2 = await claimClipperLease({ jobId: job.id }, db);
    assert.equal(claim2.claimed, false);
    assert.equal(claim2.reason, "already_claimed_or_not_processing");
  });

  await test("renewClipperLease extends lease expiration for valid token", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_renew1234";

    state.users.set(userId, { id: userId, email: "r@example.com" });
    state.wallets.set(userId, { id: "w_r", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_renew1234/uploads/upl_source001.mp4",
        sourceDurationSeconds: 50,
        idempotencyKey: "idem_renew_1",
      },
      {},
      db,
    );

    await markClipperJobStarted({ jobId: job.id }, db);
    const { token } = await claimClipperLease({ jobId: job.id, leaseDurationMs: 60000 }, db);

    // Renew with correct token
    const renewed = await renewClipperLease({ jobId: job.id, token: token!, extensionMs: 120000 }, db);
    assert.equal(renewed, true);

    // Renew with invalid token -> fails
    const badRenew = await renewClipperLease({ jobId: job.id, token: "wrong_token" }, db);
    assert.equal(badRenew, false);
  });

  // -------------------------------------------------------------------------
  // 8. Guarded Multi-Clip Completion & Asset Creation
  // -------------------------------------------------------------------------
  console.log("\n# 8. Guarded Multi-Clip Completion");

  await test("completeClipperJobWithAssets creates GeneratedAsset records and finalizes credits", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_comp1234";

    state.users.set(userId, { id: userId, email: "comp@example.com" });
    state.wallets.set(userId, { id: "w_comp", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_comp1234/uploads/upl_source001.mp4",
        sourceDurationSeconds: 120,
        requestedClipsCount: 2, // 10 credits debited
        idempotencyKey: "idem_comp_1",
      },
      {},
      db,
    );

    await markClipperJobStarted({ jobId: job.id }, db);
    const { token } = await claimClipperLease({ jobId: job.id }, db);

    // Complete job with 2 clips
    const result = await completeClipperJobWithAssets(
      {
        jobId: job.id,
        ingestionToken: token!,
        clips: [
          {
            clipId: "clip_1",
            userId,
            storageKey: `users/${userId}/clips/${job.id}/clip_1.mp4`,
            thumbnailKey: `users/${userId}/clips/${job.id}/clip_1-thumb.webp`,
            width: 1080,
            height: 1920,
            durationSeconds: 30.0,
            sizeBytes: 8000000,
            aspectRatio: "9:16",
            title: "First Highlight",
          },
          {
            clipId: "clip_2",
            userId,
            storageKey: `users/${userId}/clips/${job.id}/clip_2.mp4`,
            thumbnailKey: `users/${userId}/clips/${job.id}/clip_2-thumb.webp`,
            width: 1080,
            height: 1920,
            durationSeconds: 25.0,
            sizeBytes: 7000000,
            aspectRatio: "9:16",
            title: "Second Highlight",
          },
        ],
      },
      db,
    );

    assert.equal(result.jobId, job.id);
    assert.equal(result.assetIds.length, 2);

    const updatedJob = state.jobs.get(job.id);
    assert.equal(updatedJob?.status, GenerationStatus.COMPLETED);
    assert.equal(updatedJob?.chargedCredits, 10);
    assert.equal(updatedJob?.ingestionToken, null);

    // Verify 2 GeneratedAsset records exist
    assert.equal(state.assets.size, 2);
    for (const asset of state.assets.values()) {
      assert.equal(asset.jobId, job.id);
      assert.equal(asset.userId, userId);
      assert.equal(asset.type, AssetType.VIDEO);
      assert.ok(asset.fileSize! > BigInt(0));
    }

    // Credits remain debited (no refund on completion)
    assert.equal(state.wallets.get(userId)?.balance, 90);
  });

  await test("completeClipperJobWithAssets throws JobNotCompletableError if lease token mismatches", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_lostlease1";

    state.users.set(userId, { id: userId, email: "lost@example.com" });
    state.wallets.set(userId, { id: "w_lost", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_lostlease1/uploads/upl_source001.mp4",
        sourceDurationSeconds: 60,
        idempotencyKey: "idem_lost_1",
      },
      {},
      db,
    );

    await markClipperJobStarted({ jobId: job.id }, db);
    await claimClipperLease({ jobId: job.id }, db);

    await assert.rejects(
      async () =>
        await completeClipperJobWithAssets(
          {
            jobId: job.id,
            ingestionToken: "wrong_lease_token",
            clips: [
              {
                clipId: "clip_lost",
                userId,
                storageKey: `users/${userId}/clips/${job.id}/clip_lost.mp4`,
                width: 1080,
                height: 1920,
                durationSeconds: 15.0,
                sizeBytes: 4000000,
                aspectRatio: "9:16",
                title: "Lost Lease Clip",
              },
            ],
          },
          db,
        ),
      (err: any) => err.name === "JobNotCompletableError",
    );
  });

  await test("completeClipperJobWithAssets throws JobNotCompletableError if lease has expired (fencing safeguard)", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_fenced1";

    state.users.set(userId, { id: userId, email: "fenced@example.com" });
    state.wallets.set(userId, { id: "w_fenced", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_fenced1/uploads/upl_source001.mp4",
        sourceDurationSeconds: 60,
        idempotencyKey: "idem_fenced_1",
      },
      {},
      db,
    );

    await markClipperJobStarted({ jobId: job.id }, db);
    const lease = await claimClipperLease({ jobId: job.id, leaseDurationMs: 1000 }, db);
    assert.ok(lease);

    // Simulate clock advancing past lease expiration
    state.jobs.get(job.id)!.ingestionLeaseExpiresAt = new Date(Date.now() - 5000);

    await assert.rejects(
      async () =>
        await completeClipperJobWithAssets(
          {
            jobId: job.id,
            ingestionToken: lease.token!,
            clips: [
              {
                clipId: "clip_fenced",
                userId,
                storageKey: `users/${userId}/clips/${job.id}/clip_fenced.mp4`,
                width: 1080,
                height: 1920,
                durationSeconds: 15.0,
                sizeBytes: 4000000,
                aspectRatio: "9:16",
                title: "Fenced Clip",
              },
            ],
          },
          db,
        ),
      (err: any) => err.name === "JobNotCompletableError",
    );
  });

  // -------------------------------------------------------------------------
  // 9. Terminal State Guards
  // -------------------------------------------------------------------------
  console.log("\n# 9. Terminal State Guards");

  await test("Completed jobs CANNOT be refunded", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_term1234";

    state.users.set(userId, { id: userId, email: "t@example.com" });
    state.wallets.set(userId, { id: "w_t", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_term1234/uploads/upl_source001.mp4",
        sourceDurationSeconds: 40,
        idempotencyKey: "idem_t_1",
      },
      {},
      db,
    );

    await markClipperJobStarted({ jobId: job.id }, db);
    const { token } = await claimClipperLease({ jobId: job.id }, db);

    await completeClipperJobWithAssets(
      {
        jobId: job.id,
        ingestionToken: token!,
        clips: [
          {
            clipId: "c1",
            userId,
            storageKey: `users/${userId}/clips/${job.id}/c1.mp4`,
            width: 1080,
            height: 1920,
            durationSeconds: 10.0,
            sizeBytes: 2000000,
            aspectRatio: "9:16",
            title: "C1",
          },
        ],
      },
      db,
    );

    // Attempt to fail and refund completed job
    const failRes = await failClipperJob(job.id, "Attempted refund after completion", db);
    assert.equal(failRes.settled, false);
    assert.equal(failRes.refund, null);

    // Status remains COMPLETED, balance remains debited (95)
    assert.equal(state.jobs.get(job.id)?.status, GenerationStatus.COMPLETED);
    assert.equal(state.wallets.get(userId)?.balance, 95);
  });

  await test("Failed jobs CANNOT create assets", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_fail1234";

    state.users.set(userId, { id: userId, email: "f@example.com" });
    state.wallets.set(userId, { id: "w_f", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_fail1234/uploads/upl_source001.mp4",
        sourceDurationSeconds: 40,
        idempotencyKey: "idem_f_1",
      },
      {},
      db,
    );

    await markClipperJobStarted({ jobId: job.id }, db);
    const { token } = await claimClipperLease({ jobId: job.id }, db);

    // Job fails
    await failClipperJob(job.id, "GPU node failure", db);

    // Attempt to complete failed job -> throws JobNotCompletableError
    await assert.rejects(
      async () =>
        await completeClipperJobWithAssets(
          {
            jobId: job.id,
            ingestionToken: token!,
            clips: [
              {
                clipId: "c_late",
                userId,
                storageKey: `users/${userId}/clips/${job.id}/late.mp4`,
                width: 1080,
                height: 1920,
                durationSeconds: 10.0,
                sizeBytes: 2000000,
                aspectRatio: "9:16",
                title: "Late Clip",
              },
            ],
          },
          db,
        ),
      (err: any) => err.name === "JobNotCompletableError",
    );

    // Zero assets created
    assert.equal(state.assets.size, 0);
  });

  // -------------------------------------------------------------------------
  // 10. Idempotent Failure & Cancellation Refunds
  // -------------------------------------------------------------------------
  console.log("\n# 10. Failure & Cancellation Refunds");

  await test("failClipperJob refunds debited credits atomically and subsequent calls are no-ops", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_refund12";

    state.users.set(userId, { id: userId, email: "ref@example.com" });
    state.wallets.set(userId, { id: "w_ref", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_refund12/uploads/upl_source001.mp4",
        sourceDurationSeconds: 60,
        requestedClipsCount: 2, // 10 credits debited
        idempotencyKey: "idem_ref_1",
      },
      {},
      db,
    );

    assert.equal(state.wallets.get(userId)?.balance, 90);

    // Fail job
    const failRes = await failClipperJob(job.id, "FFmpeg transcode failed", db);
    assert.equal(failRes.settled, true);
    assert.ok(failRes.refund);
    assert.equal(failRes.refund?.refunded, true);
    assert.equal(failRes.refund?.amount, 10);
    assert.equal(failRes.refund?.balanceAfter, 100);

    // Wallet balance restored to 100
    assert.equal(state.wallets.get(userId)?.balance, 100);

    // Duplicate call returns settled: false, no double refund
    const dupRes = await failClipperJob(job.id, "Duplicate failure", db);
    assert.equal(dupRes.settled, false);
    assert.equal(dupRes.refund, null);
    assert.equal(state.wallets.get(userId)?.balance, 100);
  });

  await test("cancelClipperJob refunds debited credits atomically", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_cancel12";

    state.users.set(userId, { id: userId, email: "canc@example.com" });
    state.wallets.set(userId, { id: "w_canc", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_cancel12/uploads/upl_source001.mp4",
        sourceDurationSeconds: 60,
        requestedClipsCount: 1, // 5 credits debited
        idempotencyKey: "idem_canc_1",
      },
      {},
      db,
    );

    assert.equal(state.wallets.get(userId)?.balance, 95);

    // Cancel job
    const cancelRes = await cancelClipperJob(job.id, "User cancelled request", db);
    assert.equal(cancelRes.settled, true);
    assert.equal(cancelRes.refund?.refunded, true);
    assert.equal(cancelRes.refund?.amount, 5);

    // Wallet balance restored to 100
    assert.equal(state.wallets.get(userId)?.balance, 100);
    assert.equal(state.jobs.get(job.id)?.status, GenerationStatus.CANCELLED);
  });

  // -------------------------------------------------------------------------
  // 11. Stale Job Reconciliation
  // -------------------------------------------------------------------------
  console.log("\n# 11. Stale Job Reconciliation");

  await test("reconcileStaleClipperJobs recovers stale PENDING and stale PROCESSING jobs", async () => {
    const { db, state } = createMockDb();
    const userP = "usr_stale_p01";
    const userProc = "usr_stale_proc01";

    state.users.set(userP, { id: userP, email: "stale_p@example.com" });
    state.wallets.set(userP, { id: "w_stale_p", userId: userP, balance: 100 });

    state.users.set(userProc, { id: userProc, email: "stale_proc@example.com" });
    state.wallets.set(userProc, { id: "w_stale_proc", userId: userProc, balance: 100 });

    const now = new Date();

    // 1. Stale PENDING job (> 5 min old)
    const { job: pendingJob } = await createClipperJob(
      {
        userId: userP,
        sourceKey: `ephemeral/users/${userP}/uploads/upl_source001.mp4`,
        sourceDurationSeconds: 40,
        idempotencyKey: "idem_stale_p",
      },
      { now: new Date(now.getTime() - 6 * 60 * 1000) },
      db,
    );

    // 2. Stale PROCESSING job (> 15 min old with expired lease)
    const { job: procJob } = await createClipperJob(
      {
        userId: userProc,
        sourceKey: `ephemeral/users/${userProc}/uploads/upl_source002.mp4`,
        sourceDurationSeconds: 40,
        idempotencyKey: "idem_stale_proc",
      },
      { now: new Date(now.getTime() - 20 * 60 * 1000) },
      db,
    );
    await markClipperJobStarted({ jobId: procJob.id, now: new Date(now.getTime() - 19 * 60 * 1000) }, db);
    await claimClipperLease({ jobId: procJob.id, leaseDurationMs: 5000 }, db);

    // Force lease to be expired
    state.jobs.get(procJob.id)!.ingestionLeaseExpiresAt = new Date(now.getTime() - 10 * 60 * 1000);

    // Reconcile
    const reconcileRes = await reconcileStaleClipperJobs({ now }, db);
    assert.equal(reconcileRes.checked, 2);
    assert.equal(reconcileRes.settled, 2);

    // Both jobs transitioned to FAILED
    assert.equal(state.jobs.get(pendingJob.id)?.status, GenerationStatus.FAILED);
    assert.equal(state.jobs.get(procJob.id)?.status, GenerationStatus.FAILED);

    // Both debits refunded: balances back to 100
    assert.equal(state.wallets.get(userP)?.balance, 100);
    assert.equal(state.wallets.get(userProc)?.balance, 100);
  });

  // -------------------------------------------------------------------------
  // 12. Decoupled Source Storage Cleanup Tracking
  // -------------------------------------------------------------------------
  console.log("\n# 12. Decoupled Source Storage Cleanup");

  await test("recordClipperSourceCleanup records success and failure without touching wallet balance", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_cleanup12";

    state.users.set(userId, { id: userId, email: "clean@example.com" });
    state.wallets.set(userId, { id: "w_clean", userId, balance: 100 });

    const { job } = await createClipperJob(
      {
        userId,
        sourceKey: "ephemeral/users/usr_cleanup12/uploads/upl_source001.mp4",
        sourceDurationSeconds: 60,
        idempotencyKey: "idem_clean_1",
      },
      {},
      db,
    );

    // Initial state: pendingCleanups has the source key
    let settings = state.jobs.get(job.id)?.settings;
    assert.deepEqual(settings.pendingCleanups, ["ephemeral/users/usr_cleanup12/uploads/upl_source001.mp4"]);
    assert.equal(settings.cleanupStatus, "pending");

    // Case 1: Cleanup attempt fails due to storage timeout
    await recordClipperSourceCleanup(
      {
        jobId: job.id,
        storageKey: "ephemeral/users/usr_cleanup12/uploads/upl_source001.mp4",
        success: false,
        error: "Storage gateway timeout (504)",
      },
      db,
    );

    settings = state.jobs.get(job.id)?.settings;
    assert.equal(settings.cleanupStatus, "failed");
    assert.equal(settings.pendingCleanups.length, 1);
    assert.equal(settings.cleanupAudit.length, 1);
    assert.equal(settings.cleanupAudit[0].success, false);
    assert.equal(settings.cleanupAudit[0].error, "Storage gateway timeout (504)");

    // Wallet balance is completely unaffected by cleanup failure!
    assert.equal(state.wallets.get(userId)?.balance, 95);

    // Case 2: Retry succeeds
    await recordClipperSourceCleanup(
      {
        jobId: job.id,
        storageKey: "ephemeral/users/usr_cleanup12/uploads/upl_source001.mp4",
        success: true,
      },
      db,
    );

    settings = state.jobs.get(job.id)?.settings;
    assert.equal(settings.cleanupStatus, "cleaned");
    assert.equal(settings.pendingCleanups.length, 0);
    assert.equal(settings.cleanupAudit.length, 2);
    assert.equal(settings.cleanupAudit[1].success, true);

    // Wallet balance is still 95 (no financial side-effects)
    assert.equal(state.wallets.get(userId)?.balance, 95);
  });

  // -------------------------------------------------------------------------
  // 13. Batch 4: Lease-fenced failure settlement & cleanup recording
  // -------------------------------------------------------------------------
  console.log("\n# 13. Batch 4 Fenced Failure & Cleanup Recording");

  async function processingJob(userId: string, idem: string, sourceType: "upload" | "platform_asset" = "upload") {
    const { db, state } = createMockDb();
    state.users.set(userId, { id: userId, email: `${userId}@example.com` });
    state.wallets.set(userId, { id: `w_${userId}`, userId, balance: 100 });
    const sourceKey =
      sourceType === "upload"
        ? `ephemeral/users/${userId}/uploads/upl_source001.mp4`
        : `users/${userId}/videos/vid_asset0001.mp4`;
    const { job } = await createClipperJob(
      { userId, sourceType, sourceKey, sourceDurationSeconds: 60, idempotencyKey: idem },
      {},
      db,
    );
    await markClipperJobStarted({ jobId: job.id }, db);
    const lease = await claimClipperLease({ jobId: job.id }, db);
    return { db, state, job, token: lease.token! };
  }

  await test("failClipperJobFenced rejects a foreign token (no status change, no refund)", async () => {
    const { db, state, job } = await processingJob("usr_fence0001", "idem_fence_1");
    const res = await failClipperJobFenced({ jobId: job.id, ingestionToken: "not-the-token", reason: "x" }, db);
    assert.equal(res.settled, false);
    assert.equal(state.jobs.get(job.id)?.status, GenerationStatus.PROCESSING);
    assert.equal(state.wallets.get("usr_fence0001")?.balance, 95);
  });

  await test("failClipperJobFenced rejects an expired lease even with the right token", async () => {
    const { db, state, job, token } = await processingJob("usr_fence0002", "idem_fence_2");
    state.jobs.get(job.id)!.ingestionLeaseExpiresAt = new Date(Date.now() - 1000);
    const res = await failClipperJobFenced({ jobId: job.id, ingestionToken: token, reason: "x" }, db);
    assert.equal(res.settled, false);
    assert.equal(state.jobs.get(job.id)?.status, GenerationStatus.PROCESSING);
    assert.equal(state.wallets.get("usr_fence0002")?.balance, 95);
  });

  await test("failClipperJobFenced settles + refunds exactly once for the live lease holder", async () => {
    const { db, state, job, token } = await processingJob("usr_fence0003", "idem_fence_3");
    const first = await failClipperJobFenced({ jobId: job.id, ingestionToken: token, reason: "Video clipping failed (RENDER_FAILED)." }, db);
    assert.equal(first.settled, true);
    assert.equal(state.jobs.get(job.id)?.status, GenerationStatus.FAILED);
    assert.equal(state.wallets.get("usr_fence0003")?.balance, 100);
    const second = await failClipperJobFenced({ jobId: job.id, ingestionToken: token, reason: "again" }, db);
    assert.equal(second.settled, false);
    assert.equal(state.wallets.get("usr_fence0003")?.balance, 100);
  });

  await test("failClipperJobFenced cannot refund a COMPLETED job", async () => {
    const { db, state, job, token } = await processingJob("usr_fence0004", "idem_fence_4");
    await completeClipperJobWithAssets(
      {
        jobId: job.id,
        ingestionToken: token,
        clips: [{
          clipId: "clip_00000001", userId: "usr_fence0004",
          storageKey: `users/usr_fence0004/clips/${job.id}/clip_00000001.mp4`,
          width: 1080, height: 1920, durationSeconds: 30, sizeBytes: 1000, aspectRatio: "9:16", title: "t",
        }],
      },
      db,
    );
    const res = await failClipperJobFenced({ jobId: job.id, ingestionToken: token, reason: "late" }, db);
    assert.equal(res.settled, false);
    assert.equal(state.jobs.get(job.id)?.status, GenerationStatus.COMPLETED);
    assert.equal(state.wallets.get("usr_fence0004")?.balance, 95);
  });

  await test("recordClipperCleanupResults adds failed keys, removes succeeded keys, leaves credits alone", async () => {
    const { db, state, job } = await processingJob("usr_fence0005", "idem_fence_5");
    const src = "ephemeral/users/usr_fence0005/uploads/upl_source001.mp4";
    const orphan = `users/usr_fence0005/clips/${job.id}/clip_orphan01.mp4`;
    await recordClipperCleanupResults(
      { jobId: job.id, results: [{ key: orphan, success: false, error: "DELETE_FAILED" }, { key: src, success: true }] },
      db,
    );
    let s = state.jobs.get(job.id)!.settings;
    assert.deepEqual(s.pendingCleanups, [orphan]);
    assert.equal(s.cleanupStatus, "failed");
    assert.equal(s.cleanupAudit.length, 2);
    await recordClipperCleanupResults({ jobId: job.id, results: [{ key: orphan, success: false }] }, db);
    s = state.jobs.get(job.id)!.settings;
    assert.deepEqual(s.pendingCleanups, [orphan], "failed keys are deduplicated");
    await recordClipperCleanupResults({ jobId: job.id, results: [{ key: orphan, success: true }] }, db);
    s = state.jobs.get(job.id)!.settings;
    assert.deepEqual(s.pendingCleanups, []);
    assert.equal(s.cleanupStatus, "cleaned");
    assert.equal(state.jobs.get(job.id)?.status, GenerationStatus.PROCESSING);
    assert.equal(state.wallets.get("usr_fence0005")?.balance, 95);
  });

  await test("Batch 5: abandoned keys leave automatic retry and mark the job needs_review", async () => {
    const { db, state, job } = await processingJob("usr_fence0007", "idem_fence_7");
    const src = "ephemeral/users/usr_fence0007/uploads/upl_source001.mp4";
    await recordClipperCleanupResults({ jobId: job.id, results: [], abandonKeys: [{ key: src, reason: "ATTEMPT_CAP" }] }, db);
    const s = state.jobs.get(job.id)!.settings;
    assert.deepEqual(s.pendingCleanups, []);
    assert.equal(s.cleanupStatus, "needs_review");
    assert.equal(s.cleanupAudit.at(-1).error, "ABANDONED:ATTEMPT_CAP");
    assert.equal(state.wallets.get("usr_fence0007")?.balance, 95);
  });

  await test("Batch 5: finalize settles a stale 'pending' status with an empty list to 'cleaned'", async () => {
    const { db, state, job } = await processingJob("usr_fence0008", "idem_fence_8");
    state.jobs.get(job.id)!.settings = { ...state.jobs.get(job.id)!.settings, pendingCleanups: [], cleanupStatus: "pending" };
    await recordClipperCleanupResults({ jobId: job.id, results: [] }, db);
    assert.equal(state.jobs.get(job.id)!.settings.cleanupStatus, "pending", "no-op without finalize");
    await recordClipperCleanupResults({ jobId: job.id, results: [], finalize: true }, db);
    assert.equal(state.jobs.get(job.id)!.settings.cleanupStatus, "cleaned");
  });

  await test("Batch 5: completing a platform_asset job records cleanupStatus 'cleaned' (nothing to delete)", async () => {
    const { db, state, job, token } = await processingJob("usr_fence0009", "idem_fence_9", "platform_asset");
    await completeClipperJobWithAssets(
      {
        jobId: job.id,
        ingestionToken: token,
        clips: [{
          clipId: "clip_00000009", userId: "usr_fence0009",
          storageKey: `users/usr_fence0009/clips/${job.id}/clip_00000009.mp4`,
          width: 1080, height: 1920, durationSeconds: 30, sizeBytes: 1000, aspectRatio: "9:16", title: "t",
        }],
      },
      db,
    );
    assert.equal(state.jobs.get(job.id)!.settings.cleanupStatus, "cleaned");
  });

  await test("Batch 5: extraSettings (analysis capabilities, metadata origin) are persisted on the job", async () => {
    const { db, state } = createMockDb();
    const userId = "usr_extra0001";
    state.users.set(userId, { id: userId, email: "e@example.com" });
    state.wallets.set(userId, { id: "w_extra", userId, balance: 100 });
    const { job } = await createClipperJob(
      { userId, sourceKey: `ephemeral/users/${userId}/uploads/upl_source001.mp4`, sourceDurationSeconds: 60, idempotencyKey: "idem_extra_1", burnSubtitles: false },
      { extraSettings: { sourceMetadataOrigin: "client_hint", sourceSizeBytes: 1234, analysis: { highlightMode: "scene_pacing", speechAnalysis: "unavailable", captions: "unavailable", originalAudio: "preserved" } } },
      db,
    );
    const s = state.jobs.get(job.id)!.settings;
    assert.equal(s.sourceMetadataOrigin, "client_hint");
    assert.equal(s.analysis.captions, "unavailable");
    assert.equal(s.burnSubtitles, false);
  });

  await test("platform_asset sources are never scheduled for deletion", async () => {
    const { state, job } = await processingJob("usr_fence0006", "idem_fence_6", "platform_asset");
    const s = state.jobs.get(job.id)!.settings;
    assert.equal(s.sourceType, "platform_asset");
    assert.deepEqual(s.pendingCleanups, []);
    assert.equal(s.cleanupStatus, "cleaned");
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
