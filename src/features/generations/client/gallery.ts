import type { AssetView, ImageJobView } from "../job-view";
import type { GenerationPhase } from "./generation-controller";

/*
 * What the main preview shows: the live generation (controller state) or an earlier image
 * picked from the recent gallery. Pure view state — selecting a historical image never touches
 * the generation controller or the stored pending request.
 */

export type GalleryItem = { job: ImageJobView; asset: AssetView | null };

export type PreviewView = { kind: "generation" } | { kind: "history"; jobId: string };

export const GENERATION_VIEW: PreviewView = { kind: "generation" };

/** Only completed jobs with a same-origin asset URL can be shown. */
export function isViewable(item: GalleryItem): item is { job: ImageJobView; asset: AssetView } {
  return item.job.status === "COMPLETED" && item.asset !== null && item.asset.url.startsWith("/api/assets/");
}

/** Select an earlier image (ignored if it is not in the list or not viewable). */
export function selectHistory(view: PreviewView, items: GalleryItem[], jobId: string): PreviewView {
  const item = items.find((i) => i.job.id === jobId);
  if (!item || !isViewable(item)) return view;
  return { kind: "history", jobId };
}

/** Back to the live generation. */
export const showGeneration = (): PreviewView => GENERATION_VIEW;

/**
 * Phases that bring the live generation back into view: a new submission and its outcome.
 * (A rejected request shows its message next to the Generate button, so the selected image
 * stays visible in that case.)
 */
const SURFACING_PHASES = new Set<GenerationPhase>(["submitting", "completed", "failed", "stalled"]);

/** React to a generation phase change: the user sees a new submission and its result. */
export function onGenerationPhaseChange(view: PreviewView, previous: GenerationPhase, next: GenerationPhase): PreviewView {
  if (view.kind === "generation" || previous === next) return view;
  return SURFACING_PHASES.has(next) ? GENERATION_VIEW : view;
}

/** Resolve the view against the current list (e.g. after a refresh removed an item). */
export function resolvePreview(view: PreviewView, items: GalleryItem[]): { kind: "generation" } | { kind: "history"; item: { job: ImageJobView; asset: AssetView } } {
  if (view.kind === "generation") return { kind: "generation" };
  const item = items.find((i) => i.job.id === view.jobId);
  return item && isViewable(item) ? { kind: "history", item } : { kind: "generation" };
}

/** Safe single-line excerpt for labels (no markup, bounded length). */
export function promptExcerpt(prompt: string | null, max = 90) {
  const text = (prompt ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Untitled image";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
