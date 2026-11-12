/**
 * Purchase Receipt & Billing Document Generation Service (Stage 10 Batch 5).
 *
 * COMPLIANCE & LEGAL NOTICE:
 * - This service generates PROVISIONAL PURCHASE RECEIPTS for development and testing.
 * - Official statutory GST tax invoice issuance is currently DISABLED pending formal
 *   supplier legal entity registration, verified GSTIN provisioning, and place-of-supply
 *   verification by a qualified Chartered Accountant.
 * - Fabricated, provisional, or placeholder GSTINs are STRICTLY PROHIBITED.
 * - Accurate order, payment, and credit ledger references are strictly preserved.
 */

import {
  type PaymentCurrency,
  PROVISIONAL_TAX_ASSUMPTIONS,
  INVOICE_CONFIG_DEFAULTS,
  formatCurrency,
} from "./config";
import type { PaymentOrder } from "@/generated/prisma/client";

export interface PurchaseReceiptLineItem {
  id: string;
  description: string;
  sacCode: string;
  quantity: number;
  creditsAllocated: number;
  baseAmountMinor: number;
  taxAmountMinor: number;
  totalAmountMinor: number;
  formattedBaseAmount: string;
  formattedTaxAmount: string;
  formattedTotalAmount: string;
}

export interface PurchaseReceiptMerchant {
  legalName: string;
  address: string;
  gstin: string | null;
  stateCode: string | null;
  sacCode: string;
  isRegisteredForGst: boolean;
}

export interface PurchaseReceiptCustomer {
  userId: string;
  name: string;
  email: string;
  country: string;
  stateCode: string | null;
}

export interface PurchaseReceiptPayment {
  gateway: string;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  paidAt: Date;
  status: string;
}

export interface PurchaseReceiptSummary {
  subtotalMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  unclassifiedTaxMinor: number;
  totalTaxMinor: number;
  totalAmountMinor: number;
  formattedSubtotal: string;
  formattedCgst: string | null;
  formattedSgst: string | null;
  formattedIgst: string | null;
  formattedTotalTax: string;
  formattedTotalAmount: string;
}

export interface TaxInvoice {
  /** Document type: strictly provisional receipt until formal GST invoice authorization */
  documentTitle: string;
  receiptNumber: string;
  invoiceNumber: string;
  orderId: string;
  issueDate: Date;
  currency: PaymentCurrency;
  isTaxInclusive: boolean;
  taxRatePercent: number;
  isGstInvoiceEnabled: boolean;
  placeOfSupplyVerified: boolean;
  merchant: PurchaseReceiptMerchant;
  customer: PurchaseReceiptCustomer;
  payment: PurchaseReceiptPayment;
  lineItems: PurchaseReceiptLineItem[];
  summary: PurchaseReceiptSummary;
  statutoryNotice: string;
  disclaimer: string;
}

export interface BuildReceiptOptions {
  supplierStateCode?: string | null;
  customerStateCode?: string | null;
  isInterState?: boolean;
  supplierGstin?: string | null;
  isRegisteredForGst?: boolean;
}

/**
 * Builds a structured, audit-grade purchase receipt from an authoritative PaymentOrder.
 * Reflects verified supplier registration and place-of-supply data.
 * When isRegisteredForGst is false, no GST is charged or represented to the customer.
 */
