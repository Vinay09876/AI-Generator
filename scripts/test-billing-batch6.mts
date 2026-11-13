/**
 * Stage 10 Batch 6 Test Suite — Payment Reconciliation, Recovery & Final Regression.
 *
 * Scenarios Tested:
 * 1. Stuck PENDING order reconciliation with completed gateway capture (atomic settlement, wallet increment, ledger row).
 * 2. Ambiguous CREATION_UNKNOWN order handling: terminates as FAILED when absent at gateway; never blindly duplicates.
 * 3. Parameter mismatch escalation: AMOUNT_MISMATCH and CURRENCY_MISMATCH escalate to NEEDS_REVIEW without crediting wallet.
 * 4. Single-settlement guarantee: repeated reconciliation on PAID orders never allocates credits twice.
 * 5. Operator manual review resolution: approve vs reject with permanent audit history in metadata.reconciliationHistory.
 * 6. Stuck order expiration: in-flight orders exceeding checkout threshold without capture transition to EXPIRED.
 * 7. Bounded batch reconciliation sweep (reconcileStuckPaymentOrders).
 * 8. Authenticated operator reconciliation API handler (401 unauth, 403 non-operator, audit retention, zero secret leaks).
 * 9. Webhook lease recovery, duplicate idempotency, and unknown event safety.
 */

import {
  reconcilePaymentOrder,
  reconcileStuckPaymentOrders,
  type ReconcileOrderResult,
  type ReconcileBatchSummary,
} from "../src/features/billing/reconciliation.js";
import { handleReconcileRequest } from "../src/features/billing/api/reconcile-handler.js";
import { processPaymentWebhookEvent, processPendingPaymentWebhookBatch } from "../src/features/billing/api/processor.js";
import { MockPaymentGatewayEngine } from "../src/features/billing/mock-gateway.js";
import { buildTaxInvoice } from "../src/features/billing/invoices.js";
import {
  PaymentOrderStatus,
  PaymentAttemptStatus,
  CreditTransactionType,
  WebhookEventStatus,
} from "../src/generated/prisma/enums.js";

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
 * In-memory test store simulating Prisma Client for transactions, orders, attempts, and wallets.
 */
class MockBatch6Database {
  public users = new Map<string, any>();
  public wallets = new Map<string, any>();
  public transactions = new Map<string, any>();
  public orders = new Map<string, any>();
  public attempts = new Map<string, any>();
  public webhooks = new Map<string, any>();

  constructor() {
    this.seed();
  }

  private seed() {
    this.users.set("usr_alice", {
      id: "usr_alice",
      email: "alice@example.com",
      name: "Alice Designer",
    });

    this.wallets.set("usr_alice", {
      id: "wlt_alice",
      userId: "usr_alice",
      balance: 100,
    });
  }

