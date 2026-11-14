// Stage 8.2: Production Operator CLI Unit & Safety Test Suite
//
// Fully offline: NO network access, NO real credentials, NO live production database.
// Tests scripts/resolve-ambiguous-job.mts across parsing, validation, safety invariants,
// storage namespace checks, dry-run mode, and confirmed transactional execution.
//
// Run: npm run test:operator-cli

import {
  parseArgs,
  inspectAndValidateJob,
  executeResolution,
  runCli,
  printUsage,
  type ResolveAmbiguousJobOptions,
  type StorageObjectVerifier,
  type StorageObjectMetadata,
} from "./resolve-ambiguous-job.mjs";
import { jobDebitKey } from "../src/features/credits/ledger";

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
  throw new Error("Network access is strictly forbidden in operator CLI tests");
}) as typeof fetch;

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
// In-Memory Mock Database Harness
// ===========================================================================

interface MockUser {
  id: string;
  email: string;
  name?: string;
}

interface MockWallet {
  id: string;
  userId: string;
  balance: number;
}

interface MockTransaction {
  id: string;
  walletId: string;
  userId: string;
  amount: number;
  type: string;
  description?: string;
  idempotencyKey?: string | null;
  createdAt: Date;
}

interface MockJob {
  id: string;
  userId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  jobType: string;
  estimatedCredits: number;
  chargedCredits: number | null;
  provider: string;
  providerJobId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  settings: Record<string, unknown>;
  user: {
    id: string;
    email: string;
  };
}

interface MockAsset {
  id: string;
  userId: string;
  jobId: string;
  assetType: string;
  storageKey: string;
  thumbnailKey: string | null;
  width: number;
  height: number;
  durationSeconds: number | null;
  sizeBytes: number;
  mimeType: string;
  createdAt: Date;
}

