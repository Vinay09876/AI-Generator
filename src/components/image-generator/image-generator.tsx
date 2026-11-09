"use client";

import { useEffect, useId, useRef, useState } from "react";
import { History, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IMAGE_QUALITIES, PROMPT_MAX_LENGTH, isImageQuality, type ImageQuality } from "@/features/generations/config";
import type { GenerationPhase, GenerationState } from "@/features/generations/client/generation-controller";
import {
  GENERATION_VIEW,
  onGenerationPhaseChange,
  promptExcerpt,
  resolvePreview,
  selectHistory,
  showGeneration,
  type PreviewView,
} from "@/features/generations/client/gallery";
import type { AssetView, ImageJobView } from "@/features/generations/job-view";
import { formatNumber } from "@/lib/format";
import { CostSummary } from "./cost-summary";
import { GenerationAlert } from "./generation-alert";
import { PreviewStage } from "./preview-stage";
import { PromptEditor } from "./prompt-editor";
import { RecentImages } from "./recent-images";
import { RecoveryNoticeCard } from "./recovery-notice";
import { QualitySelector } from "./quality-selector";
import { useGeneration } from "./use-generation";

export type GeneratorJob = { job: ImageJobView; asset: AssetView | null };

export type ImageGeneratorProps = {
  /** Session user id (scopes the locally stored pending request). */
  userId: string;
  balance: number;
  dailyUsed: number;
  dailyLimit: number;
  /** The user's in-progress job from the server (resumed on load, adopted after a refresh). */
  activeJob: GeneratorJob | null;
  /** Recent completed images (owner-scoped, newest first) for the gallery. */
  recentImages: GeneratorJob[];
};

/** Polite screen-reader announcement for each state (errors use role="alert" instead). */
function announcementFor(state: GenerationState): string {
  switch (state.phase) {
    case "submitting":
      return state.checking ? "Connection interrupted. Checking your generation." : "Generating your image.";
    case "polling":
      if (state.checking) return "Connection interrupted. Checking your generation.";
      return state.outcomeUnknown ? "This is taking longer than usual. Still checking." : "Generating your image.";
    case "completed":
      return "Image ready.";
    case "failed":
      return `Generation failed. ${state.message}`;
    case "stalled":
      return "We couldn't confirm the result yet.";
    default:
      return "";
  }
}

