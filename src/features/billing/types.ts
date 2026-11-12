/**
 * Commercial Billing & Payment Types (Stage 10 Batch 1).
 */

import type { PaymentCurrency } from "./config";

export type { PaymentCurrency };

export type PaymentGateway = "mock" | "razorpay";

export type PaymentOrderStatus =
  | "PENDING"
  | "CREATION_UNKNOWN"
  | "CREATED"
  | "PAID"
  | "FAILED"
  | "EXPIRED"
  | "REFUNDED"
  | "NEEDS_REVIEW";

export interface GatewayCapabilities {
  /**
   * Whether this gateway adapter documents and supports secondary order lookup
   * by merchant receipt/idempotency reference.
   */
  readonly supportsReceiptLookup: boolean;
  /** Whether this gateway supports asynchronous webhook verification */
  readonly supportsWebhooks: boolean;
  /** Whether this gateway supports automated refunds */
  readonly supportsRefunds: boolean;
}

export interface CreateOrderInput {
  userId: string;
  packageId: string;
  creditsAllocated: number;
  amountMinor: number;
  currency: PaymentCurrency;
  receipt: string;
  notes?: Record<string, string>;
}

export interface CreateOrderOutput {
  gateway: PaymentGateway;
  gatewayOrderId: string;
  receipt: string;
  amountMinor: number;
  currency: PaymentCurrency;
  status: PaymentOrderStatus;
  keyId?: string;
}

export interface LookupOrderInput {
  receipt?: string;
  gatewayOrderId?: string;
}

export interface LookupOrderOutput {
  found: boolean;
  gateway?: PaymentGateway;
  gatewayOrderId?: string;
  receipt?: string;
  amountMinor?: number;
  currency?: PaymentCurrency;
  status?: PaymentOrderStatus;
  gatewayPaymentId?: string;
}

export interface VerifyPaymentInput {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  gatewaySignature: string;
}

export interface VerifyPaymentResult {
  verified: boolean;
  reason?: string;
}

export interface VerifyWebhookInput {
  rawBody: string | Buffer;
  signature: string;
  secret: string;
}

export interface VerifyWebhookResult {
  valid: boolean;
  eventId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
  reason?: string;
}

export interface PaymentGatewayEngine {
  readonly gateway: PaymentGateway;
  readonly capabilities: GatewayCapabilities;

  /**
   * Create an external order with the payment provider.
   * Passes the internal unique receipt as merchant order reference.
   */
  createOrder(input: CreateOrderInput): Promise<CreateOrderOutput>;

  /**
   * Look up an order by the merchant's stable receipt reference.
   * ONLY supported if capabilities.supportsReceiptLookup is true.
   * Essential for recovering from ambiguous network timeouts during order creation.
   */
  lookupOrderByReceipt(receipt: string): Promise<LookupOrderOutput>;

  /**
   * Look up an order by gateway-assigned order ID.
   */
  lookupOrderByGatewayId(gatewayOrderId: string): Promise<LookupOrderOutput>;

  /**
   * Cryptographically verify payment signature returned by the client checkout.
   */
  verifyPaymentSignature(input: VerifyPaymentInput): boolean;

  /**
   * Cryptographically verify webhook signature delivered to server webhook endpoints.
   */
  verifyWebhookSignature(input: VerifyWebhookInput): VerifyWebhookResult;
}

// ---------------------------------------------------------------------------
// Billing Domain Errors
// ---------------------------------------------------------------------------

export class BillingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "BillingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MockGatewayDisallowedError extends BillingError {
  constructor(message = "Mock payment gateway is strictly prohibited in production environment.") {
    super(message, "GATEWAY_DISALLOWED", 403);
    this.name = "MockGatewayDisallowedError";
    Object.setPrototypeOf(this, MockGatewayDisallowedError.prototype);
  }
}

export class InvalidCurrencyError extends BillingError {
  constructor(currency: string) {
    super(`Unsupported or invalid payment currency: ${currency}`, "INVALID_CURRENCY", 400);
    this.name = "InvalidCurrencyError";
    Object.setPrototypeOf(this, InvalidCurrencyError.prototype);
  }
}

export class InvalidAmountError extends BillingError {
  constructor(amount: number) {
    super(`Payment amount must be a positive integer in minor units: ${amount}`, "INVALID_AMOUNT", 400);
    this.name = "InvalidAmountError";
    Object.setPrototypeOf(this, InvalidAmountError.prototype);
  }
}

export class OrderCreationAmbiguityError extends BillingError {
  constructor(
    public readonly receipt: string,
    message = "Gateway order creation failed ambiguously. Lookup/reconciliation required.",
  ) {
    super(message, "ORDER_CREATION_AMBIGUOUS", 502);
    this.name = "OrderCreationAmbiguityError";
    Object.setPrototypeOf(this, OrderCreationAmbiguityError.prototype);
  }
}

export class OrderNotFoundError extends BillingError {
  constructor(identifier: string) {
    super(`Payment order not found: ${identifier}`, "ORDER_NOT_FOUND", 404);
    this.name = "OrderNotFoundError";
    Object.setPrototypeOf(this, OrderNotFoundError.prototype);
  }
}

export class GatewayCapabilityNotSupportedError extends BillingError {
  constructor(capability: string, gateway: string) {
    super(`Gateway ${gateway} does not support capability: ${capability}`, "CAPABILITY_NOT_SUPPORTED", 501);
    this.name = "GatewayCapabilityNotSupportedError";
    Object.setPrototypeOf(this, GatewayCapabilityNotSupportedError.prototype);
  }
}