function createMockCliDb() {
  const users = new Map<string, MockUser>();
  const wallets = new Map<string, MockWallet>();
  const transactions = new Map<string, MockTransaction>();
  const jobs = new Map<string, MockJob>();
  const assets = new Map<string, MockAsset>();

  let idSeq = 1;
  const nextId = (prefix: string) => `${prefix}_${idSeq++}`;

  const handleQueryRaw = async (query: any, ...args: any[]): Promise<any[]> => {
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

    // UPDATE "GenerationJob" SET "status" = 'FAILED'
    if (sql.includes('UPDATE "GenerationJob"') && sql.includes("SET \"status\" = 'FAILED'")) {
      const reason = p[0];
      const now = p[1];
      const settingsStr = p[3];
      const jobId = p[4];
      const job = jobs.get(jobId);
      if (!job || job.status !== "PROCESSING") return [];
      job.status = "FAILED";
      job.completedAt = now;
      if (typeof settingsStr === "string") {
        try {
          job.settings = JSON.parse(settingsStr);
        } catch {
          // ignore
        }
      }
      return [{ id: job.id }];
    }

    // UPDATE "GenerationJob" SET "status" = 'COMPLETED'
    if (sql.includes('UPDATE "GenerationJob"') && sql.includes("SET \"status\" = 'COMPLETED'")) {
      const now = p[0];
      const settingsStr = p[2];
      const jobId = p[3];
      const job = jobs.get(jobId);
      if (!job || job.status !== "PROCESSING") return [];
      job.status = "COMPLETED";
      job.chargedCredits = job.estimatedCredits;
      job.completedAt = now;
      if (typeof settingsStr === "string") {
        try {
          job.settings = JSON.parse(settingsStr);
        } catch {
          // ignore
        }
      }
      return [{ id: job.id }];
    }

    // UPDATE "CreditWallet" SET "balance" = "balance" + ...
    if (sql.includes('UPDATE "CreditWallet"') && sql.includes('"balance" +')) {
      const amount = p[0];
      const userId = p[1];
      const wallet = wallets.get(userId);
      if (!wallet) return [];
      wallet.balance += amount;
      return [{ id: wallet.id, balance: wallet.balance }];
    }

    return [];
  };

  const client: any = {
    $queryRaw: handleQueryRaw,
    user: {
      findUnique: async ({ where }: any) => {
        return users.get(where.id) ?? null;
      },
    },
    creditWallet: {
      findUnique: async ({ where }: any) => {
        return wallets.get(where.userId) ?? null;
      },
      update: async ({ where, data }: any) => {
        const w = wallets.get(where.userId);
        if (!w) throw new Error("Wallet not found");
        if (data.balance?.increment) {
          w.balance += data.balance.increment;
        } else if (typeof data.balance === "number") {
          w.balance = data.balance;
        }
        return { ...w };
      },
    },
    creditTransaction: {
      findUnique: async ({ where }: any) => {
        if (where.idempotencyKey) {
          for (const tx of transactions.values()) {
            if (tx.idempotencyKey === where.idempotencyKey) return tx;
          }
          return null;
        }
        if (where.id) return transactions.get(where.id) ?? null;
        return null;
      },
      create: async ({ data }: any) => {
        const id = nextId("tx");
        const tx: MockTransaction = {
          id,
          walletId: data.walletId,
          userId: data.userId,
          amount: data.amount,
          type: data.type,
          description: data.description,
          idempotencyKey: data.idempotencyKey,
          createdAt: new Date(),
        };
        transactions.set(id, tx);
        return { ...tx };
      },
    },
    generationJob: {
      findUnique: async ({ where }: any) => {
        return jobs.get(where.id) ?? null;
      },
      update: async ({ where, data }: any) => {
        const job = jobs.get(where.id);
        if (!job) throw new Error(`Job ${where.id} not found`);
        if (data.status) job.status = data.status;
        if (data.completedAt) job.completedAt = data.completedAt;
        if (data.chargedCredits !== undefined) job.chargedCredits = data.chargedCredits;
        if (data.settings) job.settings = data.settings;
        return { ...job };
      },
    },
    generatedAsset: {
      create: async ({ data }: any) => {
        const id = data.id || nextId("asset");
        const asset: MockAsset = {
          id,
          userId: data.userId,
          jobId: data.jobId,
          assetType: data.type ?? data.assetType ?? "VIDEO",
          storageKey: data.storageKey,
          thumbnailKey: data.thumbnailKey ?? null,
          width: data.width,
          height: data.height,
          durationSeconds: data.durationSeconds ?? null,
          sizeBytes: typeof data.fileSize === "bigint" ? Number(data.fileSize) : (data.fileSize ?? data.sizeBytes ?? 0),
          mimeType: data.mimeType,
          createdAt: new Date(),
        };
        assets.set(id, asset);
        return { ...asset };
      },
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      return fn(client);
    },
  };

  return {
    client,
    state: { users, wallets, transactions, jobs, assets },
    seedUser: (u: MockUser, initialBalance: number) => {
      users.set(u.id, u);
      wallets.set(u.id, { id: `w_${u.id}`, userId: u.id, balance: initialBalance });
    },
    seedJob: (job: MockJob, debitAmount?: number) => {
      jobs.set(job.id, job);
      if (debitAmount && debitAmount > 0) {
        const txId = nextId("tx_debit");
        transactions.set(txId, {
          id: txId,
          walletId: `w_${job.userId}`,
          userId: job.userId,
          amount: -debitAmount,
          type: "USAGE",
          description: "Video generation initial debit",
          idempotencyKey: jobDebitKey(job.id),
          createdAt: new Date(),
        });
      }
    },
  };
}

// ===========================================================================
// Section 1: Argument Parsing & Validation Tests
// ===========================================================================
section("Section 1: Argument Parsing & Validation");

{
  const opts = parseArgs([
    "--job-id=vjob-001",
    "--action=failed",
    "--operator=ops-alice",
    '--reason="Queue timeout at provider"',
    "--confirm",
    "--force",
  ]);

  ok(opts.jobId === "vjob-001", "parseArgs extracts --job-id=<val>");
  ok(opts.action === "failed", "parseArgs extracts --action=failed");
  ok(opts.operatorId === "ops-alice", "parseArgs extracts --operator=<val>");
  ok(opts.reason.includes("Queue timeout"), "parseArgs extracts --reason=<val>");
  ok(opts.confirm === true, "parseArgs recognizes --confirm boolean flag");
  ok(opts.force === true, "parseArgs recognizes --force boolean flag");
  ok(opts.help === false, "parseArgs default help is false");
}

