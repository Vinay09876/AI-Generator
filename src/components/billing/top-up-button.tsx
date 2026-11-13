"use client";

import { useState } from "react";
import { PlusCircle } from "lucide-react";
import { CreditStoreModal } from "./credit-store-modal";
import { PurchasesUnavailableBadge } from "./purchases-unavailable";

export function TopUpButton({
  currentBalance = 0,
  className,
  purchasesEnabled,
}: {
  currentBalance?: number;
  className?: string;
  /** From getPurchaseAvailability() on the server. When false no store or order flow is rendered. */
  purchasesEnabled: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  if (!purchasesEnabled) return <PurchasesUnavailableBadge />;

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={
          className ??
          "inline-flex items-center gap-1.5 rounded-full bg-violet/20 px-3 py-1 text-xs font-semibold text-violet-200 ring-1 ring-violet/40 hover:bg-violet/30 transition-colors"
        }
      >
        <PlusCircle className="size-3.5" aria-hidden />
        <span>Buy Credits</span>
      </button>

      <CreditStoreModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        currentBalance={currentBalance}
      />
    </>
  );
}
