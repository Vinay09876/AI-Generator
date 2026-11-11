/**
 * Scene & pacing clip planner (Batch 5, owner decision A).
 *
 * Uses ONLY visual scene cuts and acoustic silence intervals. No speech is recognised and no
 * transcript is fabricated: the scorer receives an explicitly empty transcript, which selects
 * its non-speech (scene/pacing) mode. Output words are always empty, so no captions can be
 * burned. Original audio is preserved by the renderer.
 */

import type { SilenceInterval } from "../analysis/audio";
import { scoreCandidateHighlights } from "../analysis/highlight";
import type { CandidateHighlight, ClipperJobSettings, TranscriptResult } from "../types";
import type { ClipPlanContext } from "./process-job";

/** Explicit "no speech analysis performed" marker — NOT a transcript of silence. */
export const SPEECH_ANALYSIS_UNAVAILABLE: TranscriptResult = Object.freeze({
  segments: [],
  fullText: "",
  language: "und",
  isVisualOnly: true,
}) as TranscriptResult;

type SilenceCapable = { detectSilence?: (source: ClipPlanContext["source"]) => Promise<SilenceInterval[]> };

export class ClipPlanningError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ClipPlanningError";
  }
}

export async function planScenePacingClips(
  ctx: ClipPlanContext,
  settings: Pick<ClipperJobSettings, "requestedClipsCount" | "targetAspectRatio" | "targetFraming">,
): Promise<CandidateHighlight[]> {
  const { engine, source, metadata, signal } = ctx;
  if (signal.aborted) throw new ClipPlanningError("PLANNING_ABORTED", "Planning aborted.");

  const sceneCuts = await engine.detectScenes(source);
  if (signal.aborted) throw new ClipPlanningError("PLANNING_ABORTED", "Planning aborted.");

  let silenceIntervals: SilenceInterval[] = [];
  const silenceCapable = engine as unknown as SilenceCapable;
  if (metadata.hasAudio && typeof silenceCapable.detectSilence === "function") {
    silenceIntervals = await silenceCapable.detectSilence(source);
  }
  if (signal.aborted) throw new ClipPlanningError("PLANNING_ABORTED", "Planning aborted.");

  const scored = scoreCandidateHighlights({
    sourceDurationSeconds: metadata.durationSeconds,
    sceneCuts,
    transcript: SPEECH_ANALYSIS_UNAVAILABLE,
    silenceIntervals,
    requestedClipsCount: settings.requestedClipsCount,
    targetAspectRatio: settings.targetAspectRatio,
    targetFraming: settings.targetFraming,
  });

  // Defence in depth: never carry words/transcript text into rendering.
  return scored.map((h) => ({ ...h, words: [], transcriptText: "" }));
}