{
  // Test space-separated options
  const opts = parseArgs([
    "--job-id",
    "vjob-002",
    "--action",
    "completed",
    "--operator",
    "ops-bob",
    "--reason",
    "Manual asset verification",
    "--storage-key=users/u1/videos/vjob-002/asset1.mp4",
    "--thumbnail-key=users/u1/videos/vjob-002/thumb1.jpg",
    "--width=1920",
    "--height=1080",
    "--duration=5.5",
    "--size-bytes=5242880",
    "--asset-id=vasset-custom-1",
  ]);

  ok(opts.jobId === "vjob-002", "parseArgs extracts space-separated --job-id");
  ok(opts.action === "completed", "parseArgs extracts space-separated --action");
  ok(opts.operatorId === "ops-bob", "parseArgs extracts space-separated --operator");
  ok(opts.reason === "Manual asset verification", "parseArgs extracts space-separated --reason");
  ok(opts.storageKey === "users/u1/videos/vjob-002/asset1.mp4", "parseArgs extracts --storage-key");
  ok(opts.thumbnailKey === "users/u1/videos/vjob-002/thumb1.jpg", "parseArgs extracts --thumbnail-key");
  ok(opts.width === 1920, "parseArgs extracts integer --width");
  ok(opts.height === 1080, "parseArgs extracts integer --height");
  ok(opts.durationSeconds === 5.5, "parseArgs extracts float --duration");
  ok(opts.sizeBytes === 5242880, "parseArgs extracts integer --size-bytes");
  ok(opts.assetId === "vasset-custom-1", "parseArgs extracts --asset-id");
}

{
  // Invalid action throws
  let threw = false;
  try {
    parseArgs(["--action=invalid_action"]);
  } catch (err) {
    threw = true;
  }
  ok(threw, "parseArgs throws on unrecognized --action");
}

{
  // Help flag
  const opts = parseArgs(["--help"]);
  ok(opts.help === true, "parseArgs sets help=true on --help");
  const optsShort = parseArgs(["-h"]);
  ok(optsShort.help === true, "parseArgs sets help=true on -h");
}

// ===========================================================================
// Section 2: CLI Usage & Runner Exit Codes
// ===========================================================================
section("Section 2: CLI Runner Exit Codes & Output Safety");

{
  const code = await runCli(["--help"]);
  ok(code === 0, "runCli(['--help']) exits with code 0");
}

{
  const code = await runCli([]);
  ok(code === 1, "runCli([]) with missing required args exits with code 1");
}

// ===========================================================================
// Section 3: Job State Pre-Execution Validation
// ===========================================================================
section("Section 3: Job State Pre-Execution Validation");