export function ImageGenerator({ userId, balance, dailyUsed, dailyLimit, activeJob, recentImages }: ImageGeneratorProps) {
  const { state, notice, controller } = useGeneration(
    userId,
    activeJob ? { id: activeJob.job.id, status: activeJob.job.status, prompt: activeJob.job.prompt, quality: activeJob.job.quality } : null,
  );
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<ImageQuality>("fast");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // What the preview shows: the live generation or an earlier image. Pure view state — it never
  // touches the generation controller or the stored pending request.
  const [view, setView] = useState<PreviewView>(GENERATION_VIEW);
  const lastPhase = useRef<GenerationPhase>(state.phase);
  const formRef = useRef<HTMLFormElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const blockedId = useId();
  const costId = useId();

  const busy = state.phase === "submitting" || state.phase === "polling";
  const cost = IMAGE_QUALITIES[quality].credits;
  const fastCost = IMAGE_QUALITIES.fast.credits;

  useEffect(() => {
    setAnnouncement(announcementFor(state));
  }, [state]);

  // A new submission (and its outcome) brings the live generation back into view.
  useEffect(() => {
    const previous = lastPhase.current;
    lastPhase.current = state.phase;
    setView((v) => onGenerationPhaseChange(v, previous, state.phase));
  }, [state.phase]);

  const preview = resolvePreview(view, recentImages);

  // A recovered job restores the composer to what is being generated (if the editor is empty).
  const recoveredPrompt = (state.phase === "submitting" || state.phase === "polling") && state.recovered ? state.prompt : null;
  const recoveredQuality = recoveredPrompt !== null && (state.phase === "submitting" || state.phase === "polling") ? state.quality : null;
  useEffect(() => {
    if (!recoveredPrompt) return;
    setPrompt((current) => (current === "" ? recoveredPrompt.slice(0, PROMPT_MAX_LENGTH) : current));
    if (recoveredQuality) setQuality(recoveredQuality);
  }, [recoveredPrompt, recoveredQuality]);

  // Stacked layout (below lg): the preview is not beside the composer / gallery, so bring it into
  // view when a generation starts or an earlier image is selected. Focus stays where it is.
  function revealPreview(onlyIfBelowFold: boolean) {
    const el = previewRef.current;
    if (!el || window.matchMedia("(min-width: 1280px)").matches) return; // side by side from xl
    const top = el.getBoundingClientRect().top;
    if (onlyIfBelowFold && top < window.innerHeight * 0.5) return;
    if (!onlyIfBelowFold && top >= 0 && top < window.innerHeight * 0.3) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }
  const phase = state.phase;
  useEffect(() => {
    if (phase === "submitting") revealPreview(true);
    // A rejection is explained next to the Generate button. If that message is outside the viewport
    // (stacked layouts scroll to the preview; short desktop windows), bring it into view. Focus stays.
    if (phase === "error") {
      const el = messagesRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  }, [phase]);

  function onSelectImage(jobId: string) {
    const next = selectHistory(view, recentImages, jobId);
    if (next === view) return;
    setView(next);
    const item = recentImages.find((i) => i.job.id === jobId);
    setAnnouncement("Showing an earlier image: " + promptExcerpt(item?.job.prompt ?? null, 80));
    revealPreview(false);
  }

  // Reasons the server would reject a new job (re-checked server-side regardless). While this
  // page is running its own job, the progress is shown in the preview instead.
  let blocked: string | null = null;
  if (!busy) {
    if (notice?.kind === "held") blocked = "Resume or discard your earlier request before starting a new one.";
    else if (activeJob) blocked = "You have a generation in progress. It will appear here when it finishes.";
    else if (dailyUsed >= dailyLimit) blocked = `You've used all ${formatNumber(dailyLimit)} images for today. The limit resets at 00:00 UTC.`;
    else if (balance < cost) {
      blocked =
        balance >= fastCost && quality !== "fast"
          ? `Not enough credits for Detailed (${cost} needed, you have ${formatNumber(balance)}). Switch to Fast to continue.`
          : `You don't have enough credits for this generation (${cost} needed, you have ${formatNumber(balance)}).`;
    }
  }

  const focusPrompt = () => formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();

  function fillPrompt(text: string, q?: unknown) {
    setPrompt(text.slice(0, PROMPT_MAX_LENGTH));
    if (isImageQuality(q)) setQuality(q);
    setPromptError(null);
    focusPrompt();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || blocked) return; // duplicate clicks and blocked states never send a request
    const text = prompt.trim();
    if (text.length === 0) {
      setPromptError("Enter a prompt to generate an image.");
      focusPrompt();
      return;
    }
    controller.submit({ prompt: text, quality });
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-6 xl:max-w-none xl:grid-cols-12 xl:items-start">
      {/* grid-cols-1 (= minmax(0, 1fr)) + min-w-0 items: long unbreakable text can never widen the page.
          Two columns only from xl (1280px): at lg the sidebar leaves the composer too narrow, so
          tablet / small-laptop widths use a centred single column (max 672px). */}
      <form
        ref={formRef}
        onSubmit={onSubmit}
        noValidate
        aria-label="Create an image"
        aria-busy={busy || undefined}
        className="min-w-0 space-y-6 rounded-3xl border border-white/[0.08] bg-surface p-5 sm:p-6 xl:col-span-5"
      >
        <PromptEditor
          value={prompt}
          maxLength={PROMPT_MAX_LENGTH}
          error={promptError}
          readOnly={busy}
          onChange={(v) => {
            setPrompt(v);
            if (promptError && v.trim()) setPromptError(null);
          }}
        />
        <QualitySelector value={quality} onChange={setQuality} disabled={busy} />
        <CostSummary id={costId} cost={cost} balance={balance} />

        <div ref={messagesRef} className="space-y-3">
          {notice && (
            <RecoveryNoticeCard
              notice={notice}
              busy={busy}
              onRestorePrompt={() => fillPrompt(notice.prompt, notice.quality)}
              onResume={() => controller.resumeHeld()}
              onDiscard={() => controller.discardHeld()}
              onDismiss={() => controller.dismissNotice()}
            />
          )}
          {state.phase === "error" && (
            <GenerationAlert code={state.code} message={state.message} resetAt={state.resetAt} onDismiss={() => controller.reset()} />
          )}
          {blocked && (
            <p id={blockedId} role="status" className="rounded-xl border border-amber-300/20 bg-amber-400/[0.07] px-4 py-3 text-sm text-amber-100">
              {blocked}
            </p>
          )}
          <Button
            type="submit"
            size="lg"
            loading={busy}
            loadingLabel="Generating…"
            disabled={Boolean(blocked)}
            aria-describedby={blocked ? blockedId : costId}
            className="w-full"
          >
            <Wand2 className="size-4" aria-hidden />
            Generate image
          </Button>
        </div>
      </form>

      <div ref={previewRef} className="min-w-0 scroll-mt-20 xl:sticky xl:top-8 xl:col-span-7">
        {preview.kind === "history" ? (
          <PreviewStage
            // An earlier image, rendered with the same component; the controller is not involved.
            state={{ phase: "completed", job: preview.item.job, asset: preview.item.asset }}
            banner={
              <HistoryBanner
                busy={busy}
                onBack={() => {
                  setView(showGeneration());
                  setAnnouncement(busy ? "Showing the generation in progress." : "Showing the generator preview.");
                }}
              />
            }
            onCheckAgain={() => {}}
            onCheckNow={() => {}}
            // While a generation runs the composer is locked, so the prompt can't be swapped in.
            onUsePrompt={busy ? undefined : (text) => fillPrompt(text, preview.item.job.quality)}
            onTryAgain={() => {}}
          />
        ) : (
          <PreviewStage
            state={state}
            onCheckAgain={() => controller.checkAgain()}
            onCheckNow={() => controller.checkNow()}
            onUsePrompt={(text) => fillPrompt(text, state.phase === "completed" ? state.job.quality : undefined)}
            onTryAgain={(text) => {
              fillPrompt(text, state.phase === "failed" ? state.job.quality : undefined);
              controller.reset();
            }}
          />
        )}
      </div>

      <div className="min-w-0 xl:col-span-12">
        <RecentImages
          items={recentImages}
          selectedJobId={preview.kind === "history" ? preview.item.job.id : null}
          onSelect={onSelectImage}
        />
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </div>
  );
}

/** Shown above an earlier image: makes clear it is not the live generation, and how to return. */
function HistoryBanner({ busy, onBack }: { busy: boolean; onBack: () => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/[0.06] bg-black/20 px-3 py-2">
      <p className="flex items-center gap-2 text-xs text-muted">
        <History className="size-3.5 text-violet-300" aria-hidden />
        {busy ? "Viewing an earlier image · a generation is in progress" : "Viewing an earlier image"}
      </p>
      <Button variant="secondary" size="sm" onClick={onBack} className="h-11">
        {busy ? "Show progress" : "Back to generator"}
      </Button>
    </div>
  );
}
