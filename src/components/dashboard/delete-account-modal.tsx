"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";

interface DeleteAccountModalProps {
  hasPassword: boolean;
  creditBalance: number;
}

export function DeleteAccountModal({ hasPassword, creditBalance }: DeleteAccountModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: hasPassword ? password : undefined,
          confirmPhrase: !hasPassword ? confirmPhrase : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to decommission account.");
      }

      // Success: Sign out immediately and redirect to landing
      await signOut({ callbackUrl: "/?deleted=true" });
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/20 bg-rose-500/10 px-3.5 py-1.5 text-xs font-medium text-rose-400 transition-colors hover:border-rose-500/40 hover:bg-rose-500/20"
      >
        <Trash2 className="size-3.5" aria-hidden /> Delete account
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
        >
          <div className="relative w-full max-w-md rounded-3xl border border-white/10 bg-[#121216] p-6 shadow-2xl">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="absolute top-5 right-5 rounded-full p-1 text-muted hover:text-white"
              aria-label="Close dialog"
            >
              <X className="size-4" />
            </button>

            <div className="flex items-center gap-3 text-rose-400">
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-2.5">
                <AlertTriangle className="size-5" />
              </div>
              <h2 id="delete-account-title" className="text-base font-semibold text-white">
                Decommission Account
              </h2>
            </div>

            <div className="mt-4 space-y-3 text-xs leading-relaxed text-muted">
              <p>
                Account deletion is <strong>permanent and irreversible</strong>. Please review the consequences:
              </p>
              <ul className="list-disc space-y-1.5 pl-4 text-white/80">
                <li>Your active sessions will be terminated immediately.</li>
                {creditBalance > 0 && (
                  <li>
                    Remaining balance of <strong>{creditBalance} credits</strong> will be forfeited upon closure.
                  </li>
                )}
                <li>
                  Personal details (name, email, password) will be cryptographically anonymized.
                </li>
                <li>
                  Generated media previews and downloads will become permanently inaccessible (storage assets are de-linked and marked as pending deletion, pending a future operator cleanup workflow).
                </li>
                <li>
                  In accordance with statutory tax and financial reporting requirements, historical payment orders and transaction ledger lines are immutably retained in anonymized format.
                </li>
              </ul>
              <p className="text-[11px] text-white/50">
                Direct relational CASCADE deletion is unsupported in software to guarantee financial ledger integrity.
              </p>
            </div>

            {error && (
              <div role="alert" className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {error}
              </div>
            )}

            <form onSubmit={handleDelete} className="mt-5 space-y-4">
              {hasPassword ? (
                <div>
                  <label htmlFor="delete-password" className="block text-xs font-medium text-white/90">
                    Confirm your password
                  </label>
                  <input
                    id="delete-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter current password"
                    className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm text-white placeholder-muted focus:border-rose-500/50 focus:outline-none"
                  />
                </div>
              ) : (
                <div>
                  <label htmlFor="delete-confirm" className="block text-xs font-medium text-white/90">
                    Type <strong>DELETE</strong> to confirm
                  </label>
                  <input
                    id="delete-confirm"
                    type="text"
                    required
                    value={confirmPhrase}
                    onChange={(e) => setConfirmPhrase(e.target.value)}
                    placeholder="DELETE"
                    className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm text-white placeholder-muted focus:border-rose-500/50 focus:outline-none"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={isSubmitting}
                  className="rounded-full border border-white/10 px-4 py-2 text-xs font-medium text-white hover:bg-white/[0.06] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || (hasPassword ? !password : confirmPhrase !== "DELETE")}
                  className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" /> Decommissioning...
                    </>
                  ) : (
                    "Permanently Decommission"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