{
  const { client, seedUser, seedJob } = createMockCliDb();
  const user = { id: "user_alpha_123", email: "alpha@pixora.test" };
  seedUser(user, 100);

  // Missing ID check
  const missingResult = await inspectAndValidateJob("", client);
  ok(Boolean(!missingResult.valid && missingResult.error?.includes("Missing required --job-id")), "Rejects empty job ID");

  // Non-existent job check
  const nonExistentResult = await inspectAndValidateJob("vjob-does-not-exist", client);
  ok(
    Boolean(!nonExistentResult.valid && nonExistentResult.error?.includes("was not found")),
    "Rejects non-existent job ID with clear error"
  );

  // Terminal jobs: COMPLETED
  seedJob({
    id: "vjob-completed",
    userId: user.id,
    status: "COMPLETED",
    jobType: "VIDEO_WAN_2_1",
    estimatedCredits: 40,
    chargedCredits: 40,
    provider: "fal",
    providerJobId: "fal-c1",
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: new Date(),
    settings: {},
    user,
  });

  const completedResult = await inspectAndValidateJob("vjob-completed", client);
  ok(
    Boolean(!completedResult.valid && completedResult.error?.includes("is already terminal (status: COMPLETED)")),
    "Strictly rejects resolving already COMPLETED jobs"
  );

  // Terminal jobs: FAILED
  seedJob({
    id: "vjob-failed",
    userId: user.id,
    status: "FAILED",
    jobType: "VIDEO_WAN_2_1",
    estimatedCredits: 40,
    chargedCredits: 0,
    provider: "fal",
    providerJobId: "fal-f1",
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: new Date(),
    settings: {},
    user,
  });

  const failedResult = await inspectAndValidateJob("vjob-failed", client);
  ok(
    Boolean(!failedResult.valid && failedResult.error?.includes("is already terminal (status: FAILED)")),
    "Strictly rejects resolving already FAILED jobs"
  );

  // Terminal jobs: CANCELLED
  seedJob({
    id: "vjob-cancelled",
    userId: user.id,
    status: "CANCELLED",
    jobType: "VIDEO_WAN_2_1",
    estimatedCredits: 40,
    chargedCredits: 0,
    provider: "fal",
    providerJobId: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: new Date(),
    settings: {},
    user,
  });

  const cancelledResult = await inspectAndValidateJob("vjob-cancelled", client);
  ok(
    Boolean(!cancelledResult.valid && cancelledResult.error?.includes("is already terminal (status: CANCELLED)")),
    "Strictly rejects resolving already CANCELLED jobs"
  );

  // PENDING state
  seedJob({
    id: "vjob-pending",
    userId: user.id,
    status: "PENDING",
    jobType: "VIDEO_WAN_2_1",
    estimatedCredits: 40,
    chargedCredits: null,
    provider: "fal",
    providerJobId: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    settings: {},
    user,
  });

  const pendingResult = await inspectAndValidateJob("vjob-pending", client);
  ok(
    Boolean(!pendingResult.valid && pendingResult.error?.includes("is still in PENDING status")),
    "Rejects resolving PENDING jobs (only PROCESSING jobs are eligible)"
  );

  // PROCESSING state with ambiguous flag
  seedJob({
    id: "vjob-ambiguous-1",
    userId: user.id,
    status: "PROCESSING",
    jobType: "VIDEO_WAN_2_1",
    estimatedCredits: 40,
    chargedCredits: null,
    provider: "fal",
    providerJobId: "fal-ambig-1",
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    settings: {
      submission: {
        state: "ambiguous",
        unresolved: true,
        reviewStatus: "pending_operator_review",
        error: "Gateway timeout on dispatch",
      },
    },
    user,
  });

  const ambiguousResult = await inspectAndValidateJob("vjob-ambiguous-1", client);
  ok(
    ambiguousResult.valid && ambiguousResult.isAmbiguous === true,
    "Validates ambiguous PROCESSING job as eligible with isAmbiguous=true"
  );

  // PROCESSING state WITHOUT ambiguous flag
  seedJob({
    id: "vjob-normal-processing",
    userId: user.id,
    status: "PROCESSING",
    jobType: "VIDEO_WAN_2_1",
    estimatedCredits: 40,
    chargedCredits: null,
    provider: "fal",
    providerJobId: "fal-proc-1",
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    settings: {
      submission: {
        state: "dispatched",
        unresolved: false,
      },
    },
    user,
  });

  const normalProcResult = await inspectAndValidateJob("vjob-normal-processing", client);
  ok(
    normalProcResult.valid && normalProcResult.isAmbiguous === false,
    "Validates normal PROCESSING job with isAmbiguous=false"
  );
}

// ===========================================================================
// Section 4: Execution Safeguards & Validation Invariants
// ===========================================================================
section("Section 4: Execution Safeguards & Validation Invariants");

