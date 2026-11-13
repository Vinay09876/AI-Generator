// Post-S8 remediation tests (no database, no network, no external calls).
//   npm run test:post-s8
// Covers: purchase availability, production mock-webhook rejection, webhook row lifecycle,
// session account-status revocation, session-cookie detection, startup env validation (value-free
// errors), Prisma CLI database-URL resolution.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { getPurchaseAvailability, isMockGatewayAllowed } from "../src/features/billing/availability";
import { handleCreateOrderRequest } from "../src/features/billing/api/orders-handler";
import { handleVerifyPaymentRequest } from "../src/features/billing/api/verify-handler";
import { handleRazorpayWebhookRequest } from "../src/features/billing/api/webhook-handler";
import { processPendingPaymentWebhookBatch } from "../src/features/billing/api/processor";
import { classifyAccount, isSessionAccountActive } from "../src/features/auth/account-status";
import { hasSessionCookieName } from "../src/lib/session-cookie";
import { validateStartupEnv, enforceStartupEnv, describeStartupEnvReport, validateClipperWorkerEnv } from "../src/lib/env-startup";
import { resolvePrismaCliDatabaseUrl } from "../prisma/cli-database-url";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

const envObj = process.env as Record<string, string | undefined>;
async function withNodeEnv<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = envObj.NODE_ENV;
  envObj.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    envObj.NODE_ENV = prev;
  }
}

/** A db client that fails the test if ANY model method is touched. */
const untouchableDb = new Proxy({}, {
  get(_t, model) {
    if (model === "then") return undefined;
    return new Proxy({}, { get(_m, method) { return () => { throw new Error(`DB touched: ${String(model)}.${String(method)}`); }; } });
  },
});

/** Minimal in-memory PaymentWebhookEvent store matching the Prisma calls used by webhook-store. */
function webhookDb() {
  const rows = new Map<string, any>();
  let seq = 0;
  const matchOr = (e: any, or: any[], now = new Date()) =>
    or.some((c) => c.status === e.status && (!c.leaseExpiresAt || (e.leaseExpiresAt && e.leaseExpiresAt < (c.leaseExpiresAt.lt ?? now))));
  const client = {
    paymentWebhookEvent: {
      create: async ({ data }: any) => {
        for (const r of rows.values()) if (r.gateway === data.gateway && r.eventId === data.eventId) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        const row = { id: `pwe_${++seq}`, attempts: 0, processingToken: null, leaseExpiresAt: null, lastError: null, createdAt: new Date(), ...data };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        if (where.gateway_eventId) return [...rows.values()].find((r) => r.gateway === where.gateway_eventId.gateway && r.eventId === where.gateway_eventId.eventId) ?? null;
        return rows.get(where.id) ?? null;
      },
      findMany: async ({ where, take }: any) => {
        let list = [...rows.values()];
        if (where?.processingToken) list = list.filter((r) => r.processingToken === where.processingToken);
        if (where?.status) list = list.filter((r) => r.status === where.status);
        if (where?.id?.in) list = list.filter((r) => where.id.in.includes(r.id));
        if (where?.OR) list = list.filter((r) => matchOr(r, where.OR));
        return take ? list.slice(0, take) : list;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows.values()) {
          if (where.id?.in ? !where.id.in.includes(r.id) : where.id && where.id !== r.id) continue;
          if (where.status && r.status !== where.status) continue;
          if (where.processingToken && r.processingToken !== where.processingToken) continue;
          if (where.OR && !matchOr(r, where.OR)) continue;
          const { attempts, ...rest } = data;
          if (attempts?.increment) r.attempts += attempts.increment;
          Object.assign(r, rest);
          count++;
        }
        return { count };
      },
      update: async ({ where, data }: any) => Object.assign(rows.get(where.id), data),
    },
  };
  return { rows, client };
}

const signedWebhook = (body: object, secret: string, header = "x-mock-signature") => {
  const raw = JSON.stringify(body);
  return new Request("https://yourai.example/api/webhooks/payments/razorpay", {
    method: "POST",
    headers: { "content-type": "application/json", [header]: createHmac("sha256", secret).update(raw).digest("hex") },
    body: raw,
  });
};

