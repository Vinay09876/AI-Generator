"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, CheckCircle2, Clock, Loader2, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";
import type { CancelQueuedResult, ReleasePendingResult, StatusView } from "@/features/clipper/client";
import { cn } from "@/lib/utils";

const TONE: Record<StatusView["tone"], string> = {
  neutral: "border-white/[0.08] bg-white/[0.02]",
  progress: "border-violet/25 bg-violet/[0.06]",
  success: "border-emerald-400/25 bg-emerald-400/[0.06]",
  warning: "border-amber-400/25 bg-amber-400/[0.06]",
  danger: "border-rose-400/25 bg-rose-400/[0.06]",
};

function StatusIcon({ status }: { status: StatusView }) {
  const cls = "size-5 shrink-0";
  if (status.tone === "success") return <CheckCircle2 className={cn(cls, "text-emerald-300")} aria-hidden="true" />;
  if (status.tone === "danger") return <XCircle className={cn(cls, "text-rose-300")} aria-hidden="true" />;
  if (status.tone === "warning") return <AlertTriangle className={cn(cls, "text-amber-300")} aria-hidden="true" />;
  if (status.kind === "queued") return <Clock className={cn(cls, "text-muted")} aria-hidden="true" />;
  if (status.tone === "progress") return <Loader2 className={cn(cls, "text-violet-300 motion-safe:animate-spin")} aria-hidden="true" />;
  return <Clock className={cn(cls, "text-muted")} aria-hidden="true" />;
}

export function ClipperStatus({
  status,
  onCancelUpload,
  onCancelQueued,
  onRetry,
  onChooseFile,
  onRefresh,
  onReleasePending,
}: {
  status: StatusView;
  onCancelUpload: () => void;
  onCancelQueued: () => Promise<CancelQueuedResult>;
  onRetry?: () => void;
  onChooseFile?: () => void;
  onRefresh?: () => void;
  onReleasePending?: () => Promise<ReleasePendingResult>;
}) {
  const reduce = useReducedMotion();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [releaseNote, setReleaseNote] = useState<string | null>(null);

  const action = status.error?.action;

  async function releasePending() {
    if (!onReleasePending) return;
    setReleasing(true);
    const res = await onReleasePending();
    setReleasing(false);
    setReleaseNote(
      res.ok
        ? res.released > 0
          ? "Released. You can try again now."
          : "Nothing needed releasing. You can try again now."
        : res.message,
    );
  }

  async function confirmCancel() {
    setCancelling(true);
    const res = await onCancelQueued();
    setCancelling(false);
    setConfirming(false);
    setCancelNote(res.ok ? null : res.message);
  }

  return (
    <motion.section
      aria-labelledby="clipper-status-title"
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.25 }}
      className={cn("rounded-3xl border p-5 sm:p-6", TONE[status.tone])}
    >
      <div role="status" aria-live="polite" className="flex items-start gap-3">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <h2 id="clipper-status-title" className="font-display text-lg font-semibold text-foreground">
            {status.title}
          </h2>
          <p className="mt-1 text-sm text-muted">{status.detail}</p>
          {status.elapsedLabel && <p className="mt-2 text-xs text-muted/80 tabular-nums">{status.elapsedLabel}</p>}
        </div>
      </div>

      {status.uploadPercent !== null && (
        <div className="mt-5">
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={status.uploadPercent}
            className="h-2 overflow-hidden rounded-full bg-white/[0.08]"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet to-cyan transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${status.uploadPercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted tabular-nums">{status.uploadPercent}% uploaded</p>
        </div>
      )}

      {releaseNote && (
        <p role="status" className="mt-4 text-sm text-foreground">
          {releaseNote}
        </p>
      )}

      {cancelNote && (
        <p role="alert" className="mt-4 text-sm text-amber-200">
          {cancelNote}
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {status.canCancelUpload && (
          <Button type="button" variant="secondary" size="sm" onClick={onCancelUpload}>
            Cancel upload
          </Button>
        )}
        {status.canCancelQueued &&
          (confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-foreground">Cancel this job? Your credits will be refunded.</span>
              <Button type="button" variant="secondary" size="sm" loading={cancelling} onClick={confirmCancel}>
                Yes, cancel and refund
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={cancelling}>
                Keep waiting
              </Button>
            </div>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              Cancel and refund
            </Button>
          ))}
        {action === "retry" && onRetry && (
          <Button type="button" size="sm" onClick={onRetry}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Try again
          </Button>
        )}
        {(action === "choose_file" || status.kind === "cancelled") && onChooseFile && (
          <Button type="button" size="sm" variant={action === "choose_file" ? "primary" : "secondary"} onClick={onChooseFile}>
            Choose another video
          </Button>
        )}
        {(action === "refresh" || status.kind === "expired") && onRefresh && (
          <Button type="button" size="sm" variant="secondary" onClick={onRefresh}>
            Reload page
          </Button>
        )}
        {action === "release_pending" && onReleasePending && (
          <Button type="button" size="sm" variant="secondary" loading={releasing} onClick={releasePending}>
            Release my pending upload
          </Button>
        )}
        {action === "release_pending" && onRetry && releaseNote && (
          <Button type="button" size="sm" onClick={onRetry}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Try again
          </Button>
        )}
        {action === "sign_in" && (
          <a href={ROUTES.login} className="text-sm font-medium text-violet-300 underline-offset-4 hover:underline">
            Sign in again
          </a>
        )}
      </div>
    </motion.section>
  );
}