{
  const { client, seedUser, seedJob } = createMockCliDb();
  const user = { id: "user_guard_1", email: "guard@pixora.test" };
  seedUser(user, 100);

  seedJob(
    {
      id: "vjob-guard-1",
      userId: user.id,
      status: "PROCESSING",
      jobType: "VIDEO_WAN_2_1",
      estimatedCredits: 40,
      chargedCredits: null,
      provider: "fal",
      providerJobId: "fal-guard-1",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      settings: {
        submission: {
          unresolved: true,
          reviewStatus: "pending_operator_review",
        },
      },
      user,
    },
    40
  );

  // 1. Missing operator
  const missingOp = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "failed",
      operatorId: "",
      reason: "Operational refund due to timeout",
      confirm: false,
      force: false,
      help: false,
    },
    client
  );
  ok(!missingOp.success && missingOp.message.includes("Missing required --operator"), "Rejects missing --operator");

  // 2. Insufficient reason length (< 8 chars)
  const shortReason = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "failed",
      operatorId: "ops-carol",
      reason: "timeout", // 7 chars
      confirm: false,
      force: false,
      help: false,
    },
    client
  );
  ok(
    !shortReason.success && shortReason.message.includes("at least 8 characters"),
    "Rejects brief or missing audit reason (minimum 8 chars required)"
  );

  // 3. Normal processing job without --force
  seedJob({
    id: "vjob-no-force",
    userId: user.id,
    status: "PROCESSING",
    jobType: "VIDEO_WAN_2_1",
    estimatedCredits: 40,
    chargedCredits: null,
    provider: "fal",
    providerJobId: "fal-nf-1",
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    settings: {},
    user,
  });

  const noForce = await executeResolution(
    {
      jobId: "vjob-no-force",
      action: "failed",
      operatorId: "ops-carol",
      reason: "Provider confirmed job did not run",
      confirm: false,
      force: false,
      help: false,
    },
    client
  );
  ok(
    !noForce.success && noForce.message.includes("does not carry an explicit ambiguous submission flag"),
    "Rejects settling non-ambiguous job unless --force is specified"
  );

  // With --force, non-ambiguous job proceeds
  const withForce = await executeResolution(
    {
      jobId: "vjob-no-force",
      action: "failed",
      operatorId: "ops-carol",
      reason: "Provider confirmed job did not run",
      confirm: false,
      force: true,
      help: false,
    },
    client
  );
  ok(withForce.success && withForce.dryRun === true, "Permits non-ambiguous job resolution when --force is provided");

  // 4. Completed action requires --storage-key
  const missingKey = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      confirm: false,
      force: false,
      help: false,
    },
    client
  );
  ok(
    !missingKey.success && missingKey.message.includes("requires --storage-key parameter"),
    "Rejects completed action when --storage-key is missing"
  );

  // 5. Completed action rejects storage key belonging to another user
  const wrongUserKey = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: "users/attacker_user_999/videos/vjob-guard-1/asset.mp4",
      sizeBytes: 1048576,
      confirm: false,
      force: false,
      help: false,
    },
    client
  );
  ok(
    !wrongUserKey.success && wrongUserKey.message.includes("does not match the job owner's namespace"),
    "Strictly rejects storage key that does not match users/{userId}/videos/... namespace"
  );

  // 6. Completed action: Rejects when physical object does NOT exist in private storage
  // (Invariant: Namespace matching alone is NOT proof of existence)
  const mockStorageMap = new Map<string, StorageObjectMetadata>();
  const mockVerifier: StorageObjectVerifier = async (key: string) => {
    return mockStorageMap.get(key) ?? { exists: false };
  };

  const validKey = `users/${user.id}/videos/vjob-guard-1/vasset-guard-1.mp4`;
  const validThumbKey = `users/${user.id}/videos/vjob-guard-1/vasset-guard-1-thumb.webp`;

  const missingStorageObj = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: validKey,
      sizeBytes: 1048576,
      confirm: false,
      force: false,
      help: false,
    },
    client,
    mockVerifier
  );
  ok(
    !missingStorageObj.success &&
      missingStorageObj.message.includes("does not exist in private storage"),
    "Rejects completed action when object is absent from private storage (namespace alone is not proof)"
  );

  // 7. Completed action: Rejects when storage object has unsupported MIME type
  mockStorageMap.set(validKey, {
    exists: true,
    sizeBytes: 1048576,
    contentType: "text/plain",
  });

  const badMime = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: validKey,
      sizeBytes: 1048576,
      confirm: false,
      force: false,
      help: false,
    },
    client,
    mockVerifier
  );
  ok(
    !badMime.success && badMime.message.includes("invalid or unsupported MIME type"),
    "Rejects completed action when storage object has non-video MIME type (e.g. text/plain)"
  );

  // 8. Completed action: Rejects when storage object size is 0 or exceeds 35MB
  mockStorageMap.set(validKey, {
    exists: true,
    sizeBytes: 0,
    contentType: "video/mp4",
  });

  const zeroSize = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: validKey,
      confirm: false,
      force: false,
      help: false,
    },
    client,
    mockVerifier
  );
  ok(
    !zeroSize.success && zeroSize.message.includes("outside permitted bounds"),
    "Rejects completed action when storage object size is 0 bytes"
  );

  // 9. Completed action: Rejects when specified --size-bytes does not match storage object size
  mockStorageMap.set(validKey, {
    exists: true,
    sizeBytes: 2097152, // 2MB
    contentType: "video/mp4",
  });

  const sizeMismatch = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: validKey,
      sizeBytes: 1048576, // 1MB specified vs 2MB actual
      confirm: false,
      force: false,
      help: false,
    },
    client,
    mockVerifier
  );
  ok(
    !sizeMismatch.success && sizeMismatch.message.includes("does not match actual storage object size"),
    "Rejects completed action when --size-bytes mismatches verified storage object size"
  );

  // 10. Completed action: Rejects unsupported video dimensions
  const badDimensions = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: validKey,
      width: 1920,
      height: 1080, // unsupported 1080p
      confirm: false,
      force: false,
      help: false,
    },
    client,
    mockVerifier
  );
  ok(
    !badDimensions.success && badDimensions.message.includes("Unsupported video dimensions"),
    "Rejects completed action when video dimensions are unsupported (e.g. 1920x1080)"
  );

  // 11. Completed action: Rejects unsupported video duration
  const badDuration = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: validKey,
      durationSeconds: 15.0, // unsupported 15s
      confirm: false,
      force: false,
      help: false,
    },
    client,
    mockVerifier
  );
  ok(
    !badDuration.success && badDuration.message.includes("Unsupported video duration"),
    "Rejects completed action when video duration is outside supported range (e.g. 15s)"
  );

  // 12. Completed action: Rejects missing thumbnail object
  const missingThumb = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: validKey,
      thumbnailKey: validThumbKey,
      confirm: false,
      force: false,
      help: false,
    },
    client,
    mockVerifier
  );
  ok(
    !missingThumb.success && missingThumb.message.includes("Thumbnail object"),
    "Rejects completed action when specified thumbnail does not exist in private storage"
  );

  // 13. Completed action: Dry run succeeds when storage object is valid and verified
  mockStorageMap.set(validThumbKey, {
    exists: true,
    sizeBytes: 65536,
    contentType: "image/webp",
  });

  const validDryRun = await executeResolution(
    {
      jobId: "vjob-guard-1",
      action: "completed",
      operatorId: "ops-carol",
      reason: "Asset manually verified on provider",
      storageKey: validKey,
      thumbnailKey: validThumbKey,
      confirm: false, // DRY RUN
      force: false,
      help: false,
    },
    client,
    mockVerifier
  );
  ok(
    validDryRun.success &&
      validDryRun.dryRun === true &&
      validDryRun.details?.verifiedStorageObject === validKey,
    "Dry-run verifies actual object in storage and reports verified metadata without database mutations"
  );
}