export function buildTaxInvoice(
  order: PaymentOrder,
  customer: { id?: string; name?: string | null; email: string; country?: string; stateCode?: string | null },
  options?: BuildReceiptOptions,
): TaxInvoice {
  const currency = order.currency as PaymentCurrency;

  const supplierGstin = options?.supplierGstin ?? INVOICE_CONFIG_DEFAULTS.supplierGstin;
  const isRegisteredForGst = Boolean(
    options?.isRegisteredForGst ??
    (supplierGstin && PROVISIONAL_TAX_ASSUMPTIONS.gstInvoiceEnabled)
  );
  const isGstInvoiceEnabled = isRegisteredForGst;

  // Supplier & customer place-of-supply resolution
  const supplierStateCode = options?.supplierStateCode ?? INVOICE_CONFIG_DEFAULTS.supplierStateCode;
  const customerStateCode = options?.customerStateCode ?? customer.stateCode ?? null;
  const placeOfSupplyVerified = Boolean(supplierStateCode && customerStateCode);

  const totalAmountMinor = order.totalAmountMinor;
  const snapshot = (order.packageSnapshot ?? {}) as Record<string, any>;

  let baseAmountMinor = totalAmountMinor;
  let taxAmountMinor = 0;
  let cgstMinor = 0;
  let sgstMinor = 0;
  let igstMinor = 0;
  let unclassifiedTaxMinor = 0;
  let taxRatePercent = 0;
  let isTaxInclusive = false;

  // ONLY compute and display GST if the supplier is formally verified & registered for GST
  if (isRegisteredForGst && currency === "INR") {
    taxRatePercent = typeof snapshot.taxRatePercent === "number" ? snapshot.taxRatePercent : 18;
    isTaxInclusive = snapshot.isTaxInclusive !== false;
    taxAmountMinor = order.taxAmountMinor;
    baseAmountMinor = order.baseAmountMinor;

    if (placeOfSupplyVerified) {
      if (supplierStateCode === customerStateCode) {
        // Intra-state supply
        cgstMinor = Math.floor(taxAmountMinor / 2);
        sgstMinor = taxAmountMinor - cgstMinor;
      } else {
        // Inter-state supply
        igstMinor = taxAmountMinor;
      }
    } else if (options?.isInterState !== undefined) {
      // Explicit override provided (e.g. in test suites)
      if (options.isInterState) {
        igstMinor = taxAmountMinor;
      } else {
        cgstMinor = Math.floor(taxAmountMinor / 2);
        sgstMinor = taxAmountMinor - cgstMinor;
      }
    } else {
      // Place of supply unverified: present as unclassified provisional tax
      unclassifiedTaxMinor = taxAmountMinor;
    }
  }

  const packageName = snapshot.name || `Compute Credits (${order.creditsAllocated} credits)`;

  const lineItem: PurchaseReceiptLineItem = {
    id: `item_${order.id}`,
    description: packageName,
    sacCode: PROVISIONAL_TAX_ASSUMPTIONS.provisionalSacCode,
    quantity: 1,
    creditsAllocated: order.creditsAllocated,
    baseAmountMinor,
    taxAmountMinor,
    totalAmountMinor,
    formattedBaseAmount: formatCurrency(baseAmountMinor, currency),
    formattedTaxAmount: formatCurrency(taxAmountMinor, currency),
    formattedTotalAmount: formatCurrency(totalAmountMinor, currency),
  };

  const receiptNumber = order.receipt;
  const invoiceNumber = receiptNumber.startsWith("rcpt_")
    ? `RCPT-${receiptNumber.slice(5).toUpperCase()}`
    : `RCPT-${receiptNumber.toUpperCase()}`;

  const issueDate = order.paidAt ?? order.createdAt;

  return {
    documentTitle: "Provisional Purchase Receipt",
    receiptNumber,
    invoiceNumber,
    orderId: order.id,
    issueDate,
    currency,
    isTaxInclusive,
    taxRatePercent,
    isGstInvoiceEnabled,
    placeOfSupplyVerified,
    merchant: {
      legalName: INVOICE_CONFIG_DEFAULTS.supplierLegalName,
      address: INVOICE_CONFIG_DEFAULTS.supplierAddress,
      gstin: supplierGstin,
      stateCode: supplierStateCode,
      sacCode: PROVISIONAL_TAX_ASSUMPTIONS.provisionalSacCode,
      isRegisteredForGst,
    },
    customer: {
      userId: customer.id ?? order.userId,
      name: customer.name?.trim() || "Customer",
      email: customer.email,
      country: customer.country ?? (currency === "INR" ? "India" : "International"),
      stateCode: customerStateCode,
    },
    payment: {
      gateway: order.gateway,
      gatewayOrderId: order.gatewayOrderId,
      gatewayPaymentId: order.gatewayPaymentId,
      paidAt: issueDate,
      status: order.status,
    },
    lineItems: [lineItem],
    summary: {
      subtotalMinor: baseAmountMinor,
      cgstMinor,
      sgstMinor,
      igstMinor,
      unclassifiedTaxMinor,
      totalTaxMinor: taxAmountMinor,
      totalAmountMinor,
      formattedSubtotal: formatCurrency(baseAmountMinor, currency),
      formattedCgst: cgstMinor > 0 ? formatCurrency(cgstMinor, currency) : null,
      formattedSgst: sgstMinor > 0 ? formatCurrency(sgstMinor, currency) : null,
      formattedIgst: igstMinor > 0 ? formatCurrency(igstMinor, currency) : null,
      formattedTotalTax: formatCurrency(taxAmountMinor, currency),
      formattedTotalAmount: formatCurrency(totalAmountMinor, currency),
    },
    statutoryNotice: isRegisteredForGst
      ? "Official statutory GST tax invoice generated for digital compute credits."
      : "This document is a provisional purchase receipt acknowledging payment receipt for digital compute credits. The supplier is currently not registered under GST; no GST is charged or collected. Official statutory GST tax invoice issuance is disabled pending formal corporate registration, GSTIN provisioning, and Chartered Accountant review.",
    disclaimer: PROVISIONAL_TAX_ASSUMPTIONS.disclaimer,
  };
}