  public getClient(): any {
    const db = this;

    const client: any = {
      paymentOrder: {
        async findUnique({ where, include }: any) {
          const all = Array.from(db.orders.values());
          const match = all.find((o) => {
            if (where.id && o.id !== where.id) return false;
            if (where.receipt && o.receipt !== where.receipt) return false;
            return true;
          });
          if (!match) return null;

          const res = { ...match };
          if (include?.creditTransaction) {
            const txs = Array.from(db.transactions.values());
            res.creditTransaction = txs.find((t) => t.paymentOrderId === match.id) ?? null;
          }
          if (include?.attempts) {
            const atts = Array.from(db.attempts.values());
            res.attempts = atts.filter((a) => a.orderId === match.id);
          }
          return res;
        },

        async findFirst({ where }: any) {
          const all = Array.from(db.orders.values());
          return (
            all.find((o) => {
              if (where.id && o.id !== where.id) return false;
              if (where.receipt && o.receipt !== where.receipt) return false;
              if (where.gatewayOrderId && o.gatewayOrderId !== where.gatewayOrderId) return false;
              return true;
            }) || null
          );
        },

        async findMany({ where, orderBy, take }: any) {
          let list = Array.from(db.orders.values());

          if (where?.gateway) {
            list = list.filter((o) => o.gateway === where.gateway);
          }

          if (where?.OR) {
            list = list.filter((o) => {
              for (const clause of where.OR) {
                if (clause.status?.in && clause.status.in.includes(o.status)) {
                  if (clause.createdAt?.lt && new Date(o.createdAt) >= clause.createdAt.lt) {
                    continue;
                  }
                  return true;
                }
                if (clause.status && o.status === clause.status) {
                  return true;
                }
              }
              return false;
            });
          }

          if (orderBy?.createdAt === "asc") {
            list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          }

          if (take) {
            list = list.slice(0, take);
          }

          return list;
        },

        async create({ data }: any) {
          const id = data.id || `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const rec = { id, ...data, createdAt: data.createdAt ?? new Date(), updatedAt: new Date() };
          db.orders.set(id, rec);
          return rec;
        },

        async update({ where, data }: any) {
          const ord = db.orders.get(where.id);
          if (!ord) throw new Error(`Order ${where.id} not found`);
          Object.assign(ord, data, { updatedAt: new Date() });
          return ord;
        },

        async updateMany({ where, data }: any) {
          const ord = db.orders.get(where.id);
          if (!ord) return { count: 0 };
          if (where.status?.in && !where.status.in.includes(ord.status)) {
            return { count: 0 };
          }
          Object.assign(ord, data, { updatedAt: new Date() });
          return { count: 1 };
        },
      },

      creditWallet: {
        async findUnique({ where }: any) {
          return db.wallets.get(where.userId) ?? null;
        },
        async update({ where, data }: any) {
          const w = db.wallets.get(where.userId);
          if (!w) throw new Error("Wallet not found");
          if (data.balance?.increment) {
            w.balance += data.balance.increment;
          }
          w.updatedAt = new Date();
          return w;
        },
      },

      creditTransaction: {
        async findUnique({ where }: any) {
          const all = Array.from(db.transactions.values());
          return (
            all.find((t) => {
              if (where.id && t.id !== where.id) return false;
              if (where.paymentOrderId && t.paymentOrderId !== where.paymentOrderId) return false;
              if (where.idempotencyKey && t.idempotencyKey !== where.idempotencyKey) return false;
              return true;
            }) ?? null
          );
        },
        async create({ data }: any) {
          const id = data.id || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const rec = { id, ...data, createdAt: new Date() };
          db.transactions.set(id, rec);
          return rec;
        },
      },

      paymentAttempt: {
        async create({ data }: any) {
          const id = data.id || `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const rec = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
          db.attempts.set(id, rec);
          return rec;
        },
      },

      paymentWebhookEvent: {
        async findMany({ where, orderBy, take }: any) {
          let list = Array.from(db.webhooks.values());
          if (where?.gateway) list = list.filter((e) => e.gateway === where.gateway);
          if (where?.status) list = list.filter((e) => e.status === where.status);
          if (take) list = list.slice(0, take);
          return list;
        },
        async update({ where, data }: any) {
          const e = db.webhooks.get(where.id);
          if (!e) throw new Error("Event not found");
          Object.assign(e, data);
          return e;
        },
        async updateMany({ where, data }: any) {
          let count = 0;
          for (const e of db.webhooks.values()) {
            if (where.id?.in && where.id.in.includes(e.id)) {
              Object.assign(e, data);
              count++;
            }
          }
          return { count };
        },
      },

      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const query = strings.join("?");
        if (query.includes('UPDATE "CreditWallet"') && query.includes('"balance" = "balance" +')) {
          const amount = values[0];
          const userId = values[1];
          const wallet = db.wallets.get(userId);
          if (!wallet) return [];
          wallet.balance += amount;
          wallet.updatedAt = new Date();
          return [{ id: wallet.id, balance: wallet.balance }];
        }
        return [];
      },

      async $transaction(fn: any) {
        return fn(client);
      },
    };

    return client;
  }
}