console.log("\n[1] Purchase availability");
await test("production: purchases disabled, mock gateway not allowed", () => {
  const a = getPurchaseAvailability({ NODE_ENV: "production" });
  assert.equal(a.enabled, false);
  assert.equal(isMockGatewayAllowed({ NODE_ENV: "production" }), false);
});
await test("development/test: mock purchases available", () => {
  assert.deepEqual(getPurchaseAvailability({ NODE_ENV: "development" }), { enabled: true, gateway: "mock" });
  assert.equal(isMockGatewayAllowed({ NODE_ENV: "test" }), true);
});
await test("production: POST /api/billing/orders -> 503 PURCHASES_DISABLED, no DB access", () =>
  withNodeEnv("production", async () => {
    const res = await handleCreateOrderRequest(
      new Request("https://yourai.example/api/billing/orders", { method: "POST", body: JSON.stringify({ packageId: "PKG_STARTER", gateway: "mock" }) }),
      { getUserId: async () => "usr_1", dbClient: untouchableDb, trustedOrigins: () => ["https://yourai.example"] },
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "PURCHASES_DISABLED");
  }));
await test("production: POST /api/billing/verify -> 503 PURCHASES_DISABLED, no DB access", () =>
  withNodeEnv("production", async () => {
    const res = await handleVerifyPaymentRequest(
      new Request("https://yourai.example/api/billing/verify", { method: "POST", body: JSON.stringify({ orderId: "o", gatewayOrderId: "g", gatewayPaymentId: "p", gatewaySignature: "s" }) }),
      { getUserId: async () => "usr_1", dbClient: untouchableDb },
    );
    assert.equal(res.status, 503);
  }));

console.log("\n[2] Payment webhooks");
await test("production: mock-signed webhook with the old default secret is rejected without any DB write", () =>
  withNodeEnv("production", async () => {
    const res = await handleRazorpayWebhookRequest(
      signedWebhook({ id: "evt_forged", event: "payment.captured", orderId: "victim" }, "mock_webhook_secret_dev"),
      { dbClient: untouchableDb },
    );
    assert.ok(res.status === 503 || res.status === 403, `status ${res.status}`);
  }));
await test("production: explicit gateway=mock option is rejected too (defence in depth)", () =>
  withNodeEnv("production", async () => {
    const res = await handleRazorpayWebhookRequest(signedWebhook({ id: "e" }, "s"), { gateway: "mock", webhookSecret: "s", dbClient: untouchableDb });
    assert.ok(res.status === 503 || res.status === 403);
  }));
await test("non-production: invalid signature -> 401 and nothing stored", () =>
  withNodeEnv("test", async () => {
    const res = await handleRazorpayWebhookRequest(signedWebhook({ id: "e" }, "wrong-secret"), { webhookSecret: "right-secret", dbClient: untouchableDb });
    assert.equal(res.status, 401);
  }));
await test("non-production: verified event is stored and its row ends PROCESSED (lease cleared)", () =>
  withNodeEnv("test", async () => {
    const { rows, client } = webhookDb();
    const res = await handleRazorpayWebhookRequest(signedWebhook({ id: "evt_ok", event: "refund.created" }, "sec"), { webhookSecret: "sec", dbClient: client });
    assert.equal(res.status, 200);
    const row = [...rows.values()][0];
    assert.equal(row.status, "PROCESSED");
    assert.equal(row.processingToken, null);
    assert.equal(row.attempts, 1);
  }));
await test("non-production: failed processing leaves row PENDING with error; cron batch retries it", () =>
  withNodeEnv("test", async () => {
    const { rows, client } = webhookDb();
    // payment.captured with no order reference fails validation inside settlement (before any write)
    const res = await handleRazorpayWebhookRequest(signedWebhook({ id: "evt_bad", event: "payment.captured", payload: {} }, "sec"), { webhookSecret: "sec", dbClient: client });
    assert.equal(res.status, 200, "verified event is acknowledged (durably stored)");
    const row = [...rows.values()][0];
    assert.equal(row.status, "PENDING");
    assert.ok(typeof row.lastError === "string" && row.lastError.length > 0, "error recorded on the row");
    const batch = await processPendingPaymentWebhookBatch({ dbClient: client, maxAttempts: 2 });
    assert.equal(batch.failedCount, 1);
    assert.equal(row.attempts, 2);
    assert.equal(row.status, "FAILED", "escalates to FAILED at maxAttempts");
  }));
