"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Coins,
  X,
  Sparkles,
  Check,
  ShieldCheck,
  ArrowRight,
  Loader2,
  FileText,
  AlertCircle,
  Zap,
} from "lucide-react";
import { formatNumber } from "@/lib/format";
import { TaxInvoiceModal } from "./tax-invoice-modal";
import { cn } from "@/lib/utils";

interface CreditPackageView {
  id: string;
  name: string;
  credits: number;
  priceFormatted: string;
  badge?: string;
  popular?: boolean;
  description: string;
  unitCostFormatted: string;
}

const PACKAGES: readonly CreditPackageView[] = [
  {
    id: "PKG_STARTER",
    name: "Starter",
    credits: 100,
    priceFormatted: "₹50",
    description: "Ideal for trying out FLUX.1 images and short clips.",
    unitCostFormatted: "₹0.50 / credit",
  },
  {
    id: "PKG_CREATOR",
    name: "Creator",
    credits: 500,
    priceFormatted: "₹699",
    badge: "Most Popular",
    popular: true,
    description: "Great for frequent video generation (Wan 2.1) and high-res clipping.",
    unitCostFormatted: "₹1.40 / credit",
  },
  {
    id: "PKG_PRO",
    name: "Pro Studio",
    credits: 1500,
    priceFormatted: "₹1,599",
    badge: "Best Value",
    description: "Maximum compute capacity for heavy video rendering and multi-clip exports.",
    unitCostFormatted: "₹1.07 / credit",
  },
] as const;

