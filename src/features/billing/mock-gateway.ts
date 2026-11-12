/**
 * Secure Offline Mock Payment Gateway Engine (Stage 10 Batch 1).
 *
 * SAFETY INVARIANTS:
 * 1. Strict runtime environment check: Instantiation or execution in NODE_ENV === 'production'
 *    fails closed with MockGatewayDisallowedError.
 * 2. Zero Network Egress / ₹0 spend: 100% in-memory simulation using Node.js crypto.
 * 3. Server-side only: HMAC secrets and verification logic are isolated from client bundles.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type CreateOrderInput,
  type CreateOrderOutput,
  type GatewayCapabilities,
  type LookupOrderOutput,
  type PaymentGateway,
  type PaymentGatewayEngine,
  type PaymentOrderStatus,
  type VerifyPaymentInput,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
  GatewayCapabilityNotSupportedError,
  InvalidAmountError,
  InvalidCurrencyError,
  MockGatewayDisallowedError,
  OrderCreationAmbiguityError,
  OrderNotFoundError,
} from "./types";
import { isValidCurrency } from "./config";

export interface MockOrderRecord {
  gatewayOrderId: string;
  receipt: string;
  userId: string;
  packageId: string;
  creditsAllocated: number;
  amountMinor: number;
  currency: string;
  status: PaymentOrderStatus;
  gatewayPaymentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockPaymentGatewayOptions {
  /**
   * Secret key used for mock HMAC payment signatures.
   * If omitted, a cryptographically secure random secret is generated per instance.
   */
  secretKey?: string;
  /**
   * Secret key used for mock webhook HMAC signatures.
   */
  webhookSecret?: string;
  /**
   * Whether this mock instance supports receipt lookup.
   * Defaults to false to mirror the conservative assumption for external gateways.
   */
  supportsReceiptLookup?: boolean;
}

export class MockPaymentGatewayEngine implements PaymentGatewayEngine {
  public readonly gateway: PaymentGateway = "mock";
  public readonly capabilities: GatewayCapabilities;

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly ordersByReceipt = new Map<string, MockOrderRecord>();
  private readonly ordersByGatewayId = new Map<string, MockOrderRecord>();

  // Simulation controls for testing edge cases
  private nextTimeoutConfig?: { persistOrder: boolean; message?: string };
  private nextFailureConfig?: { reason: string };
  private nextInvalidSignature = false;

  constructor(options: MockPaymentGatewayOptions = {}) {
    this.assertNonProduction();

    this.capabilities = {
      // Conservative default: disabled unless explicitly enabled in configuration
      supportsReceiptLookup: options.supportsReceiptLookup ?? false,
      supportsWebhooks: true,
      supportsRefunds: true,
    };

    this.secretKey = options.secretKey ?? `mock_sec_${randomBytes(16).toString("hex")}`;
    this.webhookSecret = options.webhookSecret ?? `mock_whsec_${randomBytes(16).toString("hex")}`;
  }

  /**
   * Enforces that the mock gateway cannot be instantiated or called in production.
   */
  private assertNonProduction(): void {
    if (process.env.NODE_ENV === "production") {
      throw new MockGatewayDisallowedError(
        "Mock payment gateway engine is strictly prohibited in production environment.",
      );
    }
  }