await test("duplicate delivery is acknowledged and not reprocessed", () =>
  withNodeEnv("test", async () => {
    const { rows, client } = webhookDb();
    const body = { id: "evt_dup", event: "refund.created" };
    await handleRazorpayWebhookRequest(signedWebhook(body, "sec"), { webhookSecret: "sec", dbClient: client });
    const res = await handleRazorpayWebhookRequest(signedWebhook(body, "sec"), { webhookSecret: "sec", dbClient: client });
    assert.equal((await res.json()).duplicate, true);
    assert.equal(rows.size, 1);
    assert.equal([...rows.values()][0].attempts, 1);
  }));

console.log("\n[3] Session account status");
await test("classification", () => {
  assert.equal(classifyAccount(null), "missing");
  assert.equal(classifyAccount({ isDeleted: true, isSuspended: false }), "deleted");
  assert.equal(classifyAccount({ isDeleted: false, isSuspended: true }), "suspended");
  assert.equal(classifyAccount({ isDeleted: false, isSuspended: false }), "active");
});
await test("only active accounts keep their session; lookup errors fail closed", async () => {
  const lookup = (row: any) => async () => row;
  assert.equal(await isSessionAccountActive("u", lookup({ isDeleted: false, isSuspended: false })), true);
  assert.equal(await isSessionAccountActive("u", lookup({ isDeleted: false, isSuspended: true })), false);
  assert.equal(await isSessionAccountActive("u", lookup({ isDeleted: true, isSuspended: false })), false);
  assert.equal(await isSessionAccountActive("u", lookup(null)), false);
  assert.equal(await isSessionAccountActive(undefined, lookup({ isDeleted: false, isSuspended: false })), false);
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await isSessionAccountActive("u", async () => { throw new Error("db down"); }), false);
  } finally {
    console.error = origError;
  }
});
await test("session cookie detection (plain, __Secure-, chunked) ignores unrelated cookies", () => {
  assert.equal(hasSessionCookieName(["authjs.session-token"]), true);
  assert.equal(hasSessionCookieName(["__Secure-authjs.session-token.0"]), true);
  assert.equal(hasSessionCookieName(["authjs.csrf-token", "authjs.callback-url"]), false);
});

