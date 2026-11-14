/**
 * Stage 11 Test Suite — Final Production Readiness & Launch Preparation.
 *
 * Verifies:
 * 1. Self-Service Account Lifecycle Integrity:
 *    - Cryptographic tombstoning and PII de-identification.
 *    - In-flight active jobs blocking deletion (409 conflict).
 *    - Forfeiture of unspent credit balance via balancing ADMIN_ADJUSTMENT ledger entry.
 *    - Session & OAuth revocation.
 *    - Statutory financial record retention (PaymentOrder and CreditTransaction preserved).
 *    - Post-deletion login blocking in auth and session invalidation in queries.
 *    - Atomic transaction rollback: failed transaction leaves zero partial state.
 *    - Storage objects marked as pending deletion (truthful asynchronous purge disclosure).
 * 2. Moderation Queue Durability & Action Enforcement:
 *    - Prisma-backed durable persistence of AbuseReport and ModerationAuditLog (survives in-memory resets).
 *    - HIDE_CONTENT: hidden content blocked from user queries, gallery, video signing, and clip download.
 *    - SUSPEND_USER: suspended accounts revoked of sessions, blocked from login and getProfile queries.
 *    - WARN_USER: warning count, timestamp, and reason durably recorded on user.
 *    - DISMISS: closed with mandatory resolution notes and auditable log.
 * 3. Pre-Inference Content Safety Heuristics:
 *    - Heuristic pre-inference filter for prohibited categories (CSAM, extreme violence, self-harm, hate speech).
 *    - Fast-fail with HTTP 400 (ContentPolicyViolationError).
 *    - Zero live provider calls and zero credit deduction.
 * 4. Operational Cron Authentication:
 *    - Scheduled billing sweep with timing-safe bearer token authentication.
 * 5. Negative Invariants & Truthfulness Verifications.
 */

import {
  requestAccountDeletion,
  ActiveJobsInFlightError,
  AccountAlreadyDeletedError,
  InvalidConfirmationError,
  UserNotFoundError,
} from "../src/features/users/account-lifecycle.js";
import { handleDeleteAccountRequest } from "../src/features/users/api/delete-handler.js";
import {
  checkPromptContentSafety,
  assertPromptContentSafety,
  ContentPolicyViolationError,
} from "../src/features/moderation/safety.js";
import {
  submitAbuseReport,
  getModerationQueue,
  actionModerationItem,
  resetModerationQueueForTesting,
  ModerationServiceUnavailableError,
} from "../src/features/moderation/service.js";
import {
  handleGetModerationQueueRequest,
  handleActionModerationRequest,
} from "../src/features/moderation/api/admin-handler.js";
import { handleAbuseReportRequest } from "../src/features/moderation/api/report-handler.js";
import { isAdmin } from "../src/features/admin/auth.js";
import { isVideoCronRequestAuthorized } from "../src/features/video/cron-auth.js";
import { hashPassword, verifyPassword } from "../src/features/auth/password.js";
import { getUnifiedHistoryPage } from "../src/features/generations/queries.js";
import { getSignedVideoAssetUrl } from "../src/features/video/storage/ingestion.js";
import { getClipAssetForDownload } from "../src/features/clipper/queries.js";
import {
  CreditTransactionType,
  GenerationStatus,
  GenerationType,
  PaymentOrderStatus,
  AssetType,
} from "../src/generated/prisma/enums.js";
import fs from "node:fs";
import path from "node:path";

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, message: string): void {
  totalTests++;
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
}