  /**
   * Creates an external order in memory.
   */
  public async createOrder(input: CreateOrderInput): Promise<CreateOrderOutput> {
    this.assertNonProduction();

    if (!isValidCurrency(input.currency)) {
      throw new InvalidCurrencyError(input.currency);
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new InvalidAmountError(input.amountMinor);
    }

    const gatewayOrderId = `mock_order_${randomBytes(8).toString("hex")}`;

    // Simulation hook: ambiguous network timeout / crash
    if (this.nextTimeoutConfig) {
      const config = this.nextTimeoutConfig;
      this.nextTimeoutConfig = undefined;

      // If persistOrder is true, the order WAS created on the gateway side,
      // but the response was lost in transit (reproducing the network timeout race).
      if (config.persistOrder) {
        const order: MockOrderRecord = {
          gatewayOrderId,
          receipt: input.receipt,
          userId: input.userId,
          packageId: input.packageId,
          creditsAllocated: input.creditsAllocated,
          amountMinor: input.amountMinor,
          currency: input.currency,
          status: "CREATED",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.ordersByReceipt.set(input.receipt, order);
        this.ordersByGatewayId.set(gatewayOrderId, order);
      }

      throw new OrderCreationAmbiguityError(
        input.receipt,
        config.message ?? "Simulated socket timeout while waiting for gateway response",
      );
    }

    // Simulation hook: gateway rejection
    if (this.nextFailureConfig) {
      const config = this.nextFailureConfig;
      this.nextFailureConfig = undefined;

      const order: MockOrderRecord = {
        gatewayOrderId,
        receipt: input.receipt,
        userId: input.userId,
        packageId: input.packageId,
        creditsAllocated: input.creditsAllocated,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "FAILED",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.ordersByReceipt.set(input.receipt, order);
      this.ordersByGatewayId.set(gatewayOrderId, order);

      return {
        gateway: "mock",
        gatewayOrderId,
        receipt: input.receipt,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "FAILED",
      };
    }

    // Normal order creation
    const order: MockOrderRecord = {
      gatewayOrderId,
      receipt: input.receipt,
      userId: input.userId,
      packageId: input.packageId,
      creditsAllocated: input.creditsAllocated,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: "CREATED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.ordersByReceipt.set(input.receipt, order);
    this.ordersByGatewayId.set(gatewayOrderId, order);

    return {
      gateway: "mock",
      gatewayOrderId,
      receipt: input.receipt,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: "CREATED",
      keyId: "mock_key_public_dev",
    };
  }

  /**
   * Looks up an order by the merchant receipt reference.
   * Throws GatewayCapabilityNotSupportedError if capabilities.supportsReceiptLookup is false.
   */
  public async lookupOrderByReceipt(receipt: string): Promise<LookupOrderOutput> {
    this.assertNonProduction();

    if (!this.capabilities.supportsReceiptLookup) {
      throw new GatewayCapabilityNotSupportedError("lookupOrderByReceipt", this.gateway);
    }

    const order = this.ordersByReceipt.get(receipt);
    if (!order) {
      return { found: false };
    }

    return {
      found: true,
      gateway: "mock",
      gatewayOrderId: order.gatewayOrderId,
      receipt: order.receipt,
      amountMinor: order.amountMinor,
      currency: order.currency as any,
      status: order.status,
      gatewayPaymentId: order.gatewayPaymentId,
    };
  }

  /**
   * Looks up an order by gateway order ID.
   */
  public async lookupOrderByGatewayId(gatewayOrderId: string): Promise<LookupOrderOutput> {
    this.assertNonProduction();

    const order = this.ordersByGatewayId.get(gatewayOrderId);
    if (!order) {
      return { found: false };
    }

    return {
      found: true,
      gateway: "mock",
      gatewayOrderId: order.gatewayOrderId,
      receipt: order.receipt,
      amountMinor: order.amountMinor,
      currency: order.currency as any,
      status: order.status,
      gatewayPaymentId: order.gatewayPaymentId,
    };
  }

  /**
   * Generates a valid mock client payment completion payload with HMAC signature.
   * Used in tests to simulate the client checkout callback.
   */
  public generatePaymentResponse(gatewayOrderId: string): {
    gatewayOrderId: string;
    gatewayPaymentId: string;
    gatewaySignature: string;
  } {
    this.assertNonProduction();

    const order = this.ordersByGatewayId.get(gatewayOrderId);
    if (!order) {
      throw new OrderNotFoundError(gatewayOrderId);
    }

    const gatewayPaymentId = `mock_pay_${randomBytes(8).toString("hex")}`;
    order.gatewayPaymentId = gatewayPaymentId;
    order.status = "PAID";
    order.updatedAt = new Date();

    const payload = `${gatewayOrderId}|${gatewayPaymentId}`;
    const gatewaySignature = createHmac("sha256", this.secretKey).update(payload).digest("hex");

    return {
      gatewayOrderId,
      gatewayPaymentId,
      gatewaySignature,
    };
  }

  /**
   * Cryptographically verifies the payment signature returned by the client checkout.
   */
  public verifyPaymentSignature(input: VerifyPaymentInput): boolean {
    this.assertNonProduction();

    if (this.nextInvalidSignature) {
      this.nextInvalidSignature = false;
      return false;
    }

    const { gatewayOrderId, gatewayPaymentId, gatewaySignature } = input;
    if (!gatewayOrderId || !gatewayPaymentId || !gatewaySignature) {
      return false;
    }

    const expectedPayload = `${gatewayOrderId}|${gatewayPaymentId}`;
    const expectedSignature = createHmac("sha256", this.secretKey)
      .update(expectedPayload)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedSignature, "utf-8");
    const actualBuf = Buffer.from(gatewaySignature, "utf-8");

    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, actualBuf);
  }

  /**
   * Simulates a provider webhook event and returns its raw body and valid HMAC signature.
   */
  public generateSimulatedWebhook(
    eventType: "payment.captured" | "payment.failed",
    gatewayOrderId: string,
    gatewayPaymentId?: string,
  ): { rawBody: string; signature: string; secret: string } {
    this.assertNonProduction();

    const order = this.ordersByGatewayId.get(gatewayOrderId);
    const paymentId = gatewayPaymentId ?? order?.gatewayPaymentId ?? `mock_pay_${randomBytes(8).toString("hex")}`;
    const eventId = `mock_evt_${randomBytes(8).toString("hex")}`;

    const payload = {
      entity: "event",
      account_id: "acc_mock_dev",
      event: eventType,
      contains: ["payment"],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: gatewayOrderId,
            amount: order?.amountMinor ?? 5000,
            currency: order?.currency ?? "INR",
            status: eventType === "payment.captured" ? "captured" : "failed",
            method: "upi",
            created_at: Math.floor(Date.now() / 1000),
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");

    return {
      rawBody,
      signature,
      secret: this.webhookSecret,
    };
  }

  /**
   * Cryptographically verifies a webhook signature against the raw body.
   */
  public verifyWebhookSignature(input: VerifyWebhookInput): VerifyWebhookResult {
    this.assertNonProduction();

    const { rawBody, signature, secret } = input;
    if (!rawBody || !signature || !secret) {
      return { valid: false, reason: "Missing required webhook verification arguments" };
    }

    try {
      const rawString = typeof rawBody === "string" ? rawBody : rawBody.toString("utf-8");
      const expectedSignature = createHmac("sha256", secret).update(rawString).digest("hex");

      const expectedBuf = Buffer.from(expectedSignature, "utf-8");
      const actualBuf = Buffer.from(signature, "utf-8");

      if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
        return { valid: false, reason: "Cryptographic signature mismatch" };
      }

      const parsed = JSON.parse(rawString);
      const eventId = parsed?.id ?? parsed?.entity === "event" ? `evt_${createHmac("sha256", secret).update(rawString).digest("hex").slice(0, 16)}` : undefined;
      const eventType = parsed?.event ?? parsed?.type;

      return {
        valid: true,
        eventId,
        eventType,
        payload: parsed,
      };
    } catch (err) {
      return {
        valid: false,
        reason: `Failed to parse or verify webhook: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation Controls for Testing
  // ---------------------------------------------------------------------------

  /**
   * Simulates an ambiguous network timeout on the next createOrder call.
   * If persistOrder is true (default), the order is registered in memory,
   * enabling tests to verify recovery via receipt lookup.
   */
  public simulateNextTimeout(persistOrder = true, message?: string): void {
    this.nextTimeoutConfig = { persistOrder, message };
  }

  /**
   * Simulates an explicit gateway error/rejection on the next createOrder call.
   */
  public simulateNextFailure(reason = "Payment rejected by gateway"): void {
    this.nextFailureConfig = { reason };
  }

  /**
   * Simulates a signature verification failure on the next verifyPaymentSignature call.
   */
  public simulateNextInvalidSignature(): void {
    this.nextInvalidSignature = true;
  }

  /**
   * Wipes in-memory state and simulation hooks for clean test isolation.
   */
  public reset(): void {
    this.ordersByReceipt.clear();
    this.ordersByGatewayId.clear();
    this.nextTimeoutConfig = undefined;
    this.nextFailureConfig = undefined;
    this.nextInvalidSignature = false;
  }
}