console.log("\n[4] Startup environment validation");
const SENTINEL = "s3nt1nel-value-must-never-appear";
const fullProd = {
  NODE_ENV: "production",
  DATABASE_URL: `postgresql://postgres:${SENTINEL}@db.example.supabase.co:5432/postgres`,
  AUTH_SECRET: `${SENTINEL}-0123456789`,
  AUTH_TRUST_HOST: "true",
  APP_ORIGIN: "https://staging.example",
  CLOUDFLARE_ACCOUNT_ID: SENTINEL,
  CLOUDFLARE_AI_API_TOKEN: SENTINEL,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: SENTINEL,
  SUPABASE_STORAGE_BUCKET: "generated-assets",
  CRON_SECRET: SENTINEL,
};
await test("complete production config passes", () => assert.equal(validateStartupEnv(fullProd).ok, true));
await test("production requires CRON_SECRET, explicit bucket and AUTH_TRUST_HOST/AUTH_URL", () => {
  const { CRON_SECRET, SUPABASE_STORAGE_BUCKET, AUTH_TRUST_HOST, ...rest } = fullProd;
  const r = validateStartupEnv(rest);
  assert.equal(r.ok, false);
  for (const n of ["CRON_SECRET", "SUPABASE_STORAGE_BUCKET", "AUTH_TRUST_HOST (or AUTH_URL)"]) assert.ok(r.missing.includes(n), n);
});
await test("production enforcement throws with names only — never values", () => {
  const { AUTH_SECRET, APP_ORIGIN, ...rest } = fullProd;
  const bad = { ...rest, DATABASE_URL: `mysql://${SENTINEL}` };
  assert.throws(() => enforceStartupEnv(bad), (e: Error) => {
    assert.ok(!e.message.includes(SENTINEL), "secret value leaked into error");
    assert.match(e.message, /AUTH_SECRET/);
    assert.match(e.message, /APP_ORIGIN/);
    assert.match(e.message, /DATABASE_URL/);
    return true;
  });
});
await test("outside production: same problems only warn (no throw), still value-free", () => {
  const warnings: string[] = [];
  const r = enforceStartupEnv({ NODE_ENV: "development", DATABASE_URL: `x${SENTINEL}` }, { warn: (m: string) => warnings.push(m) });
  assert.equal(r.ok, false);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(SENTINEL));
});
await test("video: FAL_KEY required only when STAGE_8_QA_ALLOWLIST is set", () => {
  assert.equal(validateStartupEnv(fullProd).missing.includes("FAL_KEY"), false);
  assert.ok(validateStartupEnv({ ...fullProd, STAGE_8_QA_ALLOWLIST: "usr_qa" }).missing.includes("FAL_KEY"));
  assert.equal(validateStartupEnv({ ...fullProd, STAGE_8_QA_ALLOWLIST: "usr_qa", FAL_KEY: SENTINEL }).ok, true);
});
await test("legacy STAGE_8_QA_USER_EMAILS is flagged (it is not read by the app)", () => {
  const r = validateStartupEnv({ ...fullProd, STAGE_8_QA_USER_EMAILS: "qa@example.com" });
  assert.ok(r.invalid.some((i) => i.name === "STAGE_8_QA_USER_EMAILS"));
});
await test("NEXT_PUBLIC_-prefixed secrets and bad clipper switch values are flagged", () => {
  const r = validateStartupEnv({ ...fullProd, NEXT_PUBLIC_SUPABASE_SECRET_KEY: SENTINEL, CLIPPER_SUBMISSIONS_ENABLED: "yes" });
  assert.ok(r.invalid.some((i) => i.name === "NEXT_PUBLIC_SUPABASE_SECRET_KEY"));
  assert.ok(r.invalid.some((i) => i.name === "CLIPPER_SUBMISSIONS_ENABLED"));
  assert.ok(!describeStartupEnvReport(r).includes(SENTINEL));
});
await test("payments need no variables in production (purchases disabled)", () => {
  const r = validateStartupEnv(fullProd);
  assert.ok(!r.missing.some((n) => /RAZORPAY|MOCK_/.test(n)));
});
await test("clipper worker env check names missing storage/database variables", () => {
  const r = validateClipperWorkerEnv({ DATABASE_URL: "postgresql://x" });
  assert.deepEqual(r.missing, ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_STORAGE_BUCKET"]);
});

console.log("\n[5] Prisma CLI database URL");
const A = `postgresql://postgres.ref:${SENTINEL}@pooler.example.com:5432/postgres?sslmode=verify-full`;
const A2 = `postgresql://postgres.ref:${SENTINEL}@pooler.example.com:5432/postgres?sslmode=require&sslaccept=strict`;
const B = `postgresql://postgres.other:${SENTINEL}@pooler.example.com:5432/postgres`;
await test("no URL at all (Docker build) -> undefined, so `prisma generate` works", () => assert.equal(resolvePrismaCliDatabaseUrl({}), undefined));
await test("only DATABASE_URL -> DATABASE_URL", () => assert.equal(resolvePrismaCliDatabaseUrl({ DATABASE_URL: A }), A));
await test("MIGRATE_DATABASE_URL for the same database wins", () => assert.equal(resolvePrismaCliDatabaseUrl({ DATABASE_URL: A, MIGRATE_DATABASE_URL: A2 }), A2));
await test("MIGRATE_DATABASE_URL alone is used", () => assert.equal(resolvePrismaCliDatabaseUrl({ MIGRATE_DATABASE_URL: A2 }), A2));
await test("different databases -> refuses, without leaking either URL", () =>
  assert.throws(() => resolvePrismaCliDatabaseUrl({ DATABASE_URL: B, MIGRATE_DATABASE_URL: A2 }), (e: Error) => {
    assert.match(e.message, /identify different databases/);
    assert.ok(!e.message.includes(SENTINEL) && !e.message.includes("pooler.example.com"));
    return true;
  }));
await test("unparseable URL -> names the variable only", () =>
  assert.throws(() => resolvePrismaCliDatabaseUrl({ DATABASE_URL: A, MIGRATE_DATABASE_URL: `not a url ${SENTINEL}` }), (e: Error) => {
    assert.equal(e.message, "MIGRATE_DATABASE_URL is not a valid connection URL.");
    return true;
  }));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
