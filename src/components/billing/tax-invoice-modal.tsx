"use client";

import { useEffect, useState } from "react";
import { X, Printer, CheckCircle2, ShieldCheck, FileText, Loader2 } from "lucide-react";
import type { TaxInvoice } from "@/features/billing/invoices";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function TaxInvoiceModal({
  orderId,
  initialInvoice,
  isOpen,
  onClose,
}: {
  orderId?: string | null;
  initialInvoice?: TaxInvoice | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [invoice, setInvoice] = useState<TaxInvoice | null>(initialInvoice ?? null);
  const [loading, setLoading] = useState<boolean>(!initialInvoice && Boolean(orderId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    if (initialInvoice) {
      setInvoice(initialInvoice);
      setLoading(false);
      return;
    }

    if (orderId) {
      setLoading(true);
      setError(null);
      fetch(`/api/billing/invoices/${orderId}`)
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "Failed to load tax invoice");
          }
          return res.json();
        })
        .then((data) => {
          setInvoice(data.invoice);
        })
        .catch((err) => {
          setError(err.message);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [isOpen, orderId, initialInvoice]);

  if (!isOpen) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="invoice-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog */}
      <div className="relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-zinc-950 shadow-2xl">
        {/* Header Bar */}
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-xl bg-violet/20 text-violet-300 ring-1 ring-violet/40">
              <FileText className="size-4" aria-hidden />
            </span>
            <div>
              <h2 id="invoice-modal-title" className="font-medium text-sm text-foreground">
                {invoice?.documentTitle || "Provisional Purchase Receipt"}
              </h2>
              <p className="text-[11px] text-muted">Payment Record &amp; Compute Allocation</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {invoice && (
              <button
                type="button"
                onClick={handlePrint}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 text-xs font-medium text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/10 hover:text-white"
              >
                <Printer className="size-3.5" aria-hidden />
                <span>Print</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close invoice dialog"
              className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Loader2 className="size-8 animate-spin text-violet-400" aria-hidden />
              <p className="mt-3 text-sm text-muted">Generating tax invoice receipt...</p>
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-red-500/20 bg-red-950/20 p-5 text-center text-sm text-red-300">
              <p className="font-medium">Invoice Unavailable</p>
              <p className="mt-1 text-xs opacity-80">{error}</p>
            </div>
          )}

          {invoice && (
            <div className="printable-invoice space-y-6 text-xs text-foreground/90">
              {/* Top Banner: Status & Receipt Reference */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-500/20 bg-emerald-950/20 p-4 text-emerald-300">
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="size-5 shrink-0" aria-hidden />
                  <div>
                    <p className="font-semibold text-sm">Payment Verified & Settled</p>
                    <p className="text-[11px] opacity-80">
                      Paid on {formatDateTime(new Date(invoice.issueDate))}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-mono text-xs font-semibold text-white">{invoice.invoiceNumber}</p>
                  <p className="text-[10px] opacity-70">Receipt: {invoice.receiptNumber}</p>
                </div>
              </div>

              {/* Provisional Notice Banner */}
              {!invoice.isGstInvoiceEnabled && (
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3.5 text-xs text-amber-200/90 flex items-start gap-2.5">
                  <ShieldCheck className="size-4 shrink-0 text-amber-400 mt-0.5" aria-hidden />
                  <div className="space-y-0.5">
                    <p className="font-medium text-amber-200">Provisional Purchase Receipt</p>
                    <p className="text-[11px] opacity-80 leading-relaxed">
                      Supplier is not registered under GST. No GST is charged or collected. Official statutory GST tax invoice issuance is currently disabled.
                    </p>
                  </div>
                </div>
              )}

              {/* Two Column Supplier vs Customer */}
              <div className="grid gap-6 border-b border-white/[0.06] pb-6 sm:grid-cols-2">
                <div className="space-y-1 text-muted">
                  <p className="font-semibold text-foreground uppercase tracking-wider text-[10px]">
                    Supplier Details
                  </p>
                  <p className="font-medium text-foreground">{invoice.merchant.legalName}</p>
                  <p>{invoice.merchant.address}</p>
                  <p>
                    <span className="text-muted/80">GSTIN:</span>{" "}
                    <span className="font-mono text-foreground/90">
                      {invoice.merchant.gstin || "Not Registered (GST Not Applicable)"}
                    </span>
                  </p>
                  {invoice.merchant.stateCode && (
                    <p>
                      <span className="text-muted/80">State Code:</span> {invoice.merchant.stateCode}
                    </p>
                  )}
                  <p>
                    <span className="text-muted/80">SAC Code:</span> {invoice.merchant.sacCode} (Cloud IT Services)
                  </p>
                </div>

                <div className="space-y-1 text-muted sm:text-right">
                  <p className="font-semibold text-foreground uppercase tracking-wider text-[10px]">
                    Billed To
                  </p>
                  <p className="font-medium text-foreground">{invoice.customer.name}</p>
                  <p>{invoice.customer.email}</p>
                  <p>{invoice.customer.country}</p>
                  <p className="text-[11px] text-muted/70">User ID: {invoice.customer.userId}</p>
                </div>
              </div>

              {/* Line Items Table */}
              <div>
                <p className="font-semibold text-foreground uppercase tracking-wider text-[10px] mb-2">
                  Line Items &amp; Compute Allocation
                </p>
                <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-white/[0.03] text-muted border-b border-white/[0.06]">
                      <tr>
                        <th className="py-2.5 px-3">Description</th>
                        <th className="py-2.5 px-3">SAC</th>
                        <th className="py-2.5 px-3 text-right">Credits</th>
                        <th className="py-2.5 px-3 text-right">
                          {invoice.merchant.isRegisteredForGst ? "Base Amount" : "Purchase Price"}
                        </th>
                        {invoice.merchant.isRegisteredForGst && (
                          <th className="py-2.5 px-3 text-right">GST ({invoice.taxRatePercent}%)</th>
                        )}
                        <th className="py-2.5 px-3 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {invoice.lineItems.map((item) => (
                        <tr key={item.id}>
                          <td className="py-2.5 px-3 font-medium text-foreground">{item.description}</td>
                          <td className="py-2.5 px-3 font-mono text-muted">{item.sacCode}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums text-violet-300 font-semibold">
                            +{item.creditsAllocated}
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{item.formattedBaseAmount}</td>
                          {invoice.merchant.isRegisteredForGst && (
                            <td className="py-2.5 px-3 text-right tabular-nums text-muted">{item.formattedTaxAmount}</td>
                          )}
                          <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-white">
                            {item.formattedTotalAmount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Summary & Price Breakdown */}
              <div className="flex justify-end border-b border-white/[0.06] pb-6">
                <dl className="w-full max-w-xs space-y-1.5 text-xs">
                  {invoice.merchant.isRegisteredForGst ? (
                    <>
                      <div className="flex justify-between text-muted">
                        <dt>Subtotal (Taxable Value)</dt>
                        <dd className="tabular-nums text-foreground">{invoice.summary.formattedSubtotal}</dd>
                      </div>

                      {invoice.summary.formattedIgst ? (
                        <div className="flex justify-between text-muted">
                          <dt>Integrated GST (IGST 18%)</dt>
                          <dd className="tabular-nums text-foreground">{invoice.summary.formattedIgst}</dd>
                        </div>
                      ) : invoice.summary.formattedCgst && invoice.summary.formattedSgst ? (
                        <>
                          <div className="flex justify-between text-muted">
                            <dt>Central GST (CGST 9%)</dt>
                            <dd className="tabular-nums text-foreground">{invoice.summary.formattedCgst}</dd>
                          </div>
                          <div className="flex justify-between text-muted">
                            <dt>State GST (SGST 9%)</dt>
                            <dd className="tabular-nums text-foreground">{invoice.summary.formattedSgst}</dd>
                          </div>
                        </>
                      ) : (
                        <div className="flex justify-between text-muted">
                          <dt>Tax ({invoice.taxRatePercent}%)</dt>
                          <dd className="tabular-nums text-foreground">{invoice.summary.formattedTotalTax}</dd>
                        </div>
                      )}

                      <div className="flex justify-between text-muted">
                        <dt>Total Tax ({invoice.taxRatePercent}%)</dt>
                        <dd className="tabular-nums text-foreground">{invoice.summary.formattedTotalTax}</dd>
                      </div>
                    </>
                  ) : (
                    <div className="flex justify-between text-muted">
                      <dt>Purchase Price</dt>
                      <dd className="tabular-nums text-foreground">{invoice.summary.formattedTotalAmount}</dd>
                    </div>
                  )}

                  <div className="flex justify-between border-t border-white/[0.08] pt-2 font-semibold text-sm text-white">
                    <dt>Total Paid</dt>
                    <dd className="tabular-nums">{invoice.summary.formattedTotalAmount}</dd>
                  </div>
                </dl>
              </div>

              {/* Gateway Transaction Details & Compliance Notice */}
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 space-y-2 text-[11px] text-muted leading-relaxed">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px]">
                  <span>Gateway: {invoice.payment.gateway.toUpperCase()}</span>
                  {invoice.payment.gatewayPaymentId && (
                    <span>Payment Ref: {invoice.payment.gatewayPaymentId}</span>
                  )}
                  {invoice.payment.gatewayOrderId && (
                    <span>Order Ref: {invoice.payment.gatewayOrderId}</span>
                  )}
                </div>
                <p>
                  <strong>Statutory Notice:</strong> {invoice.statutoryNotice}
                </p>
                <p className="text-muted/70 text-[10px]">{invoice.disclaimer}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