// ===========================================================================
// Section 5: Dry-Run Mode vs Confirmed Execution
// ===========================================================================
section("Section 5: Dry-Run Mode vs Confirmed Execution");

{
  const { client, state, seedUser, seedJob } = createMockCliDb();
  const user = { id: "user_dry_200", email: "dryrun@pixora.test" };
  seedUser(user, 60); // balance: 60 (initial was 100, 40 debited)

  seedJob(
    {
      id: "vjob-dry-1",
      userId: user.id,
      status: "PROCESSING",
      jobType: "VIDEO_WAN_2_1",
      estimatedCredits: 40,
      chargedCredits: null,
      provider: "fal",
      providerJobId: "fal-dry-1",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      settings: {
        submission: {
          unresolved: true,
          reviewStatus: "pending_operator_review",
        },
      },
      user,
    },
    40
  );

  // --- DRY RUN TEST ---
  const dryResult = await executeResolution(
    {
      jobId: "vjob-dry-1",
      action: "failed",
      operatorId: "ops-examiner",
      reason: "Fal timeout on queue submission; provider confirmed non-start",
      confirm: false, // DRY RUN
      force: false,
      help: false,
    },
    client
  );

  ok(dryResult.success === true, "Dry run succeeds verification");
  ok(dryResult.dryRun === true, "Dry run sets dryRun=true flag");
  ok(
    dryResult.details?.userIdMasked === `${user.id.slice(0, 8)}...`,
    "Dry run masks sensitive user ID in details output"
  );
  ok(
    typeof dryResult.details?.proposedAction === "string" &&
      dryResult.details.proposedAction.includes("SETTLE AS FAILED"),
    "Dry run summarizes proposed state transition clearly"
  );

  // Verify ZERO state mutations occurred
  const jobAfterDry = state.jobs.get("vjob-dry-1");
  ok(jobAfterDry?.status === "PROCESSING", "Dry run leaves job status unchanged as PROCESSING");
  const walletAfterDry = state.wallets.get(user.id);
  ok(walletAfterDry?.balance === 60, "Dry run leaves credit wallet balance untouched (60)");
  ok(
    !state.transactions.has("tx_refund_vjob-dry-1"),
    "Dry run does not create any refund ledger transactions"
  );

  // --- CONFIRMED MUTATION TEST (FAILED / REFUND) ---
  const confirmFailResult = await executeResolution(
    {
      jobId: "vjob-dry-1",
      action: "failed",
      operatorId: "ops-examiner",
      reason: "Fal timeout on queue submission; provider confirmed non-start",
      confirm: true, // CONFIRMED EXECUTION
      force: false,
      help: false,
    },
    client
  );

  ok(confirmFailResult.success === true, "Confirmed execution succeeds");
  ok(confirmFailResult.dryRun === false, "Confirmed execution sets dryRun=false");
  ok(
    confirmFailResult.message.includes("successfully settled as FAILED"),
    "Confirmed execution confirms FAILED status"
  );

  // Verify database state mutation
  const jobAfterConfirm = state.jobs.get("vjob-dry-1");
  ok(jobAfterConfirm?.status === "FAILED", "Job status is mutated to FAILED");
  ok(
    (jobAfterConfirm?.settings as any)?.resolution?.operatorId === "ops-examiner",
    "Audit trail recorded in job settings with operator ID"
  );
  ok(
    (jobAfterConfirm?.settings as any)?.resolution?.action === "refund",
    "Audit trail recorded in job settings with resolution action"
  );

  // Verify dynamic credit refund applied via ledger
  const walletAfterRefund = state.wallets.get(user.id);
  ok(
    walletAfterRefund?.balance === 100,
    `Credit wallet balance restored from 60 to 100 (actual: ${walletAfterRefund?.balance})`
  );

  // Verify late resolution rejection (cannot re-resolve already terminal job)
  const reResolveResult = await executeResolution(
    {
      jobId: "vjob-dry-1",
      action: "failed",
      operatorId: "ops-examiner",
      reason: "Second attempt to refund",
      confirm: true,
      force: true,
      help: false,
    },
    client
  );
  ok(
    !reResolveResult.success && reResolveResult.message.includes("already terminal (status: FAILED)"),
    "Strictly blocks re-resolving job that was already settled"
  );
}

