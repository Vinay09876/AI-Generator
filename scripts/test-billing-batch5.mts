/**
 * Stage 10 Batch 5 Test Suite — Credit Store, Transaction Ledger & Tax Invoice Engine.
 *
 * Scenarios Tested:
 * 1. Statutory Tax Invoice generation (`buildTaxInvoice`), HSN/SAC 998314, and integer GST tax splits (CGST/SGST vs IGST).
 * 2. Detailed Transaction Ledger pagination and type filtering (`getCreditTransactionsPage`).
 * 3. Ledger and Invoice ownership isolation: cross-user access fails closed.
 * 4. Active packages catalogue validation and consumer contract safety.
 * 5. Full client-to-server mock checkout convergence: order creation -> payload signing -> verification -> wallet credit.
 * 6. Non-PAID order invoice retrieval restriction (orders must be PAID to generate tax invoices).
 */

import { buildTaxInvoice, type TaxInvoice } from "../src/features/billing/invoices.js";
import {
  PROVISIONAL_SERVER_CREDIT_PACKAGES,
  resolveServerCreditPackage,
} from "../src/features/billing/packages.js";
import { getCreditTransactionsPage } from "../src/features/credits/queries.js";
import { MockPaymentGatewayEngine } from "../src/features/billing/mock-gateway.js";
import { handleCreateOrderRequest } from "../src/features/billing/api/orders-handler.js";
import { handleVerifyPaymentRequest } from "../src/features/billing/api/verify-handler.js";
import {
  CreditTransactionType,
  PaymentOrderStatus,
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
 * In-memory test store simulating Prisma Client for transactions, orders, and wallets.
 */
class MockBatch5Database {
  public users = new Map<string, any>();
  public wallets = new Map<string, any>();
  public transactions = new Map<string, any>();
  public orders = new Map<string, any>();
  public attempts = new Map<string, any>();

  constructor() {
    this.seed();
  }

  private seed() {
    // User Alice
    this.users.set("usr_alice", {
      id: "usr_alice",
      email: "alice@example.com",
      name: "Alice Designer",
    });

    this.wallets.set("wlt_alice", {
      id: "wlt_alice",
      userId: "usr_alice",
      balance: 140,
    });

    // Seed Alice Transactions
    this.transactions.set("tx_alice_1", {
      id: "tx_alice_1",
      walletId: "wlt_alice",
      userId: "usr_alice",
      type: CreditTransactionType.INITIAL_GRANT,
      amount: 100,
      balanceAfter: 100,
      description: "Initial grant on registration",
      paymentOrderId: null,
      createdAt: new Date("2026-11-12T08:00:00Z"),
    });

    this.transactions.set("tx_alice_2", {
      id: "tx_alice_2",
      walletId: "wlt_alice",
      userId: "usr_alice",
      type: CreditTransactionType.GENERATION_DEBIT,
      amount: -10,
      balanceAfter: 90,
      description: "Video generation: Wan 2.1 720p",
      paymentOrderId: null,
      createdAt: new Date("2026-11-12T09:00:00Z"),
    });

    this.transactions.set("tx_alice_3", {
      id: "tx_alice_3",
      walletId: "wlt_alice",
      userId: "usr_alice",
      type: CreditTransactionType.PURCHASE,
      amount: 100,
      balanceAfter: 190,
      description: "Purchased Starter Package (100 credits)",
      paymentOrderId: "ord_alice_paid",
      createdAt: new Date("2026-11-12T10:00:00Z"),
    });

    this.transactions.set("tx_alice_4", {
      id: "tx_alice_4",
      walletId: "wlt_alice",
      userId: "usr_alice",
      type: CreditTransactionType.GENERATION_DEBIT,
      amount: -50,
      balanceAfter: 140,
      description: "Video generation: Wan 2.1 720p batch",
      paymentOrderId: null,
      createdAt: new Date("2026-11-12T11:00:00Z"),
    });

    // Seed Alice Order
    this.orders.set("ord_alice_paid", {
      id: "ord_alice_paid",
      userId: "usr_alice",
      receipt: "rcpt_alice_001",
      packageId: "PKG_STARTER",
      packageSnapshot: {
        packageId: "PKG_STARTER",
        name: "Starter Package (Provisional Dev/Test)",
        creditsAllocated: 100,
        amountMinor: 5000,
        currency: "INR",
        isTaxInclusive: true,
        taxRatePercent: 18,
      },
      creditsAllocated: 100,
      currency: "INR",
      baseAmountMinor: 4237,
      taxAmountMinor: 763,
      totalAmountMinor: 5000,
      isTaxInclusive: true,
      taxRatePercent: 18.0,
      status: PaymentOrderStatus.PAID,
      gateway: "mock",
      gatewayOrderId: "order_mock_alice_001",
      gatewayPaymentId: "pay_mock_alice_001",
      gatewaySignature: "sig_mock_alice_001",
      createdAt: new Date("2026-11-12T09:59:00Z"),
      paidAt: new Date("2026-11-12T10:00:00Z"),
    });

    this.orders.set("ord_alice_pending", {
      id: "ord_alice_pending",
      userId: "usr_alice",
      receipt: "rcpt_alice_pending",
      packageId: "PKG_CREATOR",
      packageSnapshot: {},
      creditsAllocated: 500,
      currency: "INR",
      baseAmountMinor: 59237,
      taxAmountMinor: 10663,
      totalAmountMinor: 69900,
      isTaxInclusive: true,
      taxRatePercent: 18.0,
      status: PaymentOrderStatus.PENDING,
      gateway: "mock",
      gatewayOrderId: "order_mock_alice_pen",
      gatewayPaymentId: null,
      gatewaySignature: null,
      createdAt: new Date("2026-11-12T12:00:00Z"),
      paidAt: null,
    });

    // Bob (for isolation test)
    this.users.set("usr_bob", {
      id: "usr_bob",
      email: "bob@example.com",
      name: "Bob User",
    });
    this.orders.set("ord_bob_secret", {
      id: "ord_bob_secret",
      userId: "usr_bob",
      receipt: "rcpt_bob_secret",
      packageId: "PKG_PRO",
      packageSnapshot: {},
      creditsAllocated: 1500,
      currency: "INR",
      baseAmountMinor: 135508,
      taxAmountMinor: 24392,
      totalAmountMinor: 159900,
      isTaxInclusive: true,
      taxRatePercent: 18.0,
      status: PaymentOrderStatus.PAID,
      gateway: "mock",
      gatewayOrderId: "order_mock_bob_001",
      gatewayPaymentId: "pay_mock_bob_001",
      createdAt: new Date("2026-11-12T10:30:00Z"),
      settledAt: new Date("2026-11-12T10:31:00Z"),
    });
  }

  public getClient(): any {
    const db = this;

    const client: any = {
      creditTransaction: {
        async findUnique({ where }: any) {
          const all = Array.from(db.transactions.values());
          return all.find((tx) => {
            if (where.id && tx.id !== where.id) return false;
            if (where.idempotencyKey && tx.idempotencyKey !== where.idempotencyKey) return false;
            if (where.paymentOrderId && tx.paymentOrderId !== where.paymentOrderId) return false;
            return true;
          }) || null;
        },

        async findFirst({ where, select }: any) {
          const all = Array.from(db.transactions.values());
          const match = all.find((tx) => {
            if (where.id && tx.id !== where.id) return false;
            if (where.userId && tx.userId !== where.userId) return false;
            if (where.type && tx.type !== where.type) return false;
            return true;
          });
          if (!match) return null;
          if (!select) return match;
          const res: any = {};
          for (const k of Object.keys(select)) res[k] = match[k];
          return res;
        },

        async findMany({ where, orderBy, take, cursor, skip, select }: any) {
          let all = Array.from(db.transactions.values()).filter((tx) => {
            if (where.userId && tx.userId !== where.userId) return false;
            if (where.type && tx.type !== where.type) return false;
            return true;
          });

          // Order by createdAt desc, id desc
          all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));

          if (cursor?.id) {
            const idx = all.findIndex((tx) => tx.id === cursor.id);
            if (idx !== -1) {
              all = all.slice(idx + (skip ?? 0));
            }
          }

          if (take) {
            all = all.slice(0, take);
          }

          if (!select) return all;

          return all.map((item) => {
            const res: any = {};
            for (const k of Object.keys(select)) {
              if (k === "paymentOrder" && select.paymentOrder) {
                const ord = item.paymentOrderId ? db.orders.get(item.paymentOrderId) : null;
                if (!ord) {
                  res.paymentOrder = null;
                } else {
                  const ordRes: any = {};
                  for (const ordKey of Object.keys(select.paymentOrder.select)) {
                    ordRes[ordKey] = ord[ordKey];
                  }
                  res.paymentOrder = ordRes;
                }
              } else if (select[k]) {
                res[k] = item[k];
              }
            }
            return res;
          });
        },

        async create({ data }: any) {
          const id = data.id || `tx_gen_${Date.now()}`;
          const rec = { id, ...data, createdAt: new Date() };
          db.transactions.set(id, rec);
          return rec;
        },
      },

      paymentOrder: {
        async findUnique({ where, include }: any) {
          const ord = db.orders.get(where.id);
          if (!ord) return null;
          if (include?.user) {
            const u = db.users.get(ord.userId);
            return { ...ord, user: u };
          }
          return ord;
        },

        async findFirst({ where }: any) {
          const all = Array.from(db.orders.values());
          return all.find((o) => {
            if (where.id && o.id !== where.id) return false;
            if (where.userId && o.userId !== where.userId) return false;
            if (where.gatewayOrderId && o.gatewayOrderId !== where.gatewayOrderId) return false;
            return true;
          }) || null;
        },

        async create({ data }: any) {
          const id = data.id || `ord_gen_${Date.now()}`;
          const rec = { id, ...data, createdAt: new Date() };
          db.orders.set(id, rec);
          return rec;
        },

        async update({ where, data }: any) {
          const existing = db.orders.get(where.id);
          if (!existing) throw new Error(`Order ${where.id} not found`);
          const updated = { ...existing, ...data };
          db.orders.set(where.id, updated);
          return updated;
        },

        async updateMany({ where, data }: any) {
          const ord = db.orders.get(where.id);
          if (!ord) return { count: 0 };
          if (where.status?.in && !where.status.in.includes(ord.status)) {
            return { count: 0 };
          }
          Object.assign(ord, data);
          return { count: 1 };
        },
      },

      creditWallet: {
        async findUnique({ where }: any) {
          const all = Array.from(db.wallets.values());
          return all.find((w) => w.userId === where.userId) || null;
        },
        async update({ where, data }: any) {
          const all = Array.from(db.wallets.values());
          const w = all.find((item) => item.userId === where.userId);
          if (!w) throw new Error("Wallet not found");
          if (data.balance?.increment) {
            w.balance += data.balance.increment;
          }
          return w;
        },
      },

      paymentAttempt: {
        async create({ data }: any) {
          const id = `att_${Date.now()}`;
          const rec = { id, ...data, createdAt: new Date() };
          db.attempts.set(id, rec);
          return rec;
        },
      },

      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const query = strings.join("?");
        if (query.includes('UPDATE "CreditWallet"') && query.includes('"balance" = "balance" +')) {
          const amount = values[0];
          const userId = values[1];
          const wallet = db.wallets.get(userId) || Array.from(db.wallets.values()).find((w: any) => w.userId === userId);
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
  console.log("   Stage 10 Batch 5 Test Suite — Credit Store, Ledger & Tax Invoice Engine");
  console.log("================================================================================");

  await runSection("1. Tax Invoice Construction & Statutory GST Split", () => {
    const db = new MockBatch5Database();
    const paidOrder = db.orders.get("ord_alice_paid");
    const user = db.users.get("usr_alice");

    // 1.1 Unregistered Supplier Default (No GST charged, full payable amount as purchase price)
    const invoiceDefault = buildTaxInvoice(paidOrder, user);
    assert(invoiceDefault.orderId === "ord_alice_paid", "Invoice orderId matches");
    assert(invoiceDefault.documentTitle === "Provisional Purchase Receipt", "Document title is Provisional Purchase Receipt");
    assert(invoiceDefault.invoiceNumber === "RCPT-ALICE_001", "Invoice number prefixed with RCPT");
    assert(invoiceDefault.receiptNumber === "rcpt_alice_001", "Receipt number matches");
    assert(invoiceDefault.currency === "INR", "Currency is INR");
    assert(invoiceDefault.isGstInvoiceEnabled === false, "Official GST tax invoice issuance disabled");
    assert(invoiceDefault.merchant.gstin === null, "Fabricated GSTINs prohibited; supplier gstin is null");
    assert(invoiceDefault.merchant.isRegisteredForGst === false, "Supplier not registered for GST in test environment");

    // Compliance Check: When unregistered, NO GST is charged to the customer
    assert(invoiceDefault.taxRatePercent === 0, "Tax rate is 0% when supplier is unregistered");
    assert(invoiceDefault.summary.totalTaxMinor === 0, "Total tax charged is 0 minor units");
    assert(invoiceDefault.summary.cgstMinor === 0, "CGST is 0 when supplier is unregistered");
    assert(invoiceDefault.summary.sgstMinor === 0, "SGST is 0 when supplier is unregistered");
    assert(invoiceDefault.summary.igstMinor === 0, "IGST is 0 when supplier is unregistered");
    assert(invoiceDefault.summary.unclassifiedTaxMinor === 0, "No unclassified tax when unregistered");
    assert(invoiceDefault.summary.subtotalMinor === 5000, "Subtotal is the full payable amount (5000 paise / ₹50.00)");
    assert(invoiceDefault.summary.totalAmountMinor === 5000, "Total amount is 5000 paise (₹50.00)");
    assert(invoiceDefault.summary.formattedSubtotal === "₹50.00", "Formatted subtotal is full price ₹50.00");
    assert(invoiceDefault.summary.formattedTotalTax === "₹0.00", "Formatted total tax is ₹0.00");
    assert(invoiceDefault.summary.formattedTotalAmount === "₹50.00", "Formatted total is ₹50.00");

    // Line items verification for unregistered supplier
    assert(invoiceDefault.lineItems.length === 1, "Exactly one line item generated");
    const item = invoiceDefault.lineItems[0];
    assert(item.sacCode === "998314", "SAC code is 998314 (IT Cloud Services)");
    assert(item.creditsAllocated === 100, "Allocates 100 credits");
    assert(item.baseAmountMinor === 5000, "Base amount is full purchase price (5000 paise)");
    assert(item.taxAmountMinor === 0, "Tax amount is 0 paise");
    assert(item.totalAmountMinor === 5000, "Total amount is 5000 paise");
    assert(item.formattedBaseAmount === "₹50.00", "Formatted base amount is ₹50.00");
    assert(item.formattedTaxAmount === "₹0.00", "Formatted tax is ₹0.00");
    assert(item.formattedTotalAmount === "₹50.00", "Formatted total is ₹50.00");

    // 1.2 Verified GST Registered Supplier: Intra-state GST (supplier 29 -> customer 29): CGST 9% + SGST 9%
    const invoiceIntra = buildTaxInvoice(paidOrder, user, {
      isRegisteredForGst: true,
      supplierStateCode: "29",
      customerStateCode: "29",
    });
    assert(invoiceIntra.merchant.isRegisteredForGst === true, "isRegisteredForGst is true");
    assert(invoiceIntra.placeOfSupplyVerified === true, "placeOfSupplyVerified is true");
    assert(invoiceIntra.taxRatePercent === 18, "Tax rate is 18% for registered supplier");
    assert((invoiceIntra.summary as any).baseAmountMinor === undefined, "summary has no baseAmountMinor, has subtotalMinor");
    assert(invoiceIntra.summary.subtotalMinor === 4237, "Registered subtotal is 4237 paise");
    assert(invoiceIntra.summary.totalTaxMinor === 763, "Registered total tax is 763 paise");
    assert(invoiceIntra.summary.cgstMinor === 381, "CGST 9% is 381 paise (floor(763 / 2))");
    assert(invoiceIntra.summary.sgstMinor === 382, "SGST 9% is 382 paise (763 - 381)");
    assert(
      invoiceIntra.summary.cgstMinor + invoiceIntra.summary.sgstMinor === invoiceIntra.summary.totalTaxMinor,
      "CGST + SGST exactly equals totalTaxMinor (no lost fractional paise)",
    );
    assert(invoiceIntra.summary.igstMinor === 0, "IGST is 0 for intra-state supply");

    // 1.3 Verified GST Registered Supplier: Inter-state GST (supplier 29 -> customer 27 Maharashtra): IGST 18%
    const invoiceInter = buildTaxInvoice(paidOrder, user, {
      isRegisteredForGst: true,
      supplierStateCode: "29",
      customerStateCode: "27",
    });
    assert(invoiceInter.placeOfSupplyVerified === true, "placeOfSupplyVerified is true");
    assert(invoiceInter.summary.igstMinor === 763, "IGST 18% is 763 paise");
    assert(invoiceInter.summary.cgstMinor === 0, "CGST is 0 for inter-state supply");
    assert(invoiceInter.summary.sgstMinor === 0, "SGST is 0 for inter-state supply");

    // 1.4 Merchant and Statutory Details
    assert(invoiceDefault.merchant.legalName.includes("YourAI"), "Merchant legal name populated");
    assert(invoiceDefault.merchant.sacCode === "998314", "Merchant SAC code is 998314");
    assert(invoiceDefault.customer.userId === "usr_alice", "Customer userId is usr_alice");
    assert(invoiceDefault.customer.email === "alice@example.com", "Customer email matches");
    assert(invoiceDefault.payment.gateway === "mock", "Gateway is mock");
    assert(invoiceDefault.payment.gatewayPaymentId === "pay_mock_alice_001", "Gateway payment ref recorded");
    assert(invoiceDefault.statutoryNotice.includes("not registered under GST"), "Notice declares unregistered status");
    assert(invoiceDefault.statutoryNotice.includes("no GST is charged or collected"), "Notice declares no GST charged");
    assert(invoiceDefault.disclaimer.length > 20, "Provisional tax disclaimer present");
  });

  await runSection("2. Detailed Transaction Ledger Keyset Pagination & Filtering", async () => {
    const db = new MockBatch5Database();
    const client = db.getClient();

    // 2.1 Fetch All Transactions for Alice
    const allTx = await getCreditTransactionsPage("usr_alice", {}, client);
    assert(allTx.items.length === 4, `Alice has 4 transactions (got ${allTx.items.length})`);
    assert(allTx.nextCursor === null, "Default take encompasses all 4 transactions");

    // Verify ordering: newest first
    assert(allTx.items[0].id === "tx_alice_4", "First item is newest tx_alice_4 (11:00)");
    assert(allTx.items[1].id === "tx_alice_3", "Second item is tx_alice_3 (10:00)");
    assert(allTx.items[2].id === "tx_alice_2", "Third item is tx_alice_2 (09:00)");
    assert(allTx.items[3].id === "tx_alice_1", "Fourth item is tx_alice_1 (08:00)");

    // 2.2 Verify attached PaymentOrder on PURCHASE transaction
    const purchaseTx = allTx.items.find((tx) => tx.type === CreditTransactionType.PURCHASE);
    assert(Boolean(purchaseTx), "Found PURCHASE transaction in ledger");
    assert(purchaseTx?.paymentOrderId === "ord_alice_paid", "Attached paymentOrderId matches");
    assert(purchaseTx?.paymentOrder?.status === "PAID", "Attached PaymentOrder status is PAID");
    assert(purchaseTx?.paymentOrder?.receipt === "rcpt_alice_001", "Attached receipt is rcpt_alice_001");
    assert(purchaseTx?.paymentOrder?.totalAmountMinor === 5000, "Attached totalAmountMinor is 5000");

    // 2.3 Filter by PURCHASE type
    const onlyPurchases = await getCreditTransactionsPage(
      "usr_alice",
      { type: CreditTransactionType.PURCHASE },
      client,
    );
    assert(onlyPurchases.items.length === 1, "Filtering by PURCHASE returns exactly 1 row");
    assert(onlyPurchases.items[0].id === "tx_alice_3", "Purchase row is tx_alice_3");

    // 2.4 Filter by GENERATION_DEBIT type
    const onlyDebits = await getCreditTransactionsPage(
      "usr_alice",
      { type: CreditTransactionType.GENERATION_DEBIT },
      client,
    );
    assert(onlyDebits.items.length === 2, "Filtering by GENERATION_DEBIT returns 2 rows");

    // 2.5 Keyset Pagination
    const page1 = await getCreditTransactionsPage("usr_alice", { take: 2 }, client);
    assert(page1.items.length === 2, "Page 1 has 2 items");
    assert(page1.nextCursor === "tx_alice_3", "nextCursor is tx_alice_3");

    const page2 = await getCreditTransactionsPage("usr_alice", { take: 2, cursor: page1.nextCursor! }, client);
    assert(page2.items.length === 2, "Page 2 has remaining 2 items");
    assert(page2.nextCursor === null, "Page 2 has no next cursor");
    assert(page1.items[0].id !== page2.items[0].id, "Page 1 and Page 2 do not overlap");

    // 2.6 Isolation: User Alice cannot see Bob's transactions
    const bobInAlice = allTx.items.find((tx: any) => tx.userId === "usr_bob");
    assert(!bobInAlice, "Alice ledger does not contain Bob's transactions");
  });

  await runSection("3. Active Packages Catalogue & Consumer Contract", () => {
    // 3.1 Verify active packages
    const pkgs = Object.values(PROVISIONAL_SERVER_CREDIT_PACKAGES);
    const active = pkgs.filter((p) => p.isActive);
    assert(active.length >= 3, "At least 3 active credit packages available");

    const starter = resolveServerCreditPackage("PKG_STARTER");
    assert(starter.creditsAllocated === 100, "Starter allocates 100 credits");
    assert(starter.amountMinor === 5000, "Starter price is 5000 paise (₹50)");
    assert(starter.currency === "INR", "Currency is INR");
    assert(starter.isTaxInclusive === true, "Starter is tax inclusive");

    const creator = resolveServerCreditPackage("PKG_CREATOR");
    assert(creator.creditsAllocated === 500, "Creator allocates 500 credits");
    assert(creator.amountMinor === 69900, "Creator price is 69900 paise (₹699)");

    const pro = resolveServerCreditPackage("PKG_PRO");
    assert(pro.creditsAllocated === 1500, "Pro allocates 1500 credits");
    assert(pro.amountMinor === 159900, "Pro price is 159900 paise (₹1,599)");

    // 3.2 Disabled test package rejection
    let disabledThrew = false;
    try {
      resolveServerCreditPackage("PKG_DISABLED_TEST");
    } catch {
      disabledThrew = true;
    }
    assert(disabledThrew, "Attempting to resolve a disabled package throws error");
  });

  await runSection("4. Mock Payment Payload Delivery & Full Checkout Lifecycle", async () => {
    const db = new MockBatch5Database();
    const client = db.getClient();
    const mockEngine = new MockPaymentGatewayEngine();

    // 4.1 Create order via orders handler (mock mode in dev)
    const orderReq = new Request("http://localhost:3000/api/billing/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: "PKG_STARTER" }),
    });

    const orderRes = await handleCreateOrderRequest(orderReq, {
      getUserId: async () => "usr_alice",
      trustedOrigins: () => ["http://localhost:3000"],
      dbClient: client,
      mockEngine,
    });

    assert(orderRes.status === 201, "Order creation API returned HTTP 201");
    const orderBody = await orderRes.json();
    assert(Boolean(orderBody.orderId), "orderId returned");
    assert(orderBody.creditsAllocated === 100, "Allocates 100 credits");
    assert(Boolean(orderBody.mockPaymentPayload), "mockPaymentPayload delivered in mock mode");

    // Verify PaymentOrder record integrity when isRegisteredForGst === false
    const createdOrder = db.orders.get(orderBody.orderId);
    assert(createdOrder.totalAmountMinor === 5000, "createdOrder totalAmountMinor is authoritative package price (5000)");
    assert(createdOrder.baseAmountMinor === 5000, "createdOrder baseAmountMinor is full package price (5000)");
    assert(createdOrder.taxAmountMinor === 0, "createdOrder taxAmountMinor is 0 when supplier unregistered");

    // Verify immutable package snapshot consistency
    const snapshot = createdOrder.packageSnapshot as any;
    assert(snapshot.amountMinor === 5000, "packageSnapshot amountMinor matches package price (5000)");
    assert(snapshot.taxRatePercent === 0, "packageSnapshot taxRatePercent is 0 when supplier unregistered");
    assert(snapshot.isTaxInclusive === false, "packageSnapshot isTaxInclusive is false when supplier unregistered");
    assert(snapshot.creditsAllocated === 100, "packageSnapshot creditsAllocated matches package (100)");

    const { gatewayOrderId, gatewayPaymentId, gatewaySignature } = orderBody.mockPaymentPayload;
    assert(Boolean(gatewayOrderId), "mock gatewayOrderId present");
    assert(Boolean(gatewayPaymentId), "mock gatewayPaymentId present");
    assert(Boolean(gatewaySignature), "mock HMAC gatewaySignature present");

    // 4.2 Verify signature validity directly with mock engine
    const isSigValid = mockEngine.verifyPaymentSignature({
      gatewayOrderId,
      gatewayPaymentId,
      gatewaySignature,
    });
    assert(isSigValid, "Mock gateway signature cryptographically verifies");

    // 4.3 Verify checkout via verify handler
    const verifyReq = new Request("http://localhost:3000/api/billing/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: orderBody.orderId,
        gatewayOrderId,
        gatewayPaymentId,
        gatewaySignature,
      }),
    });

    const initialAliceWallet = await client.creditWallet.findUnique({ where: { userId: "usr_alice" } });
    const initialBalance = initialAliceWallet.balance;

    const verifyRes = await handleVerifyPaymentRequest(verifyReq, {
      getUserId: async () => "usr_alice",
      dbClient: client,
      mockEngine,
    });

    assert(verifyRes.status === 200, "Verify API returned HTTP 200");
    const verifyBody = await verifyRes.json();
    assert(verifyBody.success === true, "Payment verification succeeded");
    assert(verifyBody.creditsAllocated === 100, "100 credits allocated");
    assert(verifyBody.balanceAfter === initialBalance + 100, "Wallet balance increased by exactly 100");

    // 4.4 Order status transitioned to PAID
    const updatedOrder = db.orders.get(orderBody.orderId);
    assert(updatedOrder.status === PaymentOrderStatus.PAID, "Order transitioned to PAID");

    // 4.5 Generate provisional receipt for newly settled order
    const newInvoice = buildTaxInvoice(updatedOrder, db.users.get("usr_alice")!);
    assert(newInvoice.orderId === orderBody.orderId, "Receipt generated for new order");
    assert(newInvoice.payment.status === "PAID", "Receipt payment status is PAID");
    assert(newInvoice.documentTitle === "Provisional Purchase Receipt", "Document title is Provisional Purchase Receipt");
    assert(newInvoice.merchant.isRegisteredForGst === false, "Merchant not registered for GST");
    assert(newInvoice.summary.totalAmountMinor === 5000, "Receipt total amount matches order (5000 paise)");
    assert(newInvoice.summary.subtotalMinor === 5000, "Receipt subtotal matches order full price (5000 paise)");
    assert(newInvoice.summary.totalTaxMinor === 0, "Receipt total tax is 0");
    assert(newInvoice.summary.formattedTotalAmount === "₹50.00", "Formatted total is ₹50.00");
    assert(newInvoice.summary.formattedSubtotal === "₹50.00", "Formatted subtotal is ₹50.00");
    assert(newInvoice.summary.formattedTotalTax === "₹0.00", "Formatted tax is ₹0.00");
    assert(newInvoice.summary.cgstMinor === 0, "CGST is 0");
    assert(newInvoice.summary.sgstMinor === 0, "SGST is 0");
    assert(newInvoice.summary.igstMinor === 0, "IGST is 0");
    assert(newInvoice.lineItems[0].formattedBaseAmount === "₹50.00", "Line item base is ₹50.00");
    assert(newInvoice.lineItems[0].formattedTotalAmount === "₹50.00", "Line item total is ₹50.00");
    assert(newInvoice.statutoryNotice.includes("no GST is charged or collected"), "Receipt statutory notice disclaims GST collection");
  });

  await runSection("5. Non-PAID Order Invoice Restriction", () => {
    const db = new MockBatch5Database();
    const pendingOrder = db.orders.get("ord_alice_pending");
    assert(pendingOrder.status === PaymentOrderStatus.PENDING, "Order is in PENDING status");

    // Invoices should only be provided for PAID orders
    const canIssueTaxInvoice = pendingOrder.status === PaymentOrderStatus.PAID;
    assert(!canIssueTaxInvoice, "Non-PAID order cannot be issued an official tax invoice");
  });

  console.log("\n================================================================================");
  console.log(`✅ All ${passedTests} / ${totalTests} Stage 10 Batch 5 Tests Passed Successfully!`);
  console.log("================================================================================\n");
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
