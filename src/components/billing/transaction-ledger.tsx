"use client";

import { useState } from "react";
import {
  Coins,
  ArrowDownLeft,
  ArrowUpRight,
  RotateCcw,
  PlusCircle,
  FileText,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import type { CreditTransactionType } from "@/generated/prisma/client";
import type { DetailedCreditTransactionItem } from "@/features/credits/queries";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { TaxInvoiceModal } from "./tax-invoice-modal";
import { CreditStoreModal } from "./credit-store-modal";
import { cn } from "@/lib/utils";

interface LedgerProps {
  initialItems: DetailedCreditTransactionItem[];
  walletBalance: number;
}

type FilterTab = "ALL" | "PURCHASES" | "USAGE" | "REFUNDS";

export function TransactionLedger({ initialItems, walletBalance }: LedgerProps) {
  const [filter, setFilter] = useState<FilterTab>("ALL");
  const [balance, setBalance] = useState<number>(walletBalance);
  const [selectedInvoiceOrderId, setSelectedInvoiceOrderId] = useState<string | null>(null);
  const [isStoreOpen, setIsStoreOpen] = useState(false);

  const filteredItems = initialItems.filter((item) => {
    if (filter === "PURCHASES") return item.type === "PURCHASE";
    if (filter === "REFUNDS") return item.type === "REFUND";
    if (filter === "USAGE") return item.type === "GENERATION_DEBIT";
    return true;
  });

  const getBadgeConfig = (type: CreditTransactionType) => {
    switch (type) {
      case "PURCHASE":
        return {
          label: "Purchase",
          icon: ShoppingBag,
          color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
        };
      case "INITIAL_GRANT":
        return {
          label: "Signup Grant",
          icon: Sparkles,
          color: "text-violet-300 bg-violet-500/10 border-violet-500/20",
        };
      case "REFUND":
        return {
          label: "Refund",
          icon: RotateCcw,
          color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
        };
      case "GENERATION_DEBIT":
        return {
          label: "Studio Compute",
          icon: ArrowUpRight,
          color: "text-muted bg-white/[0.04] border-white/10",
        };
      default:
        return {
          label: type,
          icon: Coins,
          color: "text-muted bg-white/[0.04] border-white/10",
        };
    }
  };

  return (
    <>
      <section
        aria-label="Transaction Ledger"
        className="rounded-3xl border border-white/[0.08] bg-surface p-5 sm:p-6 space-y-5"
      >
        {/* Ledger Header & Action Bar */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-semibold text-base text-foreground">
              <Coins className="size-4 text-violet-300" aria-hidden />
              <span>Credit Ledger &amp; Receipts</span>
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Complete double-entry audit history of your purchases, compute usage, and refunds.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsStoreOpen(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-gradient-to-r from-violet to-fuchsia px-4 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition-opacity"
            >
              <PlusCircle className="size-3.5" aria-hidden />
              <span>Buy Credits</span>
            </button>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1.5 border-b border-white/[0.06] pb-3 text-xs">
          {(
            [
              { id: "ALL", label: "All Transactions" },
              { id: "PURCHASES", label: "Purchases" },
              { id: "USAGE", label: "Studio Usage" },
              { id: "REFUNDS", label: "Refunds" },
            ] as const
          ).map((tab) => {
            const active = filter === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={cn(
                  "rounded-xl px-3 py-1.5 font-medium transition-colors",
                  active
                    ? "bg-white/[0.08] text-foreground font-semibold"
                    : "text-muted hover:bg-white/[0.04] hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Ledger Table */}
        {filteredItems.length === 0 ? (
          <div className="py-12 text-center text-xs text-muted">
            <Coins className="mx-auto size-6 opacity-40 mb-2" aria-hidden />
            <p>No transactions found in this category.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
            <table className="w-full text-left text-xs">
              <thead className="bg-white/[0.03] text-muted border-b border-white/[0.06]">
                <tr>
                  <th className="py-3 px-3.5">Type</th>
                  <th className="py-3 px-3.5">Description</th>
                  <th className="py-3 px-3.5 text-right">Amount</th>
                  <th className="py-3 px-3.5 text-right">Balance After</th>
                  <th className="py-3 px-3.5 text-right">Date</th>
                  <th className="py-3 px-3.5 text-right">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {filteredItems.map((item) => {
                  const badge = getBadgeConfig(item.type);
                  const Icon = badge.icon;
                  const isPositive = item.amount > 0;

                  return (
                    <tr key={item.id} className="transition-colors hover:bg-white/[0.02]">
                      {/* Type Badge */}
                      <td className="py-3 px-3.5 whitespace-nowrap">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                            badge.color,
                          )}
                        >
                          <Icon className="size-3" aria-hidden />
                          <span>{badge.label}</span>
                        </span>
                      </td>

                      {/* Description */}
                      <td className="py-3 px-3.5 font-medium text-foreground max-w-xs truncate">
                        {item.description || (
                          <span className="text-muted italic">Credit transaction</span>
                        )}
                      </td>

                      {/* Amount */}
                      <td className="py-3 px-3.5 text-right tabular-nums whitespace-nowrap font-medium">
                        <span className={isPositive ? "text-emerald-400" : "text-foreground"}>
                          {isPositive ? `+${formatNumber(item.amount)}` : formatNumber(item.amount)} cr
                        </span>
                      </td>

                      {/* Balance After */}
                      <td className="py-3 px-3.5 text-right tabular-nums text-muted whitespace-nowrap">
                        {formatNumber(item.balanceAfter)} cr
                      </td>

                      {/* Date */}
                      <td
                        className="py-3 px-3.5 text-right text-muted whitespace-nowrap"
                        title={formatDateTime(item.createdAt)}
                      >
                        {formatRelative(item.createdAt)}
                      </td>

                      {/* Receipt Link */}
                      <td className="py-3 px-3.5 text-right whitespace-nowrap">
                        {item.paymentOrderId && item.paymentOrder?.status === "PAID" ? (
                          <button
                            type="button"
                            onClick={() => setSelectedInvoiceOrderId(item.paymentOrderId)}
                            className="inline-flex items-center gap-1 rounded-lg bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-violet-300 ring-1 ring-white/10 hover:bg-white/10 hover:text-white transition-colors"
                          >
                            <FileText className="size-3" aria-hidden />
                            <span>Receipt</span>
                          </button>
                        ) : (
                          <span className="text-muted/40">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Credit Store Modal */}
      <CreditStoreModal
        isOpen={isStoreOpen}
        onClose={() => setIsStoreOpen(false)}
        currentBalance={balance}
        onSuccess={(newBal) => setBalance(newBal)}
      />

      {/* Tax Invoice Modal */}
      {selectedInvoiceOrderId && (
        <TaxInvoiceModal
          orderId={selectedInvoiceOrderId}
          isOpen={Boolean(selectedInvoiceOrderId)}
          onClose={() => setSelectedInvoiceOrderId(null)}
        />
      )}
    </>
  );
}