// ===========================================================================
// Section 6: Confirmed Resolution as COMPLETED
// ===========================================================================
section("Section 6: Confirmed Resolution as COMPLETED");

{
  const { client, state, seedUser, seedJob } = createMockCliDb();
  const user = { id: "user_comp_300", email: "completed@pixora.test" };
  seedUser(user, 60);

  seedJob(
    {
      id: "vjob-complete-1",
      userId: user.id,
      status: "PROCESSING",
      jobType: "VIDEO_WAN_2_1",
      estimatedCredits: 40,
      chargedCredits: null,
      provider: "fal",
      providerJobId: "fal-done-1",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      settings: {
        submission: {
          unresolved: true,
          reviewStatus: "pending_operator_review",
        },
      },
      user,
    },
    40
  );

  const completedStorageMap = new Map<string, StorageObjectMetadata>([
    [
      `users/${user.id}/videos/vjob-complete-1/vasset-recovered-1.mp4`,
      { exists: true, sizeBytes: 3145728, contentType: "video/mp4" },
    ],
    [
      `users/${user.id}/videos/vjob-complete-1/vasset-recovered-1-thumb.webp`,
      { exists: true, sizeBytes: 65536, contentType: "image/webp" },
    ],
  ]);
  const completedStorageVerifier: StorageObjectVerifier = async (key: string) => {
    return completedStorageMap.get(key) ?? { exists: false };
  };

  const completeResult = await executeResolution(
    {
      jobId: "vjob-complete-1",
      action: "completed",
      operatorId: "ops-dan",
      reason: "Provider finished successfully; webhook gateway had dropped response",
      storageKey: `users/${user.id}/videos/vjob-complete-1/vasset-recovered-1.mp4`,
      thumbnailKey: `users/${user.id}/videos/vjob-complete-1/vasset-recovered-1-thumb.webp`,
      width: 1280,
      height: 720,
      durationSeconds: 5.0,
      sizeBytes: 3145728,
      assetId: "vasset-manual-recov-1",
      confirm: true,
      force: false,
      help: false,
    },
    client,
    completedStorageVerifier
  );

  ok(completeResult.success === true, "Confirmed COMPLETED resolution succeeds");
  ok(
    completeResult.message.includes("successfully settled as COMPLETED"),
    "Returns completion confirmation message"
  );

  // Verify job state
  const job = state.jobs.get("vjob-complete-1");
  ok(job?.status === "COMPLETED", "Job status is mutated to COMPLETED");
  ok(job?.chargedCredits === 40, "Job chargedCredits is finalized at 40 credits");
  ok(
    (job?.settings as any)?.resolution?.operatorId === "ops-dan",
    "Job settings records operator audit trail"
  );

  // Verify asset creation in database
  const asset = state.assets.get("vasset-manual-recov-1");
  ok(Boolean(asset), "GeneratedAsset record created in database with specified ID");
  ok(asset?.userId === user.id, "Asset is bound to the correct owner userId");
  ok(asset?.width === 1280 && asset?.height === 720, "Asset records exact dimensions (1280x720)");
  ok(asset?.durationSeconds === 5.0, "Asset records verified duration (5.0s)");
  ok(asset?.sizeBytes === 3145728, "Asset records exact file size in bytes");

  // Verify credit wallet was NOT refunded (credits finalized for completed output)
  const wallet = state.wallets.get(user.id);
  ok(wallet?.balance === 60, "Credit wallet balance remains at 60 (credits finalized, no refund)");
}

