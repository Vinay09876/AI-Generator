"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CircleCheck, ImageIcon, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GenerationState } from "@/features/generations/client/generation-controller";
import { cn } from "@/lib/utils";
import { ResultActions } from "./result-actions";

/** Seconds since `startedAt`, ticking once a second while mounted. */
function useElapsedSeconds(startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

const frame =
  "relative isolate grid aspect-square w-full place-items-center overflow-hidden rounded-2xl";

/**
 * Square stage for the generated image (1024 × 1024). States: empty, in progress (submitting /
 * generating / checking), completed image, failed (refunded), stalled, and rejected requests
 * (which keep the stage empty — their message is shown next to the Generate button).
 */
export function PreviewStage({
  state,
  onCheckAgain,
  onCheckNow,
  onUsePrompt,
  onTryAgain,
  banner,
  className,
}: {
  state: GenerationState;
  onCheckAgain: () => void;
  onCheckNow: () => void;
  onUsePrompt?: (prompt: string) => void;
  onTryAgain: (prompt: string) => void;
  /** Optional strip above the stage (e.g. "Viewing an earlier image"). */
  banner?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby="preview-heading"
      className={cn("rounded-3xl border border-white/[0.08] bg-surface p-3 sm:p-4", className)}
    >
      <h2 id="preview-heading" className="sr-only">
        Preview
      </h2>
      {banner}
      <StageContent state={state} onCheckAgain={onCheckAgain} onCheckNow={onCheckNow} onUsePrompt={onUsePrompt} onTryAgain={onTryAgain} />
    </section>
  );
}

function StageContent({
  state,
  onCheckAgain,
  onCheckNow,
  onUsePrompt,
  onTryAgain,
}: {
  state: GenerationState;
  onCheckAgain: () => void;
  onCheckNow: () => void;
  onUsePrompt?: (prompt: string) => void;
  onTryAgain: (prompt: string) => void;
}) {
  switch (state.phase) {
    case "submitting":
    case "polling":
      return <InProgress state={state} onCheckNow={onCheckNow} />;
    case "completed":
      // Keyed by job: switching images resets the loading / error state.
      return <CompletedImage key={state.job.id} state={state} onUsePrompt={onUsePrompt} />;
    case "failed":
      return (
        <Message
          tone="error"
          icon={<AlertTriangle className="size-5" aria-hidden />}
          title="Generation failed"
          body={state.message}
          badge="Credits refunded"
          action={
            <Button variant="secondary" onClick={() => onTryAgain(state.job.prompt ?? "")}>
              <RotateCcw className="size-4" aria-hidden /> Try again
            </Button>
          }
        />
      );
    case "stalled":
      return (
        <Message
          tone="warning"
          icon={<RefreshCw className="size-5" aria-hidden />}
          title="Still checking your image"
          body={state.message}
          action={
            <Button variant="secondary" onClick={onCheckAgain}>
              <RefreshCw className="size-4" aria-hidden /> Check again
            </Button>
          }
        />
      );
    default:
      return <Empty />;
  }
}

function Empty() {
  return (
    <div className={cn(frame, "border border-dashed border-white/10 bg-black/20")}>
      <div aria-hidden className="bg-grid absolute inset-0 -z-10 opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      <div aria-hidden className="absolute -z-10 size-2/3 rounded-full bg-violet/10 blur-3xl" />
      <div className="flex max-w-xs flex-col items-center px-6 text-center">
        <span className="grid size-12 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-violet/20 to-cyan/10 text-violet-200">
          <ImageIcon className="size-5" aria-hidden />
        </span>
        <p className="mt-4 font-medium">Your image will appear here</p>
        <p className="mt-1 text-sm text-muted">
          Write a prompt, pick a quality and press Generate. Images are 1024 × 1024 and private to your account.
        </p>
      </div>
    </div>
  );
}

function InProgress({ state, onCheckNow }: { state: Extract<GenerationState, { phase: "submitting" | "polling" }>; onCheckNow: () => void }) {
  const seconds = useElapsedSeconds(state.startedAt);
  const uncertain = state.checking || (state.phase === "polling" && state.outcomeUnknown);

  let title = state.recovered ? "Resuming your generation…" : "Generating your image…";
  let body = state.recovered ? "We picked up where you left off. It won't be created or charged twice." : "This usually takes a few seconds.";
  if (state.checking) {
    title = "Connection interrupted — checking…";
    body = "We're confirming your generation. It won't be created or charged twice.";
  } else if (uncertain) {
    title = "Taking longer than usual…";
    body = "We're checking on it. If it doesn't finish, your credits are refunded automatically within about 5 minutes.";
  } else if (seconds >= 15) {
    body = "Still working — this can take a little longer at busy times.";
  }

  return (
    <div className={cn(frame, "border-glow shimmer")} aria-busy="true">
      <div aria-hidden className="absolute -z-10 size-2/3 rounded-full bg-violet/15 blur-3xl" />
      <div className="flex max-w-xs flex-col items-center px-6 text-center">
        <span
          className={cn(
            "grid size-12 place-items-center rounded-2xl border",
            uncertain ? "border-amber-300/25 bg-amber-400/10 text-amber-100" : "border-white/10 bg-white/[0.04] text-violet-200",
          )}
        >
          <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
        </span>
        <p className="mt-4 font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted">{body}</p>
        <p className="mt-3 text-xs text-muted/80 tabular-nums" aria-hidden>
          {seconds} s
        </p>
        {uncertain && (
          // Manual recovery for uncertain outcomes: checks immediately (GET or same-key replay).
          <Button variant="secondary" size="sm" className="mt-4 h-11" onClick={onCheckNow}>
            <RefreshCw className="size-4" aria-hidden /> Check now
          </Button>
        )}
      </div>
    </div>
  );
}

function CompletedImage({
  state,
  onUsePrompt,
}: {
  state: Extract<GenerationState, { phase: "completed" }>;
  onUsePrompt?: (prompt: string) => void;
}) {
  const { job, asset } = state;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const prompt = job.prompt ?? "";
  const alt = prompt ? `Generated image: ${prompt.length > 160 ? `${prompt.slice(0, 157)}…` : prompt}` : "Generated image";

  return (
    <div className="space-y-3">
      <div className={cn(frame, "border border-white/[0.08] bg-black/30", status === "loading" && "shimmer")}>
        {status !== "error" ? (
          // Same-origin asset route (ownership check → short-lived signed URL). next/image is not
          // used: the optimiser would fetch the private image server-side without the user's session.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={attempt}
            src={attempt ? `${asset.url}?r=${attempt}` : asset.url}
            alt={alt}
            width={asset.width ?? 1024}
            height={asset.height ?? 1024}
            decoding="async"
            onLoad={() => setStatus("loaded")}
            onError={() => setStatus("error")}
            className={cn(
              "absolute inset-0 size-full object-contain transition-opacity duration-500 motion-reduce:transition-none",
              status === "loaded" ? "opacity-100" : "opacity-0",
            )}
          />
        ) : (
          <div className="flex max-w-xs flex-col items-center px-6 text-center">
            <p className="font-medium">The image couldn&apos;t be loaded</p>
            <p className="mt-1 text-sm text-muted">It was generated and saved. Try loading it again.</p>
            <Button
              variant="secondary"
              className="mt-4"
              onClick={() => {
                setStatus("loading");
                setAttempt((a) => a + 1);
              }}
            >
              <RefreshCw className="size-4" aria-hidden /> Reload image
            </Button>
          </div>
        )}
      </div>
      <p className="flex items-center gap-1.5 px-1 text-xs text-muted">
        <CircleCheck className="size-3.5 text-emerald-300" aria-hidden />
        {job.quality === "detailed" ? "Detailed" : "Fast"} · {job.creditsCharged} credit{job.creditsCharged === 1 ? "" : "s"} ·{" "}
        {asset.width ?? 1024} × {asset.height ?? 1024}
      </p>
      <ResultActions jobId={job.id} assetUrl={asset.url} prompt={prompt} onUsePrompt={onUsePrompt} />
    </div>
  );
}

function Message({
  tone,
  icon,
  title,
  body,
  badge,
  action,
}: {
  tone: "error" | "warning";
  icon: React.ReactNode;
  title: string;
  body: string;
  badge?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn(frame, "border border-white/[0.08] bg-black/20")}>
      <div className="flex max-w-sm flex-col items-center px-6 text-center">
        <span
          className={cn(
            "grid size-12 place-items-center rounded-2xl border",
            tone === "error" ? "border-rose-400/25 bg-rose-500/10 text-rose-200" : "border-amber-300/25 bg-amber-400/10 text-amber-100",
          )}
        >
          {icon}
        </span>
        <p className="mt-4 font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted">{body}</p>
        {badge && (
          <span className="mt-3 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-0.5 text-xs font-medium text-emerald-200">
            {badge}
          </span>
        )}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}