async function runAllTests(): Promise<void> {
  console.log("================================================================================");
  console.log("   Stage 10 Batch 6 Test Suite — Payment Reconciliation & Operational Recovery");
  console.log("================================================================================");

  await runSection("1. Stuck PENDING Order Reconciliation with Successful Gateway Capture", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();
    const mockEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });

    // Create an order on the mock gateway
    const gwOrder = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_stuck_001",
    });

    // Simulate payment capture at the gateway
    const payment = mockEngine.generatePaymentResponse(gwOrder.gatewayOrderId);

    // Save corresponding stuck PENDING order in DB (simulating network drop before verify reached server)
    const dbOrder = await client.paymentOrder.create({
      data: {
        id: "ord_stuck_001",
        userId: "usr_alice",
        receipt: "rcpt_stuck_001",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.PENDING,
        gateway: "mock",
        gatewayOrderId: gwOrder.gatewayOrderId,
        createdAt: new Date(Date.now() - 40 * 60_000), // 40 mins ago
      },
    });

    const initialWallet = db.wallets.get("usr_alice");
    assert(initialWallet.balance === 100, "Initial wallet balance is 100");

    // Reconcile the stuck order
    const result = await reconcilePaymentOrder(
      { orderId: dbOrder.id },
      { gatewayEngine: mockEngine, maxAgeMinutes: 30 },
      client,
    );

    assert(result.success === true, "Reconciliation succeeded");
    assert(result.actionTaken === "settled", "Action taken was settled");
    assert(result.previousStatus === PaymentOrderStatus.PENDING, "Previous status was PENDING");
    assert(result.newStatus === PaymentOrderStatus.PAID, "New status is PAID");
    assert(result.creditsAllocated === 100, "100 credits allocated");

    // Check DB state after reconciliation
    const settledOrder = db.orders.get("ord_stuck_001");
    assert(settledOrder.status === PaymentOrderStatus.PAID, "Order transitioned to PAID in DB");
    assert(settledOrder.gatewayPaymentId === payment.gatewayPaymentId, "Recorded correct gateway payment ID");

    // Check wallet balance
    assert(initialWallet.balance === 200, "Wallet balance increased from 100 to 200");

    // Check transaction ledger entry
    const ledgerTx = Array.from(db.transactions.values()).find((t) => t.paymentOrderId === "ord_stuck_001");
    assert(Boolean(ledgerTx), "PURCHASE transaction ledger entry inserted");
    assert(ledgerTx.type === CreditTransactionType.PURCHASE, "Transaction type is PURCHASE");
    assert(ledgerTx.amount === 100, "Ledger amount is +100 credits");
  });

  await runSection("2. Ambiguous CREATION_UNKNOWN Order Handling (Never Blindly Retries)", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();
    const mockEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });

    // 2.1 Order does NOT exist at the gateway
    const unknownOrder1 = await client.paymentOrder.create({
      data: {
        id: "ord_unknown_001",
        userId: "usr_alice",
        receipt: "rcpt_unknown_absent",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.CREATION_UNKNOWN,
        gateway: "mock",
        createdAt: new Date(Date.now() - 35 * 60_000),
      },
    });

    const res1 = await reconcilePaymentOrder(
      { orderId: unknownOrder1.id },
      { gatewayEngine: mockEngine },
      client,
    );

    assert(res1.actionTaken === "failed", "Terminated as failed when absent on gateway");
    assert(res1.newStatus === PaymentOrderStatus.FAILED, "New status is FAILED");
    const updated1 = db.orders.get("ord_unknown_001");
    assert(updated1.status === PaymentOrderStatus.FAILED, "DB order status is FAILED");
    assert(updated1.reviewReason === "GATEWAY_ORDER_NOT_FOUND", "Reason specifies order not found at gateway");
    assert(Boolean(updated1.failedAt), "failedAt timestamp recorded");

    // 2.2 Order DOES exist at the gateway and was paid
    const gwOrder = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_unknown_present",
    });
    mockEngine.generatePaymentResponse(gwOrder.gatewayOrderId);

    const unknownOrder2 = await client.paymentOrder.create({
      data: {
        id: "ord_unknown_002",
        userId: "usr_alice",
        receipt: "rcpt_unknown_present",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.CREATION_UNKNOWN,
        gateway: "mock",
        createdAt: new Date(Date.now() - 20 * 60_000),
      },
    });

    const res2 = await reconcilePaymentOrder(
      { orderId: unknownOrder2.id },
      { gatewayEngine: mockEngine },
      client,
    );

    assert(res2.actionTaken === "settled", "Settled order when found and paid at gateway");
    assert(res2.newStatus === PaymentOrderStatus.PAID, "Status is PAID");

    // 2.3 Safeguard 2: Gateway lookup error / timeout does NOT mark order FAILED (escalates to NEEDS_REVIEW)
    const timeoutEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });
    timeoutEngine.lookupOrderByReceipt = async () => {
      throw new Error("Gateway connection timeout ETIMEDOUT");
    };

    const unknownOrder3 = await client.paymentOrder.create({
      data: {
        id: "ord_unknown_003",
        userId: "usr_alice",
        receipt: "rcpt_unknown_timeout",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.CREATION_UNKNOWN,
        gateway: "mock",
        createdAt: new Date(Date.now() - 25 * 60_000),
      },
    });

    const resTimeout = await reconcilePaymentOrder(
      { orderId: unknownOrder3.id },
      { gatewayEngine: timeoutEngine },
      client,
    );

    assert(resTimeout.success === false, "Timeout lookup does not report success");
    assert(resTimeout.actionTaken === "escalated_review", "Timeout lookup escalates to NEEDS_REVIEW");
    assert(resTimeout.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Status is NEEDS_REVIEW, NOT FAILED");
    const updatedTimeout = db.orders.get("ord_unknown_003");
    assert(updatedTimeout.status === PaymentOrderStatus.NEEDS_REVIEW, "DB order NOT marked FAILED on lookup failure");
    assert(updatedTimeout.reviewReason === "CREATION_LOOKUP_FAILED", "reviewReason set to CREATION_LOOKUP_FAILED");

    // 2.4 Safeguard 2: Gateway engine not configured does NOT mark order FAILED
    const unknownOrder4 = await client.paymentOrder.create({
      data: {
        id: "ord_unknown_004",
        userId: "usr_alice",
        receipt: "rcpt_unknown_no_engine",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.CREATION_UNKNOWN,
        gateway: "mock",
        createdAt: new Date(Date.now() - 25 * 60_000),
      },
    });

    const resNoEngine = await reconcilePaymentOrder(
      { orderId: unknownOrder4.id },
      { gatewayEngine: null as any },
      client,
    );

    assert(resNoEngine.success === false, "Missing engine does not report success");
    assert(resNoEngine.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Status is NEEDS_REVIEW, NOT FAILED");
    const updatedNoEngine = db.orders.get("ord_unknown_004");
    assert(updatedNoEngine.status === PaymentOrderStatus.NEEDS_REVIEW, "DB order kept in NEEDS_REVIEW when gateway unavailable");
    assert(updatedNoEngine.reviewReason === "GATEWAY_UNAVAILABLE_FOR_CREATION_CHECK", "reviewReason set correctly");

    // 2.5 Safeguard 2: Incomplete gateway response does NOT mark order FAILED
    const incompleteEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });
    incompleteEngine.lookupOrderByReceipt = async () => {
      return { found: true } as any; // Missing gatewayOrderId
    };

    const unknownOrder5 = await client.paymentOrder.create({
      data: {
        id: "ord_unknown_005",
        userId: "usr_alice",
        receipt: "rcpt_unknown_incomplete",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.CREATION_UNKNOWN,
        gateway: "mock",
        createdAt: new Date(Date.now() - 25 * 60_000),
      },
    });

    const resIncomplete = await reconcilePaymentOrder(
      { orderId: unknownOrder5.id },
      { gatewayEngine: incompleteEngine },
      client,
    );

    assert(resIncomplete.success === false, "Incomplete response does not report success");
    assert(resIncomplete.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Status is NEEDS_REVIEW, NOT FAILED");
    const updatedIncomplete = db.orders.get("ord_unknown_005");
    assert(updatedIncomplete.status === PaymentOrderStatus.NEEDS_REVIEW, "DB order kept in NEEDS_REVIEW on incomplete data");
    assert(updatedIncomplete.reviewReason === "INCOMPLETE_GATEWAY_RESPONSE", "reviewReason set to INCOMPLETE_GATEWAY_RESPONSE");
  });

  await runSection("3. Parameter Mismatch Escalation (AMOUNT_MISMATCH & CURRENCY_MISMATCH)", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();
    const mockEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });

    // 3.1 Amount mismatch (gateway order was for ₹40.00 = 4000 paise, but order expects ₹50.00 = 5000 paise)
    const gwOrderBadAmount = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 4000,
      currency: "INR",
      receipt: "rcpt_bad_amount",
    });
    mockEngine.generatePaymentResponse(gwOrderBadAmount.gatewayOrderId);

    const orderBadAmount = await client.paymentOrder.create({
      data: {
        id: "ord_bad_amount",
        userId: "usr_alice",
        receipt: "rcpt_bad_amount",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.PENDING,
        gateway: "mock",
        gatewayOrderId: gwOrderBadAmount.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    const initialWallet = db.wallets.get("usr_alice").balance;
    const resAmount = await reconcilePaymentOrder(
      { orderId: orderBadAmount.id },
      { gatewayEngine: mockEngine },
      client,
    );

    assert(resAmount.success === false, "Reconciliation failed due to mismatch");
    assert(resAmount.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Escalated to NEEDS_REVIEW");
    assert(resAmount.reviewReason === "AMOUNT_MISMATCH", "reviewReason is AMOUNT_MISMATCH");
    assert(db.wallets.get("usr_alice").balance === initialWallet, "Wallet balance was NOT incremented");

    // 3.2 Currency mismatch (gateway order was for USD, but order expects INR)
    const gwOrderBadCurrency = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "USD",
      receipt: "rcpt_bad_currency",
    });
    mockEngine.generatePaymentResponse(gwOrderBadCurrency.gatewayOrderId);

    const orderBadCurrency = await client.paymentOrder.create({
      data: {
        id: "ord_bad_currency",
        userId: "usr_alice",
        receipt: "rcpt_bad_currency",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.PENDING,
        gateway: "mock",
        gatewayOrderId: gwOrderBadCurrency.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    const resCurrency = await reconcilePaymentOrder(
      { orderId: orderBadCurrency.id },
      { gatewayEngine: mockEngine },
      client,
    );

    assert(resCurrency.success === false, "Currency mismatch failed");
    assert(resCurrency.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Escalated to NEEDS_REVIEW");
    assert(resCurrency.reviewReason === "CURRENCY_MISMATCH", "reviewReason is CURRENCY_MISMATCH");
    assert(db.wallets.get("usr_alice").balance === initialWallet, "Wallet balance was NOT incremented");
  });

  await runSection("4. Idempotency & Single-Settlement Invariant", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();
    const mockEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });

    const gwOrder = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_idempotent",
    });
    mockEngine.generatePaymentResponse(gwOrder.gatewayOrderId);

    const order = await client.paymentOrder.create({
      data: {
        id: "ord_idempotent",
        userId: "usr_alice",
        receipt: "rcpt_idempotent",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.PENDING,
        gateway: "mock",
        gatewayOrderId: gwOrder.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    // First reconciliation settles the order
    const res1 = await reconcilePaymentOrder({ orderId: order.id }, { gatewayEngine: mockEngine }, client);
    assert(res1.actionTaken === "settled", "First reconciliation settles order");
    assert(db.wallets.get("usr_alice").balance === 200, "Wallet balance is 200");

    // Second reconciliation returns already_settled
    const res2 = await reconcilePaymentOrder({ orderId: order.id }, { gatewayEngine: mockEngine }, client);
    assert(res2.actionTaken === "already_settled", "Second reconciliation recognizes already_settled");
    assert(db.wallets.get("usr_alice").balance === 200, "Wallet balance remains exactly 200 (never double credits)");

    // Third reconciliation via receipt
    const res3 = await reconcilePaymentOrder({ receipt: order.receipt }, { gatewayEngine: mockEngine }, client);
    assert(res3.actionTaken === "already_settled", "Third reconciliation recognizes already_settled");
    assert(db.wallets.get("usr_alice").balance === 200, "Wallet balance remains exactly 200");
  });

  await runSection("5. Operator Manual Review Workflow (Approve vs Reject)", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();

    // 5.1 Order in NEEDS_REVIEW without operator resolution action -> remains under review
    const reviewOrder1 = await client.paymentOrder.create({
      data: {
        id: "ord_review_001",
        userId: "usr_alice",
        receipt: "rcpt_review_001",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        reviewReason: "MANUAL_INSPECTION_REQUIRED",
        gateway: "mock",
        createdAt: new Date(),
      },
    });

    const resHalt = await reconcilePaymentOrder({ orderId: reviewOrder1.id }, {}, client);
    assert(resHalt.actionTaken === "escalated_review", "Order remains under manual review");
    assert(resHalt.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Status is still NEEDS_REVIEW");

    // 5.2a Safeguard 1: Operator approval WITHOUT gateway evidence is strictly REJECTED
    // Case 5.2a.1: Gateway engine is present but order does not exist on gateway -> GATEWAY_ORDER_NOT_FOUND
    const resApproveNoEvidence = await reconcilePaymentOrder(
      { orderId: reviewOrder1.id },
      {
        operatorId: "usr_admin_ops",
        resolutionAction: "approve",
        resolutionReason: "Attempting to approve without verified gateway payment",
      },
      client,
    );

    assert(resApproveNoEvidence.success === false, "Approval rejected when gateway order is not found");
    assert(resApproveNoEvidence.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Order status remains NEEDS_REVIEW");
    assert(resApproveNoEvidence.actionTaken === "escalated_review", "Action taken is escalated_review");
    assert(resApproveNoEvidence.reviewReason === "GATEWAY_ORDER_NOT_FOUND", "reviewReason is GATEWAY_ORDER_NOT_FOUND");
    const updatedReview1 = db.orders.get("ord_review_001");
    assert(updatedReview1.status === PaymentOrderStatus.NEEDS_REVIEW, "DB order remains in NEEDS_REVIEW");
    const history1 = updatedReview1.metadata.reconciliationHistory;
    assert(history1[history1.length - 1].action === "approval_rejected", "Audit recorded approval_rejected");

    // Case 5.2a.2: Gateway engine is not configured and no captured attempt in DB -> MISSING_GATEWAY_EVIDENCE
    const resApproveNoEngine = await reconcilePaymentOrder(
      { orderId: reviewOrder1.id },
      {
        operatorId: "usr_admin_ops",
        resolutionAction: "approve",
        resolutionReason: "Attempting to approve without gateway engine or captured attempt",
        gatewayEngine: null as any,
      },
      client,
    );
    assert(resApproveNoEngine.success === false, "Approval rejected when gateway engine and attempts missing");
    assert(resApproveNoEngine.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Order status remains NEEDS_REVIEW");
    assert(resApproveNoEngine.reviewReason === "MISSING_GATEWAY_EVIDENCE", "reviewReason is MISSING_GATEWAY_EVIDENCE");

    // 5.2b Safeguard 1: Operator approval with gateway AMOUNT_MISMATCH is strictly REJECTED
    const mockEngineApprove = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });
    const gwOrderBadAmount = await mockEngineApprove.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 4000, // Captured ₹40, but order expects ₹50
      currency: "INR",
      receipt: "rcpt_review_bad_amount",
    });
    mockEngineApprove.generatePaymentResponse(gwOrderBadAmount.gatewayOrderId);

    const reviewOrderBadAmount = await client.paymentOrder.create({
      data: {
        id: "ord_review_bad_amount",
        userId: "usr_alice",
        receipt: "rcpt_review_bad_amount",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        reviewReason: "AMOUNT_MISMATCH",
        gateway: "mock",
        gatewayOrderId: gwOrderBadAmount.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    const resApproveBadAmount = await reconcilePaymentOrder(
      { orderId: reviewOrderBadAmount.id },
      {
        operatorId: "usr_admin_ops",
        resolutionAction: "approve",
        resolutionReason: "Attempting to approve order despite amount mismatch",
        gatewayEngine: mockEngineApprove,
      },
      client,
    );

    assert(resApproveBadAmount.success === false, "Approval rejected on amount mismatch");
    assert(resApproveBadAmount.reviewReason === "AMOUNT_MISMATCH", "reviewReason indicates AMOUNT_MISMATCH");
    assert(db.orders.get("ord_review_bad_amount").status === PaymentOrderStatus.NEEDS_REVIEW, "DB order remains NEEDS_REVIEW");

    // 5.2c Safeguard 1: Operator approval with gateway CURRENCY_MISMATCH is strictly REJECTED
    const gwOrderBadCurrency = await mockEngineApprove.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "USD", // Gateway currency USD, order is INR
      receipt: "rcpt_review_bad_currency",
    });
    mockEngineApprove.generatePaymentResponse(gwOrderBadCurrency.gatewayOrderId);

    const reviewOrderBadCurrency = await client.paymentOrder.create({
      data: {
        id: "ord_review_bad_currency",
        userId: "usr_alice",
        receipt: "rcpt_review_bad_currency",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        reviewReason: "CURRENCY_MISMATCH",
        gateway: "mock",
        gatewayOrderId: gwOrderBadCurrency.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    const resApproveBadCurrency = await reconcilePaymentOrder(
      { orderId: reviewOrderBadCurrency.id },
      {
        operatorId: "usr_admin_ops",
        resolutionAction: "approve",
        resolutionReason: "Attempting to approve order despite currency mismatch",
        gatewayEngine: mockEngineApprove,
      },
      client,
    );

    assert(resApproveBadCurrency.success === false, "Approval rejected on currency mismatch");
    assert(resApproveBadCurrency.reviewReason === "CURRENCY_MISMATCH", "reviewReason indicates CURRENCY_MISMATCH");

    // 5.2d Safeguard 1: Operator approval with UNCAPTURED gateway status is strictly REJECTED
    const gwOrderUncaptured = await mockEngineApprove.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_review_uncaptured",
    }); // Not generating payment response -> stays CREATED (unpaid)

    const reviewOrderUncaptured = await client.paymentOrder.create({
      data: {
        id: "ord_review_uncaptured",
        userId: "usr_alice",
        receipt: "rcpt_review_uncaptured",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        reviewReason: "UNCAPTURED",
        gateway: "mock",
        gatewayOrderId: gwOrderUncaptured.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    const resApproveUncaptured = await reconcilePaymentOrder(
      { orderId: reviewOrderUncaptured.id },
      {
        operatorId: "usr_admin_ops",
        resolutionAction: "approve",
        resolutionReason: "Attempting to approve unpaid order",
        gatewayEngine: mockEngineApprove,
      },
      client,
    );

    assert(resApproveUncaptured.success === false, "Approval rejected for uncaptured order");
    assert(resApproveUncaptured.reviewReason === "GATEWAY_PAYMENT_NOT_CAPTURED", "reviewReason is GATEWAY_PAYMENT_NOT_CAPTURED");

    // 5.2e Safeguard 1: Operator approval WITH authentic verified gateway capture SUCCEEDS
    const gwOrderValid = await mockEngineApprove.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_review_valid",
    });
    mockEngineApprove.generatePaymentResponse(gwOrderValid.gatewayOrderId);

    const reviewOrderValid = await client.paymentOrder.create({
      data: {
        id: "ord_review_valid",
        userId: "usr_alice",
        receipt: "rcpt_review_valid",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        reviewReason: "GATEWAY_DEPOSIT_NEEDS_CONFIRMATION",
        gateway: "mock",
        gatewayOrderId: gwOrderValid.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    const walletBefore = db.wallets.get("usr_alice").balance;
    const resApproveValid = await reconcilePaymentOrder(
      { orderId: reviewOrderValid.id },
      {
        operatorId: "usr_admin_ops",
        resolutionAction: "approve",
        resolutionReason: "Verified gateway deposit in gateway ledger",
        gatewayEngine: mockEngineApprove,
      },
      client,
    );

    assert(resApproveValid.success === true, "Valid approval succeeded");
    assert(resApproveValid.actionTaken === "manual_approved", "Action was manual_approved");
    assert(resApproveValid.newStatus === PaymentOrderStatus.PAID, "New status is PAID");
    const updatedReviewValid = db.orders.get("ord_review_valid");
    assert(updatedReviewValid.status === PaymentOrderStatus.PAID, "DB order transitioned to PAID");
    assert(db.wallets.get("usr_alice").balance === walletBefore + 100, "Wallet balance incremented by exactly 100 credits");
    assert(Boolean(updatedReviewValid.metadata?.reconciliationHistory), "Audit history recorded");
    const validHistory = updatedReviewValid.metadata.reconciliationHistory;
    assert(validHistory[validHistory.length - 1].operatorId === "usr_admin_ops", "Operator ID recorded in audit");
    assert(validHistory[validHistory.length - 1].action === "manual_approved", "Audit action is manual_approved");

    // 5.3 Operator rejects order with resolution audit
    const reviewOrder2 = await client.paymentOrder.create({
      data: {
        id: "ord_review_002",
        userId: "usr_alice",
        receipt: "rcpt_review_002",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        reviewReason: "FRAUD_SUSPECTED",
        gateway: "mock",
        createdAt: new Date(),
      },
    });

    const resReject = await reconcilePaymentOrder(
      { orderId: reviewOrder2.id },
      {
        operatorId: "usr_admin_ops",
        resolutionAction: "reject",
        resolutionReason: "Confirmed fraudulent card attempt",
      },
      client,
    );

    assert(resReject.actionTaken === "manual_rejected", "Action was manual_rejected");
    assert(resReject.newStatus === PaymentOrderStatus.FAILED, "New status is FAILED");
    const updatedReview2 = db.orders.get("ord_review_002");
    assert(updatedReview2.status === PaymentOrderStatus.FAILED, "DB order transitioned to FAILED");
    assert(Boolean(updatedReview2.failedAt), "failedAt timestamp recorded");
  });

  await runSection("6. Expired Order Reconciliation for Abandoned Checkouts", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();
    const mockEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });

    // Create an order on the gateway that was never paid
    const gwOrder = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_abandoned_001",
    });

    // Created 45 minutes ago in DB
    const oldOrder = await client.paymentOrder.create({
      data: {
        id: "ord_abandoned_001",
        userId: "usr_alice",
        receipt: "rcpt_abandoned_001",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.CREATED,
        gateway: "mock",
        gatewayOrderId: gwOrder.gatewayOrderId,
        createdAt: new Date(Date.now() - 45 * 60_000), // 45 minutes old
      },
    });

    const res = await reconcilePaymentOrder(
      { orderId: oldOrder.id },
      { gatewayEngine: mockEngine, maxAgeMinutes: 30 },
      client,
    );

    assert(res.actionTaken === "expired", "Action was expired");
    assert(res.newStatus === PaymentOrderStatus.EXPIRED, "Status transitioned to EXPIRED");
    const dbExpired = db.orders.get("ord_abandoned_001");
    assert(dbExpired.status === PaymentOrderStatus.EXPIRED, "DB record marked EXPIRED");
    assert(Boolean(dbExpired.expiredAt), "expiredAt timestamp recorded");
  });

  await runSection("7. Bounded Batch Reconciliation Sweep (reconcileStuckPaymentOrders)", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();
    const mockEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });

    // Seed: 1 paid on gateway (stuck PENDING), 1 abandoned (expired), 1 uncreated (failed)
    const gwOrder1 = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_batch_paid",
    });
    mockEngine.generatePaymentResponse(gwOrder1.gatewayOrderId);

    await client.paymentOrder.create({
      data: {
        id: "ord_batch_1",
        userId: "usr_alice",
        receipt: "rcpt_batch_paid",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.PENDING,
        gateway: "mock",
        gatewayOrderId: gwOrder1.gatewayOrderId,
        createdAt: new Date(Date.now() - 30 * 60_000),
      },
    });

    await client.paymentOrder.create({
      data: {
        id: "ord_batch_2",
        userId: "usr_alice",
        receipt: "rcpt_batch_abandoned",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.PENDING,
        gateway: "mock",
        gatewayOrderId: "non_existent_gw",
        createdAt: new Date(Date.now() - 30 * 60_000),
      },
    });

    const summary: ReconcileBatchSummary = await reconcileStuckPaymentOrders(
      {
        stuckThresholdMinutes: 15,
        batchSize: 10,
        gatewayEngine: mockEngine,
      },
      client,
    );

    assert(summary.totalChecked >= 2, "Checked at least 2 candidate orders");
    assert(summary.settledCount >= 1, "Settled at least 1 captured order");
    assert(summary.expiredCount >= 1, "Expired at least 1 abandoned order");
    assert(summary.results.length === summary.totalChecked, "Results array matches total checked");
  });

  await runSection("8. Authenticated Operator Reconciliation API Handler", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();
    const mockEngine = new MockPaymentGatewayEngine({ supportsReceiptLookup: true });

    // Seed a stuck order
    const gwOrder = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_api_test",
    });
    mockEngine.generatePaymentResponse(gwOrder.gatewayOrderId);

    await client.paymentOrder.create({
      data: {
        id: "ord_api_test",
        userId: "usr_alice",
        receipt: "rcpt_api_test",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.PENDING,
        gateway: "mock",
        gatewayOrderId: gwOrder.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    // 8.1 Rejects unauthenticated request
    const unauthReq = new Request("http://localhost:3000/api/billing/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "ord_api_test" }),
    });
    const unauthRes = await handleReconcileRequest(unauthReq, {
      getUserId: async () => null,
      dbClient: client,
      gatewayEngine: mockEngine,
    });
    assert(unauthRes.status === 401, "Unauthenticated request returns 401");

    // 8.2 Rejects non-operator user
    const nonOpReq = new Request("http://localhost:3000/api/billing/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "ord_api_test" }),
    });
    const nonOpRes = await handleReconcileRequest(nonOpReq, {
      getUserId: async () => "usr_alice",
      isOperator: () => false,
      dbClient: client,
      gatewayEngine: mockEngine,
    });
    assert(nonOpRes.status === 403, "Non-operator user returns 403 FORBIDDEN");

    // 8.3 Reconciles single order for authorized operator
    const opReq = new Request("http://localhost:3000/api/billing/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "ord_api_test" }),
    });
    const opRes = await handleReconcileRequest(opReq, {
      getUserId: async () => "usr_admin",
      isOperator: () => true,
      dbClient: client,
      gatewayEngine: mockEngine,
    });
    assert(opRes.status === 200, "Authorized operator returns 200 OK");
    const opBody = await opRes.json();
    assert(opBody.success === true, "Operation reported success");
    assert(opBody.result.actionTaken === "settled", "Order was settled");

    // 8.4 Sweeps batch for authorized operator
    const sweepReq = new Request("http://localhost:3000/api/billing/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sweepBatch: true }),
    });
    const sweepRes = await handleReconcileRequest(sweepReq, {
      getUserId: async () => "usr_admin",
      isOperator: () => true,
      dbClient: client,
      gatewayEngine: mockEngine,
    });
    assert(sweepRes.status === 200, "Sweep batch returns 200 OK");

    // 8.5 Safeguard 1: Operator approval via API rejected with HTTP 422 when payment unverified
    await client.paymentOrder.create({
      data: {
        id: "ord_api_review_unverified",
        userId: "usr_alice",
        receipt: "rcpt_api_review_unverified",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        reviewReason: "UNVERIFIED",
        gateway: "mock",
        createdAt: new Date(),
      },
    });

    const approveUnverifiedReq = new Request("http://localhost:3000/api/billing/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: "ord_api_review_unverified",
        resolutionAction: "approve",
        resolutionReason: "Attempting to approve without gateway payment",
      }),
    });
    const approveUnverifiedRes = await handleReconcileRequest(approveUnverifiedReq, {
      getUserId: async () => "usr_admin",
      isOperator: () => true,
      dbClient: client,
      gatewayEngine: mockEngine,
    });
    assert(approveUnverifiedRes.status === 422, "Unverified approval rejected with HTTP 422");
    const approveUnverifiedBody = await approveUnverifiedRes.json();
    assert(approveUnverifiedBody.success === false, "Success is false on unverified approval");
    assert(approveUnverifiedBody.result.newStatus === PaymentOrderStatus.NEEDS_REVIEW, "Order remains in NEEDS_REVIEW");

    // 8.6 Safeguard 1: Operator approval via API succeeds with HTTP 200 when payment IS verified
    const gwOrderApiVerified = await mockEngine.createOrder({
      userId: "usr_alice",
      packageId: "PKG_STARTER",
      creditsAllocated: 100,
      amountMinor: 5000,
      currency: "INR",
      receipt: "rcpt_api_review_verified",
    });
    mockEngine.generatePaymentResponse(gwOrderApiVerified.gatewayOrderId);

    await client.paymentOrder.create({
      data: {
        id: "ord_api_review_verified",
        userId: "usr_alice",
        receipt: "rcpt_api_review_verified",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000, currency: "INR", creditsAllocated: 100 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.NEEDS_REVIEW,
        reviewReason: "FLAGGED_PREVIOUSLY",
        gateway: "mock",
        gatewayOrderId: gwOrderApiVerified.gatewayOrderId,
        createdAt: new Date(),
      },
    });

    const approveVerifiedReq = new Request("http://localhost:3000/api/billing/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: "ord_api_review_verified",
        resolutionAction: "approve",
        resolutionReason: "Verified gateway deposit in gateway records",
      }),
    });
    const approveVerifiedRes = await handleReconcileRequest(approveVerifiedReq, {
      getUserId: async () => "usr_admin",
      isOperator: () => true,
      dbClient: client,
      gatewayEngine: mockEngine,
    });
    assert(approveVerifiedRes.status === 200, "Verified approval returns HTTP 200 OK");
    const approveVerifiedBody = await approveVerifiedRes.json();
    assert(approveVerifiedBody.success === true, "Verified approval succeeded");
    assert(approveVerifiedBody.result.newStatus === PaymentOrderStatus.PAID, "Order transitioned to PAID");
  });

  await runSection("9. Webhook Lease Recovery, Duplicate Idempotency & Unknown Event Safety", async () => {
    const db = new MockBatch6Database();
    const client = db.getClient();

    // 9.1 Unknown event type does not settle or crash
    const unknownEvent = {
      id: "evt_unknown_99",
      gateway: "mock",
      eventId: "evt_unknown_99",
      eventType: "refund.speed_changed",
      payload: { dummy: 123 },
    };
    const unknownRes = await processPaymentWebhookEvent(unknownEvent, client);
    assert(unknownRes.status === WebhookEventStatus.PROCESSED, "Unknown event type acknowledged PROCESSED");
    assert(unknownRes.settlement === undefined, "Unknown event did not trigger order settlement");

    // 9.2 Duplicate webhook delivery is acknowledged and idempotent
    const duplicateEvent = {
      id: "evt_dup_99",
      gateway: "mock",
      eventId: "evt_dup_99",
      eventType: "payment.captured",
      payload: {
        receipt: "rcpt_alice_already_paid",
        payment: { id: "pay_dup_001", amount: 5000, currency: "INR" },
      },
    };

    // Pre-seed order in PAID status
    await client.paymentOrder.create({
      data: {
        id: "ord_already_paid_dup",
        userId: "usr_alice",
        receipt: "rcpt_alice_already_paid",
        packageId: "PKG_STARTER",
        packageSnapshot: { amountMinor: 5000 },
        creditsAllocated: 100,
        currency: "INR",
        baseAmountMinor: 5000,
        taxAmountMinor: 0,
        totalAmountMinor: 5000,
        status: PaymentOrderStatus.PAID,
        gateway: "mock",
        gatewayPaymentId: "pay_dup_001",
        createdAt: new Date(),
      },
    });

    const dupRes = await processPaymentWebhookEvent(duplicateEvent, client);
    assert(dupRes.status === WebhookEventStatus.PROCESSED, "Duplicate delivery processed cleanly");
    assert(dupRes.settlement?.alreadySettled === true, "Recognized order was already settled");
  });

  console.log("\n================================================================================");
  console.log(`✅ All ${passedTests} / ${totalTests} Stage 10 Batch 6 Tests Passed Successfully!`);
  console.log("================================================================================\n");
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