// ===========================================================================
// Section 7: End-to-End runCli Execution
// ===========================================================================
section("Section 7: End-to-End runCli Execution Flow");

{
  const { client, seedUser, seedJob } = createMockCliDb();
  const user = { id: "user_e2e_400", email: "e2e@pixora.test" };
  seedUser(user, 100);

  seedJob(
    {
      id: "vjob-e2e-1",
      userId: user.id,
      status: "PROCESSING",
      jobType: "VIDEO_WAN_2_1",
      estimatedCredits: 40,
      chargedCredits: null,
      provider: "fal",
      providerJobId: "fal-e2e-1",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      settings: {
        submission: {
          unresolved: true,
          reviewStatus: "pending_operator_review",
        },
      },
      user,
    },
    40
  );

  // 1. Dry run CLI call exits with 0
  const dryCode = await runCli(
    [
      "--job-id=vjob-e2e-1",
      "--action=failed",
      "--operator=ops-e2e",
      '--reason="Testing dry run CLI runner output"',
    ],
    client
  );
  ok(dryCode === 0, "runCli with dry run returns exit code 0");

  // 2. Confirmed CLI call exits with 0
  const confirmCode = await runCli(
    [
      "--job-id=vjob-e2e-1",
      "--action=failed",
      "--operator=ops-e2e",
      '--reason="Testing confirmed execution CLI runner"',
      "--confirm",
    ],
    client
  );
  ok(confirmCode === 0, "runCli with --confirm returns exit code 0");

  // 3. Validation error call exits with 1
  const errorCode = await runCli(
    [
      "--job-id=vjob-e2e-1", // already failed!
      "--action=failed",
      "--operator=ops-e2e",
      '--reason="Trying to refund already terminal job"',
      "--confirm",
    ],
    client
  );
  ok(errorCode === 1, "runCli with terminal job returns exit code 1");
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n========================================`);
console.log(`Operator CLI Test Results:`);
console.log(`Passed: ${pass}`);
console.log(`Failed: ${fail}`);
console.log(`Total:  ${pass + fail}`);
console.log(`========================================\n`);

if (fail > 0) {
  process.exit(1);
}