export function CreditStoreModal({
  isOpen,
  onClose,
  currentBalance = 0,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentBalance?: number;
  onSuccess?: (newBalance: number) => void;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string>("PKG_CREATOR");
  const [status, setStatus] = useState<"idle" | "creating" | "checkout" | "verifying" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Active checkout transaction state
  const [createdOrder, setCreatedOrder] = useState<{
    orderId: string;
    receipt: string;
    gateway: string;
    gatewayOrderId: string;
    creditsAllocated: number;
    amountMinor: number;
    mockPaymentPayload?: {
      gatewayOrderId: string;
      gatewayPaymentId: string;
      gatewaySignature: string;
    };
  } | null>(null);

  const [settledResult, setSettledResult] = useState<{
    orderId: string;
    balance: number;
    receipt: string;
  } | null>(null);

  const [showInvoiceModal, setShowInvoiceModal] = useState(false);

  if (!isOpen) return null;

  const selectedPkg = PACKAGES.find((p) => p.id === selectedId) ?? PACKAGES[1];

  const handleCreateOrder = async () => {
    setStatus("creating");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/billing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: selectedPkg.id }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to initiate payment order");
      }

      setCreatedOrder(data);
      setStatus("checkout");
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to create order");
      setStatus("error");
    }
  };

  const handleSimulatePayment = async () => {
    if (!createdOrder) return;
    setStatus("verifying");
    setErrorMessage(null);

    try {
      const payload = createdOrder.mockPaymentPayload;
      if (!payload) {
        throw new Error("No mock payment payload available in development mode");
      }

      const res = await fetch("/api/billing/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: createdOrder.orderId,
          gatewayOrderId: payload.gatewayOrderId,
          gatewayPaymentId: payload.gatewayPaymentId,
          gatewaySignature: payload.gatewaySignature,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Payment verification failed");
      }

      setSettledResult({
        orderId: createdOrder.orderId,
        balance: data.balanceAfter ?? data.balance,
        receipt: createdOrder.receipt,
      });

      setStatus("success");
      onSuccess?.(data.balanceAfter ?? data.balance);
      router.refresh();
    } catch (err: any) {
      setErrorMessage(err.message || "Payment simulation verification failed");
      setStatus("error");
    }
  };

  const handleClose = () => {
    setStatus("idle");
    setErrorMessage(null);
    setCreatedOrder(null);
    setSettledResult(null);
    onClose();
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-modal-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      >
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
          onClick={handleClose}
          aria-hidden="true"
        />

        {/* Modal Window */}
        <div className="relative flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-zinc-950 shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4 sm:px-6">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 place-items-center rounded-2xl bg-violet/20 text-violet-300 ring-1 ring-violet/40">
                <Coins className="size-4" aria-hidden />
              </span>
              <div>
                <h2 id="store-modal-title" className="font-semibold text-base text-foreground">
                  Credit Store
                </h2>
                <p className="text-xs text-muted">Instant compute top-up for your creative studio</p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleClose}
              aria-label="Close credit store"
              className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5">
            {status === "success" && settledResult ? (
              /* Success / Completed State */
              <div className="py-6 text-center space-y-4">
                <span className="inline-grid size-14 place-items-center rounded-full bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40">
                  <Check className="size-7" aria-hidden />
                </span>

                <div>
                  <h3 className="font-display text-xl font-semibold text-white">Credits Added Successfully!</h3>
                  <p className="mt-1 text-xs text-muted">
                    Your payment was atomically settled and credited to your studio wallet.
                  </p>
                </div>

                <div className="mx-auto max-w-xs rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 text-center">
                  <span className="text-xs text-muted">New Balance</span>
                  <p className="mt-1 font-display text-3xl font-bold text-white tabular-nums">
                    {formatNumber(settledResult.balance)} <span className="text-sm font-normal text-muted">credits</span>
                  </p>
                  <p className="mt-1 text-[11px] text-emerald-400">
                    +{formatNumber(createdOrder?.creditsAllocated ?? 0)} credits granted
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowInvoiceModal(true)}
                    className="inline-flex h-9 w-full sm:w-auto items-center justify-center gap-1.5 rounded-full bg-white/[0.08] px-4 text-xs font-medium text-foreground ring-1 ring-white/15 hover:bg-white/15"
                  >
                    <FileText className="size-3.5" aria-hidden />
                    <span>View Receipt</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleClose}
                    className="inline-flex h-9 w-full sm:w-auto items-center justify-center gap-1.5 rounded-full bg-violet px-5 text-xs font-semibold text-white hover:bg-violet-600"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : status === "checkout" && createdOrder ? (
              /* Simulated Checkout Step (Mock Gateway) */
              <div className="space-y-4">
                <div className="rounded-2xl border border-violet/30 bg-violet/10 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm text-foreground">{selectedPkg.name} Package</p>
                      <p className="text-xs text-muted">Receipt: {createdOrder.receipt}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-display text-lg font-bold text-white">{selectedPkg.priceFormatted}</p>
                      <p className="text-[10px] text-muted">Total Price</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-2 text-xs text-muted">
                  <p className="font-medium text-foreground">Development / Mock Payment Simulator</p>
                  <p>
                    Live payment gateways (Razorpay / Stripe) are offline in development to maintain ₹0 spend.
                    You can simulate an authoritative checkout payment signature verification below.
                  </p>
                  <div className="font-mono text-[11px] text-muted/80 space-y-0.5 pt-1">
                    <p>Order ID: {createdOrder.orderId}</p>
                    <p>Gateway Ref: {createdOrder.gatewayOrderId}</p>
                  </div>
                </div>

                {errorMessage && (
                  <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-950/20 p-3 text-xs text-red-300">
                    <AlertCircle className="size-4 shrink-0" aria-hidden />
                    <span>{errorMessage}</span>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setStatus("idle")}
                    className="h-10 flex-1 rounded-full border border-white/10 text-xs font-medium text-muted hover:bg-white/[0.04] hover:text-white"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleSimulatePayment}
                    className="inline-flex h-10 flex-[2] items-center justify-center gap-2 rounded-full bg-gradient-to-r from-violet via-fuchsia to-cyan px-4 text-xs font-semibold text-white shadow-lg shadow-violet/20 transition-transform active:scale-95"
                  >
                    <Zap className="size-4" aria-hidden />
                    <span>Simulate Payment &amp; Credit Wallet</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Package Selection Step */
              <>
                {/* Current Balance Banner */}
                <div className="flex items-center justify-between rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs">
                  <span className="text-muted">Current Balance</span>
                  <span className="font-semibold text-foreground tabular-nums">
                    {formatNumber(currentBalance)} credits
                  </span>
                </div>

                {/* Package Cards List */}
                <div className="grid gap-3">
                  {PACKAGES.map((pkg) => {
                    const isSelected = selectedId === pkg.id;

                    return (
                      <div
                        key={pkg.id}
                        onClick={() => setSelectedId(pkg.id)}
                        role="radio"
                        aria-checked={isSelected}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(pkg.id);
                          }
                        }}
                        className={cn(
                          "relative flex cursor-pointer items-start justify-between rounded-2xl border p-4 transition-all duration-200",
                          isSelected
                            ? "border-violet/60 bg-gradient-to-r from-violet/15 via-fuchsia/10 to-transparent shadow-md"
                            : "border-white/[0.08] bg-surface hover:border-white/20 hover:bg-white/[0.03]",
                        )}
                      >
                        <div className="min-w-0 flex-1 pr-3">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-sm text-foreground">{pkg.name}</h3>
                            {pkg.badge && (
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                                  pkg.popular
                                    ? "bg-violet/30 text-violet-200 ring-1 ring-violet/40"
                                    : "bg-cyan/20 text-cyan-200 ring-1 ring-cyan/40",
                                )}
                              >
                                {pkg.badge}
                              </span>
                            )}
                          </div>

                          <p className="mt-1 text-xs text-muted line-clamp-1">{pkg.description}</p>

                          <div className="mt-3 flex items-center gap-3 text-xs">
                            <span className="font-semibold text-violet-300">
                              +{formatNumber(pkg.credits)} credits
                            </span>
                            <span className="text-muted/60">·</span>
                            <span className="text-muted">{pkg.unitCostFormatted}</span>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <span className="font-display text-lg font-bold text-foreground">
                            {pkg.priceFormatted}
                          </span>
                          <span className="block text-[10px] text-muted">Total Price</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Purchase Receipt Notice */}
                <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3 text-[11px] text-muted space-y-1">
                  <div className="flex items-center gap-1.5 text-foreground/90 font-medium">
                    <ShieldCheck className="size-3.5 text-emerald-400" aria-hidden />
                    <span>Purchase Receipt &amp; Billing Notice</span>
                  </div>
                  <p className="text-muted/80">
                    A provisional purchase receipt is generated upon payment settlement. The final payable amount represents the complete purchase price without GST collection, as official GST tax invoices are disabled pending legal supplier registration.
                  </p>
                </div>

                {errorMessage && (
                  <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-950/20 p-3 text-xs text-red-300">
                    <AlertCircle className="size-4 shrink-0" aria-hidden />
                    <span>{errorMessage}</span>
                  </div>
                )}

                {/* Action CTA */}
                <button
                  type="button"
                  onClick={handleCreateOrder}
                  disabled={status === "creating"}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-violet to-fuchsia font-semibold text-xs text-white shadow-lg shadow-violet/25 transition-transform active:scale-95 disabled:opacity-50"
                >
                  {status === "creating" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      <span>Creating Order...</span>
                    </>
                  ) : (
                    <>
                      <span>Continue to Purchase ({selectedPkg.priceFormatted})</span>
                      <ArrowRight className="size-4" aria-hidden />
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tax Invoice Modal triggered after successful purchase */}
      {settledResult && (
        <TaxInvoiceModal
          orderId={settledResult.orderId}
          isOpen={showInvoiceModal}
          onClose={() => setShowInvoiceModal(false)}
        />
      )}
    </>
  );
}