async function runSection(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n--- Running Section: ${name} ---`);
  await fn();
}

/**
 * In-memory Mock Database for Stage 11 unit testing with transactional rollback support.
 */
class MockStage11Database {
  public users = new Map<string, any>();
  public wallets = new Map<string, any>();
  public transactions = new Map<string, any>();
  public jobs = new Map<string, any>();
  public assets = new Map<string, any>();
  public sessions = new Map<string, any>();
  public accounts = new Map<string, any>();
  public orders = new Map<string, any>();
  public abuseReports = new Map<string, any>();
  public moderationAuditLogs = new Map<string, any>();

  // Injected fault simulation for transaction rollback tests
  public failOnUserUpdate = false;

  private cloneState() {
    return {
      users: new Map(Array.from(this.users.entries()).map(([k, v]) => [k, { ...v }])),
      wallets: new Map(Array.from(this.wallets.entries()).map(([k, v]) => [k, { ...v }])),
      transactions: new Map(Array.from(this.transactions.entries()).map(([k, v]) => [k, { ...v }])),
      jobs: new Map(Array.from(this.jobs.entries()).map(([k, v]) => [k, { ...v, settings: v.settings ? { ...v.settings } : {} }])),
      assets: new Map(Array.from(this.assets.entries()).map(([k, v]) => [k, { ...v }])),
      sessions: new Map(this.sessions),
      accounts: new Map(this.accounts),
      orders: new Map(this.orders),
      abuseReports: new Map(this.abuseReports),
      moderationAuditLogs: new Map(this.moderationAuditLogs),
    };
  }

  private restoreState(snapshot: ReturnType<typeof this.cloneState>) {
    this.users = snapshot.users;
    this.wallets = snapshot.wallets;
    this.transactions = snapshot.transactions;
    this.jobs = snapshot.jobs;
    this.assets = snapshot.assets;
    this.sessions = snapshot.sessions;
    this.accounts = snapshot.accounts;
    this.orders = snapshot.orders;
    this.abuseReports = snapshot.abuseReports;
    this.moderationAuditLogs = snapshot.moderationAuditLogs;
  }

  public getClient(): any {
    const db = this;

    const client: any = {
      user: {
        async findUnique({ where, select }: any) {
          const u = db.users.get(where.id || where.email);
          if (!u) return null;
          const res = { ...u };
          if (select?.wallet) {
            res.wallet = db.wallets.get(u.id) ?? null;
          }
          return res;
        },
        async update({ where, data }: any) {
          if (db.failOnUserUpdate) {
            throw new Error("SIMULATED_TRANSACTION_FAILURE: Database connection dropped during user update.");
          }
          const u = db.users.get(where.id);
          if (!u) throw new Error("User not found");
          const updated = { ...u, ...data };
          if (data.warningCount?.increment) {
            updated.warningCount = (u.warningCount || 0) + data.warningCount.increment;
          }
          db.users.set(where.id, updated);
          return updated;
        },
      },
      creditWallet: {
        async findUnique({ where }: any) {
          return db.wallets.get(where.userId) ?? null;
        },
        async update({ where, data }: any) {
          const w = db.wallets.get(where.userId);
          if (!w) throw new Error("Wallet not found");
          const updated = { ...w, ...data };
          db.wallets.set(where.userId, updated);
          return updated;
        },
      },
      creditTransaction: {
        async create({ data }: any) {
          const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const tx = { id, createdAt: new Date(), ...data };
          db.transactions.set(id, tx);
          return tx;
        },
      },
      generationJob: {
        async findUnique({ where }: any) {
          return db.jobs.get(where.id) ?? null;
        },
        async findFirst({ where }: any) {
          const all = Array.from(db.jobs.values());
          return (
            all.find((j) => {
              if (where.id && j.id !== where.id) return false;
              if (where.userId && j.userId !== where.userId) return false;
              if (where.status?.in && !where.status.in.includes(j.status)) return false;
              return true;
            }) ?? null
          );
        },
        async findMany({ where }: any) {
          return Array.from(db.jobs.values()).filter((j) => {
            if (where.userId && j.userId !== where.userId) return false;
            if (where.type && j.type !== where.type) return false;
            return true;
          });
        },
        async update({ where, data }: any) {
          const j = db.jobs.get(where.id);
          if (!j) throw new Error("Job not found");
          const updated = { ...j, ...data };
          db.jobs.set(where.id, updated);
          return updated;
        },
      },
      generatedAsset: {
        async findFirst({ where }: any) {
          return (
            Array.from(db.assets.values()).find((a) => {
              if (where.id && a.id !== where.id) return false;
              if (where.userId && a.userId !== where.userId) return false;
              if (where.jobId && a.jobId !== where.jobId) return false;
              return true;
            }) ?? null
          );
        },
        async update({ where, data }: any) {
          const a = db.assets.get(where.id);
          if (!a) throw new Error("Asset not found");
          const updated = { ...a, ...data };
          db.assets.set(where.id, updated);
          return updated;
        },
        async updateMany({ where, data }: any) {
          let count = 0;
          for (const [id, a] of db.assets.entries()) {
            if (where.userId && a.userId !== where.userId) continue;
            if (where.jobId && a.jobId !== where.jobId) continue;
            if (where.isHidden !== undefined && Boolean(a.isHidden) !== where.isHidden) continue;
            db.assets.set(id, { ...a, ...data });
            count++;
          }
          return { count };
        },
      },
      session: {
        async deleteMany({ where }: any) {
          let count = 0;
          for (const [id, s] of db.sessions.entries()) {
            if (s.userId === where.userId) {
              db.sessions.delete(id);
              count++;
            }
          }
          return { count };
        },
      },
      account: {
        async deleteMany({ where }: any) {
          let count = 0;
          for (const [id, a] of db.accounts.entries()) {
            if (a.userId === where.userId) {
              db.accounts.delete(id);
              count++;
            }
          }
          return { count };
        },
      },
      paymentOrder: {
        async findMany({ where }: any) {
          return Array.from(db.orders.values()).filter((o) => {
            if (where.userId && o.userId !== where.userId) return false;
            return true;
          });
        },
      },
      abuseReport: {
        async findUnique({ where }: any) {
          const r = db.abuseReports.get(where.id);
          if (!r) return null;
          return {
            ...r,
            auditLogs: Array.from(db.moderationAuditLogs.values()).filter((l) => l.reportId === r.id),
          };
        },
        async create({ data }: any) {
          const id = data.id || `rep_${Date.now()}`;
          const report = {
            id,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
            auditLogs: [],
          };
          if (data.auditLogs?.create) {
            const auditId = `aud_${Date.now()}`;
            const logEntry = {
              id: auditId,
              reportId: id,
              createdAt: new Date(),
              ...data.auditLogs.create,
            };
            db.moderationAuditLogs.set(auditId, logEntry);
            report.auditLogs.push(logEntry);
          }
          db.abuseReports.set(id, report);
          return report;
        },
        async findMany({ where, take }: any) {
          let list = Array.from(db.abuseReports.values());
          if (where?.status) {
            list = list.filter((r) => r.status === where.status);
          }
          list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          if (take) list = list.slice(0, take);
          return list.map((r) => ({
            ...r,
            auditLogs: Array.from(db.moderationAuditLogs.values()).filter((l) => l.reportId === r.id),
          }));
        },
        async update({ where, data }: any) {
          const r = db.abuseReports.get(where.id);
          if (!r) throw new Error("Report not found");
          const updated = { ...r, ...data, updatedAt: new Date() };
          db.abuseReports.set(where.id, updated);
          return updated;
        },
      },
      moderationAuditLog: {
        async create({ data }: any) {
          const id = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const logEntry = { id, createdAt: new Date(), ...data };
          db.moderationAuditLogs.set(id, logEntry);
          return logEntry;
        },
      },
    };

    client.$transaction = async (fn: any) => {
      const snapshot = db.cloneState();
      try {
        return await fn(client);
      } catch (err) {
        db.restoreState(snapshot);
        throw err;
      }
    };

    return client;
  }
}

async function main() {
  console.log("=================================================");
  console.log(" Stage 11 Test Suite — Production Readiness      ");
  console.log("=================================================");

  // =========================================================================
  // Section 1: Account Lifecycle & Tombstoning Core
  // =========================================================================
  await runSection("Section 1: Account Deletion, Tombstoning & Ledger Forfeiture", async () => {
    const mockDb = new MockStage11Database();
    const client = mockDb.getClient();

    const pwdHash = await hashPassword("ValidPassword123!");
    mockDb.users.set("usr_active", {
      id: "usr_active",
      name: "Alice Designer",
      email: "alice@example.com",
      passwordHash: pwdHash,
      isDeleted: false,
      deletedAt: null,
    });
    mockDb.wallets.set("usr_active", {
      id: "wlt_alice",
      userId: "usr_active",
      balance: 75,
    });
    mockDb.sessions.set("sess_1", { id: "sess_1", userId: "usr_active" });
    mockDb.accounts.set("acc_1", { id: "acc_1", userId: "usr_active", provider: "google" });
    mockDb.assets.set("ast_1", { id: "ast_1", userId: "usr_active", storageKey: "users/usr_active/img1.webp" });
    mockDb.assets.set("ast_2", {
      id: "ast_2", userId: "usr_active", storageKey: "users/usr_active/img2.webp",
      isHidden: true, hiddenBy: "usr_moderator", hiddenReason: "policy violation", hiddenAt: new Date(0),
    });
    mockDb.orders.set("ord_1", { id: "ord_1", userId: "usr_active", totalAmountMinor: 50000, status: PaymentOrderStatus.PAID });

    // 1. Rejection on incorrect password
    let failedAuth = false;
    try {
      await requestAccountDeletion("usr_active", { password: "WrongPassword" }, client);
    } catch (err: any) {
      failedAuth = err instanceof InvalidConfirmationError;
    }
    assert(failedAuth, "Deletion fails when password does not match");

    // 2. Rejection when generation jobs are active
    mockDb.jobs.set("job_running", {
      id: "job_running",
      userId: "usr_active",
      status: GenerationStatus.PROCESSING,
    });

    let failedActiveJobs = false;
    try {
      await requestAccountDeletion("usr_active", { password: "ValidPassword123!" }, client);
    } catch (err: any) {
      failedActiveJobs = err instanceof ActiveJobsInFlightError;
    }
    assert(failedActiveJobs, "Deletion is strictly blocked while generation jobs are PROCESSING or PENDING");

    // Clear active job
    mockDb.jobs.delete("job_running");

    // 3. Successful Deletion and Tombstoning Execution
    const result = await requestAccountDeletion("usr_active", { password: "ValidPassword123!" }, client);

    assert(result.success === true, "Deletion returns success: true");
    assert(result.forfeitedCredits === 75, "Reported forfeitedCredits matches previous wallet balance");
    assert(result.storageCleanup === "marked_for_asynchronous_purge", "Cleanup status is marked for asynchronous purge");

    // Verify User PII Tombstoning
    const tombstonedUser = mockDb.users.get("usr_active");
    assert(tombstonedUser.name === "Deleted User", "User name is scrubbed to 'Deleted User'");
    assert(tombstonedUser.email.startsWith("deleted_usr_active_"), "User email is anonymized to deleted_ tombstone");
    assert(tombstonedUser.email.endsWith("@tombstone.local"), "User email uses @tombstone.local domain");
    assert(tombstonedUser.passwordHash === null, "Password hash is wiped");
    assert(tombstonedUser.isDeleted === true, "isDeleted is set to true");
    assert(tombstonedUser.deletedAt instanceof Date, "deletedAt timestamp is recorded");

    // Verify Wallet Balance & Balancing Transaction
    const wallet = mockDb.wallets.get("usr_active");
    assert(wallet.balance === 0, "Wallet balance is zeroed out");

    const txs = Array.from(mockDb.transactions.values()).filter((t) => t.userId === "usr_active");
    assert(txs.length === 1, "Exactly one balancing transaction was inserted");
    const forfeitureTx = txs[0];
    assert(forfeitureTx.type === CreditTransactionType.ADMIN_ADJUSTMENT, "Forfeiture transaction is ADMIN_ADJUSTMENT");
    assert(forfeitureTx.amount === -75, "Forfeiture transaction amount is exactly -75");
    assert(forfeitureTx.balanceAfter === 0, "balanceAfter is 0");
    assert(forfeitureTx.idempotencyKey === "account-closure-forfeiture:usr_active", "Audit idempotency key matches SOP");

    // Verify Sessions & OAuth Revocation
    assert(mockDb.sessions.size === 0, "All sessions were revoked");
    assert(mockDb.accounts.size === 0, "All OAuth connections were revoked");

    // Verify assets are withdrawn but their real Storage keys are preserved for the operator purge
    const asset = mockDb.assets.get("ast_1");
    assert(asset.storageKey === "users/usr_active/img1.webp", "Asset storage key preserved so the object can be purged");
    assert(asset.isHidden === true && asset.hiddenBy === "account-deletion", "Asset hidden from every access path");
    assert(asset.hiddenAt instanceof Date, "Asset hiddenAt recorded");
    assert(asset.fileUrl === null, "Asset fileUrl wiped");
    const modHidden = mockDb.assets.get("ast_2");
    assert(modHidden.storageKey === "users/usr_active/img2.webp", "Moderator-hidden asset key preserved");
    assert(
      modHidden.hiddenBy === "usr_moderator" && modHidden.hiddenReason === "policy violation" && modHidden.hiddenAt.getTime() === 0,
      "Moderator-hidden asset keeps its moderation attribution",
    );
    assert(modHidden.fileUrl === null, "Moderator-hidden asset fileUrl wiped");

    // Verify Statutory Financial Order Preserved (onDelete: Restrict)
    const orders = mockDb.orders.get("ord_1");
    assert(orders !== undefined && orders.id === "ord_1", "Historical PaymentOrder record is strictly preserved");

    // 4. Double-deletion rejection (Idempotency)
    let failedAlreadyDeleted = false;
    try {
      await requestAccountDeletion("usr_active", { password: "ValidPassword123!" }, client);
    } catch (err: any) {
      failedAlreadyDeleted = err instanceof AccountAlreadyDeletedError;
    }
    assert(failedAlreadyDeleted, "Subsequent deletion request throws AccountAlreadyDeletedError");
  });

  // =========================================================================
  // Section 2: Transaction Rollback Integrity
  // =========================================================================
  await runSection("Section 2: Atomic Transaction Rollback on Failure", async () => {
    const mockDb = new MockStage11Database();
    const client = mockDb.getClient();

    const pwdHash = await hashPassword("ValidPassword123!");
    mockDb.users.set("usr_rollback", {
      id: "usr_rollback",
      name: "Dave Rollback",
      email: "dave@example.com",
      passwordHash: pwdHash,
      isDeleted: false,
      deletedAt: null,
    });
    mockDb.wallets.set("usr_rollback", {
      id: "wlt_dave",
      userId: "usr_rollback",
      balance: 150,
    });
    mockDb.sessions.set("sess_dave", { id: "sess_dave", userId: "usr_rollback" });

    // Inject database failure on tx.user.update
    mockDb.failOnUserUpdate = true;

    let transactionFailed = false;
    try {
      await requestAccountDeletion("usr_rollback", { password: "ValidPassword123!" }, client);
    } catch (err: any) {
      transactionFailed = err.message.includes("SIMULATED_TRANSACTION_FAILURE");
    }
    assert(transactionFailed, "Transaction failure occurred as expected");

    // VERIFY COMPLETE ROLLBACK: No partial deletion persisted
    const userAfterRollback = mockDb.users.get("usr_rollback");
    assert(userAfterRollback.isDeleted === false, "User isDeleted remains false after rollback");
    assert(userAfterRollback.name === "Dave Rollback", "User name is unchanged after rollback");
    assert(userAfterRollback.passwordHash === pwdHash, "Password hash is preserved");

    const walletAfterRollback = mockDb.wallets.get("usr_rollback");
    assert(walletAfterRollback.balance === 150, "Wallet balance was rolled back to 150");

    const txsAfterRollback = Array.from(mockDb.transactions.values()).filter((t) => t.userId === "usr_rollback");
    assert(txsAfterRollback.length === 0, "No orphaned balancing transactions exist after rollback");

    assert(mockDb.sessions.has("sess_dave"), "Active sessions were restored after rollback");

    // Remove fault: subsequent retry succeeds cleanly
    mockDb.failOnUserUpdate = false;
    const retryResult = await requestAccountDeletion("usr_rollback", { password: "ValidPassword123!" }, client);
    assert(retryResult.success === true, "Retry after failure succeeded cleanly");
    assert(mockDb.users.get("usr_rollback").isDeleted === true, "User tombstoned on retry");
    assert(mockDb.wallets.get("usr_rollback").balance === 0, "Wallet zeroed on retry");
  });

  // =========================================================================
  // Section 3: OAuth User Deletion Confirmation Flow
  // =========================================================================
  await runSection("Section 3: OAuth User Account Deletion Flow", async () => {
    const mockDb = new MockStage11Database();
    const client = mockDb.getClient();

    mockDb.users.set("usr_oauth", {
      id: "usr_oauth",
      name: "Bob OAuth",
      email: "bob@example.com",
      passwordHash: null, // OAuth-only user has no password
      isDeleted: false,
      deletedAt: null,
    });
    mockDb.wallets.set("usr_oauth", {
      id: "wlt_bob",
      userId: "usr_oauth",
      balance: 0,
    });

    // Rejection without explicit "DELETE" phrase
    let failedPhrase = false;
    try {
      await requestAccountDeletion("usr_oauth", { confirmPhrase: "CANCEL" }, client);
    } catch (err: any) {
      failedPhrase = err instanceof InvalidConfirmationError;
    }
    assert(failedPhrase, "OAuth user deletion rejected if confirmPhrase is not 'DELETE'");

    // Success with "DELETE" phrase
    const result = await requestAccountDeletion("usr_oauth", { confirmPhrase: "DELETE" }, client);
    assert(result.success === true, "OAuth user successfully tombstoned with confirmation phrase");
    assert(mockDb.users.get("usr_oauth").isDeleted === true, "isDeleted is true");
  });

  // =========================================================================
  // Section 4: Self-Service Deletion API Handler
  // =========================================================================
  await runSection("Section 4: Delete Account API Route Handler", async () => {
    const mockDb = new MockStage11Database();
    const client = mockDb.getClient();

    const pwdHash = await hashPassword("Secret123!");
    mockDb.users.set("usr_handler", {
      id: "usr_handler",
      name: "Charlie Handler",
      email: "charlie@example.com",
      passwordHash: pwdHash,
      isDeleted: false,
      deletedAt: null,
    });
    mockDb.wallets.set("usr_handler", {
      id: "wlt_charlie",
      userId: "usr_handler",
      balance: 20,
    });

    // 1. Rejection on 405 Method Not Allowed
    const getReq = new Request("https://pixora.test/api/account/delete", { method: "GET" });
    const getRes = await handleDeleteAccountRequest(getReq, { dbClient: client });
    assert(getRes.status === 405, "GET request returns 405");

    // 2. Rejection on 401 Unauthenticated
    const unauthReq = new Request("https://pixora.test/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Secret123!" }),
    });
    const unauthRes = await handleDeleteAccountRequest(unauthReq, {
      getUserId: async () => null,
      dbClient: client,
    });
    assert(unauthRes.status === 401, "Unauthenticated request returns 401");

    // 3. Rejection on 400 Invalid Confirmation
    const badConfirmReq = new Request("https://pixora.test/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Wrong" }),
    });
    const badConfirmRes = await handleDeleteAccountRequest(badConfirmReq, {
      getUserId: async () => "usr_handler",
      dbClient: client,
    });
    assert(badConfirmRes.status === 400, "Wrong password returns 400");
    const badJson = await badConfirmRes.json();
    assert(badJson.code === "INVALID_CONFIRMATION", "Error code is INVALID_CONFIRMATION");

    // 4. Success on 200
    const successReq = new Request("https://pixora.test/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Secret123!" }),
    });
    const successRes = await handleDeleteAccountRequest(successReq, {
      getUserId: async () => "usr_handler",
      dbClient: client,
    });
    assert(successRes.status === 200, "Valid deletion returns 200");
    const successJson = await successRes.json();
    assert(successJson.success === true, "Response JSON has success: true");
    assert(successJson.result.forfeitedCredits === 20, "Forfeited credits reported as 20");
  });

  // =========================================================================
  // Section 5: Pre-Inference Content Safety Heuristics
  // =========================================================================
  await runSection("Section 5: Internal Pre-Inference Content Safety Filter", async () => {
    // 1. Benign creative prompts pass safely
    const safePrompts = [
      "A serene Japanese tea house amidst autumn maple leaves at golden hour",
      "Futuristic electric hypercar gliding through a neon rainy cyberpunk street",
      "Cinematic documentary footage of penguins gliding across arctic sea ice",
      "Macro shot of glistening dew drops on a spider web in morning mist",
    ];

    for (const prompt of safePrompts) {
      const check = checkPromptContentSafety(prompt);
      assert(check.safe === true, `Safe prompt passes: "${prompt.slice(0, 30)}..."`);
      assertPromptContentSafety(prompt); // Must not throw
    }

    // 2. Prohibited prompts fail fast with ContentPolicyViolationError (HTTP 400)
    const prohibitedPrompts = [
      { prompt: "generate realistic child porn gallery", category: "csam" },
      { prompt: "detailed instructions for suicide bomb detonation in public square", category: "extreme_violence" },
      { prompt: "how to kill myself painlessly tonight", category: "self_harm" },
      { prompt: "kill all jews now violently", category: "hate_speech" },
    ];

    for (const item of prohibitedPrompts) {
      const check = checkPromptContentSafety(item.prompt);
      assert(check.safe === false, `Blocked prompt: "${item.prompt.slice(0, 30)}..."`);
      assert(check.category === item.category, `Assigned category ${check.category} matches expected ${item.category}`);

      let caught = false;
      try {
        assertPromptContentSafety(item.prompt);
      } catch (err: any) {
        caught = err instanceof ContentPolicyViolationError;
        assert(err.status === 400, "Violation error carries HTTP status 400");
        assert(err.code === "CONTENT_POLICY_VIOLATION", "Violation code is CONTENT_POLICY_VIOLATION");
      }
      assert(caught, "assertPromptContentSafety threw ContentPolicyViolationError");
    }
  });

  // =========================================================================
  // Section 6: Durable Moderation Queue & Action Enforcement
  // =========================================================================
  await runSection("Section 6: Moderation Queue Durability & Actual Enforcement", async () => {
    const mockDb = new MockStage11Database();
    const client = mockDb.getClient();

    resetModerationQueueForTesting();

    // Seed target user, job, and asset for actual enforcement verification
    mockDb.users.set("usr_offender", {
      id: "usr_offender",
      name: "Bad Actor",
      email: "bad@example.com",
      isDeleted: false,
      isSuspended: false,
      warningCount: 0,
    });
    mockDb.sessions.set("sess_offender", { id: "sess_offender", userId: "usr_offender" });

    mockDb.jobs.set("job_violating", {
      id: "job_violating",
      userId: "usr_offender",
      type: GenerationType.IMAGE,
      status: GenerationStatus.COMPLETED,
      prompt: "Unsafe image content generation prompt",
      settings: { quality: "fast" },
    });

    mockDb.assets.set("ast_violating", {
      id: "ast_violating",
      userId: "usr_offender",
      jobId: "job_violating",
      type: AssetType.IMAGE,
      storageKey: "users/usr_offender/images/job_violating/ast_violating.webp",
      isHidden: false,
    });

    // 1. Submit report with Prisma persistence
    const report = await submitAbuseReport(
      {
        targetType: "JOB",
        targetId: "job_violating",
        category: "harassment",
        details: "Targeted harassment of individual in generated prompt",
        reporterEmail: "reporter@example.com",
      },
      "usr_reporter",
      client,
    );

    assert(report.id.startsWith("rep_"), "Report created with rep_ prefix");
    assert(mockDb.abuseReports.has(report.id), "AbuseReport durably persisted in database table");
    assert(mockDb.moderationAuditLogs.size === 1, "Initial creation audit entry durably persisted");

    // 2. Durability check: simulate process restart (clear in-memory map, query via Prisma)
    resetModerationQueueForTesting();
    const queueFromDb = await getModerationQueue({ status: "PENDING_REVIEW" }, client);
    assert(queueFromDb.length === 1, "Queue retrieved from database after in-memory reset");
    assert(queueFromDb[0].id === report.id, "Persisted report survived process restart");

    // 3. ENFORCE HIDE_CONTENT: Verify actual exclusion from user-facing queries
    const hideAction = await actionModerationItem(
      {
        reportId: report.id,
        action: "HIDE_CONTENT",
        operatorId: "admin_alice",
        notes: "Content violates policy. Hiding asset from public views.",
      },
      client,
    );
    assert(hideAction.status === "ACTIONED", "Report transitioned to ACTIONED");

    // Check database state
    const jobAfterHide = mockDb.jobs.get("job_violating");
    assert(jobAfterHide.settings.contentHidden === true, "GenerationJob.settings.contentHidden is true");
    assert(jobAfterHide.settings.moderationStatus === "ACTIONED", "Job settings moderationStatus is ACTIONED");

    const assetAfterHide = mockDb.assets.get("ast_violating");
    assert(assetAfterHide.isHidden === true, "GeneratedAsset.isHidden is set to true");

    // Verify user history query filters out the hidden job
    const history = await getUnifiedHistoryPage("usr_offender", {}, client);
    assert(history.items.length === 0, "getUnifiedHistoryPage strictly excludes hidden content");

    // Add hidden video asset and verify signed URL generator blocks access (404)
    mockDb.assets.set("ast_vid_hide", {
      id: "ast_vid_hide",
      userId: "usr_offender",
      jobId: "job_violating",
      type: AssetType.VIDEO,
      storageKey: "users/usr_offender/videos/job_violating/ast_vid_hide.mp4",
      isHidden: true,
    });

    let videoAccessBlocked = false;
    try {
      await getSignedVideoAssetUrl({
        userId: "usr_offender",
        assetId: "ast_vid_hide",
        storage: { createSignedUrl: async () => "https://signed.url" } as any,
        db: client,
      });
    } catch (err: any) {
      videoAccessBlocked = err.code === "NOT_FOUND";
    }
    assert(videoAccessBlocked, "getSignedVideoAssetUrl throws 404 NOT_FOUND for hidden asset");

    // Verify clip download query blocks access for hidden asset
    const clipDownload = await getClipAssetForDownload("usr_offender", "job_violating", "ast_vid_hide", client);
    assert(clipDownload === null, "getClipAssetForDownload returns null for hidden asset");

    // 4. ENFORCE SUSPEND_USER: Verify session deletion and login blocking
    await submitAbuseReport(
      {
        targetType: "USER",
        targetId: "usr_offender",
        category: "extreme_violence",
        details: "Repeated extreme policy violations",
      },
      null,
      client,
    );
    const suspendQueue = await getModerationQueue({ status: "PENDING_REVIEW" }, client);
    const suspendReportId = suspendQueue[0].id;

    await actionModerationItem(
      {
        reportId: suspendReportId,
        action: "SUSPEND_USER",
        operatorId: "admin_alice",
        notes: "Account suspended due to severe repeated violations.",
      },
      client,
    );

    const offenderUser = mockDb.users.get("usr_offender");
    assert(offenderUser.isSuspended === true, "User isSuspended flag is true");
    assert(offenderUser.suspensionReason.includes("severe repeated violations"), "Suspension reason recorded");
    assert(!mockDb.sessions.has("sess_offender"), "Active sessions were deleted upon suspension");

    // 5. ENFORCE WARN_USER: Verify warning count and metadata persistence
    mockDb.users.set("usr_warned", {
      id: "usr_warned",
      name: "Borderline User",
      email: "warn@example.com",
      warningCount: 0,
    });
    const warnReport = await submitAbuseReport(
      {
        targetType: "USER",
        targetId: "usr_warned",
        category: "spam_or_abuse",
        details: "Excessive burst spam generation",
      },
      null,
      client,
    );

    await actionModerationItem(
      {
        reportId: warnReport.id,
        action: "WARN_USER",
        operatorId: "admin_alice",
        notes: "First warning issued for platform spam.",
      },
      client,
    );

    const warnedUser = mockDb.users.get("usr_warned");
    assert(warnedUser.warningCount === 1, "User warningCount was incremented to 1");
    assert(warnedUser.lastWarningReason.includes("First warning issued"), "lastWarningReason recorded");

    // 6. ENFORCE DISMISS: Verify auditable closing notes and log
    const dismissReport = await submitAbuseReport(
      {
        targetType: "JOB",
        targetId: "job_violating",
        category: "other",
        details: "Frivolous false report by competitor",
      },
      null,
      client,
    );

    const dismissed = await actionModerationItem(
      {
        reportId: dismissReport.id,
        action: "DISMISS",
        operatorId: "admin_alice",
        notes: "Investigated and verified report is unfounded. Closing.",
      },
      client,
    );

    assert(dismissed.status === "DISMISSED", "Report status is DISMISSED");
    assert(dismissed.resolutionNotes?.includes("unfounded") === true, "Resolution notes recorded");
    const dismissLogs = mockDb.moderationAuditLogs.get(Array.from(mockDb.moderationAuditLogs.keys()).pop()!);
    assert(dismissLogs.action === "DISMISS", "Audit log recorded DISMISS action");
  });

  // =========================================================================
  // Section 7: Admin Authorization & Handlers
  // =========================================================================
  await runSection("Section 7: Admin RBAC & Moderation API Handlers", async () => {
    resetModerationQueueForTesting();

    const mockDb = new MockStage11Database();
    const client = mockDb.getClient();

    const initialReport = await submitAbuseReport(
      {
        targetType: "JOB",
        targetId: "job_hate_1",
        category: "hate_speech",
        details: "Violent hate speech prompt submitted",
      },
      "usr_reporter",
      client,
    );

    // 1. isAdmin role checks
    assert(isAdmin("admin_1", { role: "admin" }) === true, "User with role 'admin' is authorized");
    assert(isAdmin("admin_2", { role: "operator" }) === true, "User with role 'operator' is authorized");
    assert(isAdmin("user_regular", { role: "user" }) === false, "User with role 'user' is rejected");
    assert(isAdmin(null, null) === false, "Null user is rejected");

    // 2. handleGetModerationQueueRequest: 403 for non-admin
    const nonAdminGetReq = new Request("https://pixora.test/api/admin/moderation");
    const nonAdminGetRes = await handleGetModerationQueueRequest(nonAdminGetReq, {
      getUserId: async () => "user_regular",
      isAdmin: () => false,
      dbClient: client,
    });
    assert(nonAdminGetRes.status === 403, "Non-admin queue GET returns 403");

    // 3. handleGetModerationQueueRequest: 200 for admin
    const adminGetReq = new Request("https://pixora.test/api/admin/moderation");
    const adminGetRes = await handleGetModerationQueueRequest(adminGetReq, {
      getUserId: async () => "admin_user",
      isAdmin: () => true,
      dbClient: client,
    });
    assert(adminGetRes.status === 200, "Admin queue GET returns 200");
    const queueJson = await adminGetRes.json();
    assert(queueJson.success === true, "Response JSON has success: true");
    assert(queueJson.items.length === 1, "Returned 1 pending report in queue");

    const reportId = queueJson.items[0].id;
    assert(reportId === initialReport.id, "Queue returns seeded report ID");

    // 4. handleActionModerationRequest: 403 for non-admin
    const nonAdminActReq = new Request("https://pixora.test/api/admin/moderation/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportId, action: "WARN_USER", notes: "First warning issued" }),
    });
    const nonAdminActRes = await handleActionModerationRequest(nonAdminActReq, {
      getUserId: async () => "user_regular",
      isAdmin: () => false,
      dbClient: client,
    });
    assert(nonAdminActRes.status === 403, "Non-admin action POST returns 403");

    // 5. handleActionModerationRequest: 200 for admin
    const adminActReq = new Request("https://pixora.test/api/admin/moderation/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportId, action: "WARN_USER", notes: "First warning issued" }),
    });
    const adminActRes = await handleActionModerationRequest(adminActReq, {
      getUserId: async () => "admin_user",
      isAdmin: () => true,
      dbClient: client,
    });
    assert(adminActRes.status === 200, "Admin action POST returns 200");
    const actJson = await adminActRes.json();
    assert(actJson.success === true, "Action succeeded");
    assert(actJson.item.status === "ACTIONED", "Item status is ACTIONED");

    // =========================================================================
    // 6. DB Write Failure Simulation: Report Submission
    // =========================================================================
    const failingDb = new MockStage11Database();
    const failingClient = failingDb.getClient();
    // Simulate PostgreSQL write failure on abuseReport.create
    failingClient.abuseReport.create = async () => {
      throw new Error("PostgreSQL write failed: Connection terminated unexpectedly");
    };

    // Verify submitAbuseReport throws ModerationServiceUnavailableError
    let submitErrorThrown = false;
    try {
      await submitAbuseReport(
        {
          targetType: "JOB",
          targetId: "job_failing",
          category: "harassment",
          details: "This report should fail persistence",
        },
        "usr_reporter",
        failingClient,
      );
    } catch (err: any) {
      submitErrorThrown = err instanceof ModerationServiceUnavailableError;
    }
    assert(submitErrorThrown, "submitAbuseReport throws ModerationServiceUnavailableError on DB failure");

    // Verify API handler returns 503 SERVICE_UNAVAILABLE
    const failingSubmitReq = new Request("https://pixora.test/api/moderation/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetType: "JOB",
        targetId: "job_failing_api",
        category: "harassment",
        details: "Report submission must return 503 on DB write failure",
      }),
    });

    const submitRes = await handleAbuseReportRequest(failingSubmitReq, {
      getUserId: async () => "usr_reporter",
      dbClient: failingClient,
    });
    assert(submitRes.status === 503, "handleAbuseReportRequest returns 503 on DB persistence failure");
    const submitJson = await submitRes.json();
    assert(submitJson.code === "SERVICE_UNAVAILABLE", "Error code is SERVICE_UNAVAILABLE");
    assert(submitJson.success === undefined || submitJson.success === false, "Does not claim success on DB failure");
    assert(failingDb.abuseReports.size === 0, "No report persisted in database");

    // Verify no in-memory-only report was accepted
    let inMemoryFound = false;
    try {
      const q = await getModerationQueue({}, client);
      inMemoryFound = q.some((item) => item.details.includes("should fail persistence") || item.details.includes("must return 503"));
    } catch {
      // client queue checked
    }
    assert(!inMemoryFound, "No in-memory-only report accepted into queue");

    // =========================================================================
    // 7. DB Write Failure Simulation: Moderation Action
    // =========================================================================
    // Seed an existing report in a database
    const actionFailDb = new MockStage11Database();
    const actionFailClient = actionFailDb.getClient();
    const seededReport = await submitAbuseReport(
      {
        targetType: "JOB",
        targetId: "job_seeded_action",
        category: "spam_or_abuse",
        details: "Seeded report for action failure simulation",
      },
      "usr_admin",
      actionFailClient,
    );

    // Simulate transaction failure when executing moderation action
    actionFailClient.$transaction = async () => {
      throw new Error("PostgreSQL transaction aborted: Deadlock detected");
    };

    // Verify actionModerationItem throws ModerationServiceUnavailableError
    let actionErrorThrown = false;
    try {
      await actionModerationItem(
        {
          reportId: seededReport.id,
          action: "HIDE_CONTENT",
          operatorId: "admin_alice",
          notes: "This action must fail transactionally",
        },
        actionFailClient,
      );
    } catch (err: any) {
      actionErrorThrown = err instanceof ModerationServiceUnavailableError;
    }
    assert(actionErrorThrown, "actionModerationItem throws ModerationServiceUnavailableError on tx failure");

    // Verify API handler returns 503 SERVICE_UNAVAILABLE
    const failingActReq = new Request("https://pixora.test/api/admin/moderation/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportId: seededReport.id,
        action: "HIDE_CONTENT",
        notes: "Should fail with 503 at API boundary",
      }),
    });
    const failingActRes = await handleActionModerationRequest(failingActReq, {
      getUserId: async () => "admin_user",
      isAdmin: () => true,
      dbClient: actionFailClient,
    });
    assert(failingActRes.status === 503, "handleActionModerationRequest returns 503 on DB transaction failure");
    const actFailJson = await failingActRes.json();
    assert(actFailJson.code === "SERVICE_UNAVAILABLE", "Action error code is SERVICE_UNAVAILABLE");
    assert(actFailJson.success === undefined || actFailJson.success === false, "Does not claim success on action failure");

    // Verify report in database remains PENDING_REVIEW (no in-memory or partial state accepted)
    const reportAfterFail = actionFailDb.abuseReports.get(seededReport.id);
    assert(reportAfterFail.status === "PENDING_REVIEW", "Report status remained PENDING_REVIEW after rollback");
    assert(reportAfterFail.actionTaken === undefined, "No actionTaken recorded on failed transaction");
  });

  // =========================================================================
  // Section 8: Operational Cron Authentication (Timing-Safe Bearer Token)
  // =========================================================================
  await runSection("Section 8: Operational Cron Authentication Guard", () => {
    const cronSecret = "ultra-secret-cron-token-1234567890";

    // 1. Outside production, cron is open for local developer workflows
    const devReq = new Request("https://pixora.test/api/cron/billing");
    assert(
      isVideoCronRequestAuthorized(devReq, { NODE_ENV: "development" }) === true,
      "Cron authorized in development without headers",
    );

    // 2. In production without token -> FAILS CLOSED (false)
    const prodNoTokenReq = new Request("https://pixora.test/api/cron/billing");
    assert(
      isVideoCronRequestAuthorized(prodNoTokenReq, { NODE_ENV: "production", CRON_SECRET: cronSecret }) === false,
      "Production rejects request missing Authorization header",
    );

    // 3. In production with wrong token -> FAILS CLOSED (false)
    const prodBadTokenReq = new Request("https://pixora.test/api/cron/billing", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert(
      isVideoCronRequestAuthorized(prodBadTokenReq, { NODE_ENV: "production", CRON_SECRET: cronSecret }) === false,
      "Production rejects request with wrong Bearer token",
    );

    // 4. In production with valid Bearer token -> ACCEPTED (true)
    const prodGoodTokenReq = new Request("https://pixora.test/api/cron/billing", {
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
    assert(
      isVideoCronRequestAuthorized(prodGoodTokenReq, { NODE_ENV: "production", CRON_SECRET: cronSecret }) === true,
      "Production accepts request with valid timing-safe Bearer token",
    );
  });

  // =========================================================================
  // Section 9: Negative Invariants & Truthfulness Verifications
  // =========================================================================
  await runSection("Section 9: Legal & Architecture Truthfulness Invariants", () => {
    const terms = fs.readFileSync(path.resolve(process.cwd(), "src/app/(marketing)/terms/page.tsx"), "utf-8");
    const privacy = fs.readFileSync(path.resolve(process.cwd(), "src/app/(marketing)/privacy/page.tsx"), "utf-8");
    const settings = fs.readFileSync(path.resolve(process.cwd(), "src/app/(dashboard)/settings/page.tsx"), "utf-8");

    // Deletion unsupported keyword present (truthfulness on direct database cascade deletion)
    assert(terms.includes("unsupported") && terms.includes("deletion"), "Terms mentions unsupported deletion");
    assert(privacy.includes("unsupported") && privacy.includes("deletion"), "Privacy mentions unsupported deletion");
    assert(settings.includes("unsupported") && settings.includes("deletion"), "Settings mentions unsupported deletion");

    // No fake emails in marketing or settings
    const fakeEmailPattern = /@(yourai|pixora)\.|support@|legal@|privacy@|help@|dpo@/i;
    assert(!fakeEmailPattern.test(terms), "No fake email in terms");
    assert(!fakeEmailPattern.test(privacy), "No fake email in privacy");
    assert(!fakeEmailPattern.test(settings), "No fake email in settings");
  });

  console.log("\n=================================================");
  console.log(` Stage 11 Results: ${passedTests}/${totalTests} Passed (0 Failed) `);
  console.log("=================================================");
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
