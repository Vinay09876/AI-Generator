"use client";

import { useState } from "react";
import { PlusCircle } from "lucide-react";
import { CreditStoreModal } from "./credit-store-modal";

export function TopUpButton({
  currentBalance = 0,
  className,
}: {
  currentBalance?: number;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

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
