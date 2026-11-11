/**
 * Deterministic Candidate Highlight Selection Engine.
 *
 * Implements:
 * - Multi-factor scoring combining:
 *   1. Speech density (words-per-second pacing curve)
 *   2. Hook detection (opening questions, trigger keywords, urgency in first 3-5s)
 *   3. Dead-air / silence penalties
 *   4. Scene cut boundary alignment (prevents awkward mid-sentence / mid-cut splits)
 * - Visual-only / silent video mode: bases highlight candidates on visual scene pacing
 *   and transition density without requiring speech.
 * - Non-overlapping greedy selection of top N candidate highlights.
 * - Re-indexing of word timestamps relative to clip start (startTime = 0s).
 */

import type {
  CandidateHighlight,
  SceneCut,
  TranscriptResult,
  TranscriptWord,
} from "../types";
import type { SilenceInterval } from "./audio";
import {
  type ClipperAspectRatio,
  type ClipperFramingMode,
  DEFAULT_CLIPPER_ASPECT_RATIO,
  DEFAULT_CLIPPER_FRAMING_MODE,
  DEFAULT_MAX_CLIP_DURATION_SECONDS,
  DEFAULT_MIN_CLIP_DURATION_SECONDS,
  DEFAULT_TARGET_CLIP_DURATION_SECONDS,
} from "../config";

// ---------------------------------------------------------------------------
// Highlight Scoring Parameters
// ---------------------------------------------------------------------------
export interface HighlightScoringParams {
  sourceDurationSeconds: number;
  sceneCuts: SceneCut[];
  transcript: TranscriptResult;
  silenceIntervals?: SilenceInterval[];
  requestedClipsCount?: number;
  targetClipDurationSeconds?: number;
  targetAspectRatio?: ClipperAspectRatio;
  targetFraming?: ClipperFramingMode;
}

// ---------------------------------------------------------------------------
// Hook Trigger Words
// ---------------------------------------------------------------------------
const HOOK_TRIGGERS = new Set([
  "secret",
  "secrets",
  "why",
  "how",
  "never",
  "always",
  "best",
  "worst",
  "truth",
  "stop",
  "mistake",
  "mistakes",
  "breakthrough",
  "discover",
  "insane",
  "important",
  "key",
  "step",
  "steps",
  "rule",
  "rules",
  "hack",
  "hacks",
  "warning",
  "listen",
  "watch",
  "remember",
  "nobody",
  "everyone",
  "believe",
  "crazy",
]);

// ---------------------------------------------------------------------------
// Internal Candidate Window
// ---------------------------------------------------------------------------
interface ScoredWindow {
  startTime: number;
  endTime: number;
  durationSeconds: number;
  score: number;
  reason: string;
  title: string;
  transcriptText: string;
  words: TranscriptWord[];
}

// ---------------------------------------------------------------------------
// Scoring Heuristics
// ---------------------------------------------------------------------------
function calculateSpeechDensityScore(wordsCount: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  const wps = wordsCount / durationSeconds;

  // Ideal speech rate for engaging social video: 2.2 to 3.8 words per second
  if (wps >= 2.2 && wps <= 3.8) {
    return 30.0;
  }
  if (wps > 1.2 && wps < 2.2) {
    return 15.0 + (wps - 1.2) * 15.0;
  }
  if (wps > 3.8 && wps <= 5.0) {
    return 30.0 - (wps - 3.8) * 15.0;
  }
  if (wps >= 0.5 && wps <= 1.2) {
    return 10.0;
  }
  return 0.0; // Dead air or excessively rushed
}

function calculateHookScore(firstSecondsText: string): { score: number; foundTriggers: string[] } {
  let score = 0;
  const foundTriggers: string[] = [];

  // Question mark in hook window
  if (firstSecondsText.includes("?")) {
    score += 15.0;
    foundTriggers.push("opening question");
  }

  // Tokenize and match keywords
  const tokens = firstSecondsText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (HOOK_TRIGGERS.has(token) && !foundTriggers.includes(token)) {
      foundTriggers.push(token);
      score += 5.0;
      if (score >= 30.0) break;
    }
  }

  return { score: Math.min(30.0, score), foundTriggers };
}

function calculateSilencePenalty(
  startTime: number,
  endTime: number,
  silenceIntervals: SilenceInterval[],
): number {
  if (silenceIntervals.length === 0) return 0;

  let totalSilenceSeconds = 0;
  for (const sil of silenceIntervals) {
    const overlapStart = Math.max(startTime, sil.start);
    const overlapEnd = Math.min(endTime, sil.end);
    if (overlapEnd > overlapStart) {
      totalSilenceSeconds += overlapEnd - overlapStart;
    }
  }

  const duration = endTime - startTime;
  const ratio = totalSilenceSeconds / duration;

  // Penalize windows with significant dead air
  if (ratio > 0.4) return -30.0;
  if (ratio > 0.2) return -15.0;
  if (ratio > 0.1) return -5.0;
  return 0.0;
}

function calculateSceneAlignmentScore(
  startTime: number,
  endTime: number,
  sceneCuts: SceneCut[],
): { score: number; snappedStart: number; snappedEnd: number } {
  let score = 0;
  let snappedStart = startTime;
  let snappedEnd = endTime;

  // Check if start is near a scene cut (within 1.5s)
  for (const cut of sceneCuts) {
    if (Math.abs(cut.timestampSeconds - startTime) <= 1.5) {
      score += 10.0;
      snappedStart = cut.timestampSeconds;
      break;
    }
  }

  // Check if end is near a scene cut (within 1.5s)
  for (const cut of sceneCuts) {
    if (Math.abs(cut.timestampSeconds - endTime) <= 1.5) {
      score += 10.0;
      snappedEnd = cut.timestampSeconds;
      break;
    }
  }

  return { score, snappedStart, snappedEnd };
}

function generateHighlightTitle(index: number, triggers: string[], textSnippet: string, isVisualOnly: boolean): string {
  if (isVisualOnly) {
    return `Visual Scene Highlight #${index + 1}`;
  }

  if (triggers.length > 0) {
    const triggerWord = triggers[0].toUpperCase();
    return `${triggerWord}: The Key Takeaway`;
  }

  const words = textSnippet.trim().split(/\s+/).slice(0, 5).join(" ");
  if (words.length > 5) {
    return `"${words}..."`;
  }

  return `Key Highlight #${index + 1}`;
}

// ---------------------------------------------------------------------------
// Candidate Window Generator
// ---------------------------------------------------------------------------
export function scoreCandidateHighlights(params: HighlightScoringParams): CandidateHighlight[] {
  const {
    sourceDurationSeconds,
    sceneCuts = [],
    transcript,
    silenceIntervals = [],
    requestedClipsCount = 1,
    targetClipDurationSeconds = DEFAULT_TARGET_CLIP_DURATION_SECONDS,
    targetAspectRatio = DEFAULT_CLIPPER_ASPECT_RATIO,
    targetFraming = DEFAULT_CLIPPER_FRAMING_MODE,
  } = params;

  const clipCount = Math.max(1, Math.min(requestedClipsCount, 3));
  const minDur = DEFAULT_MIN_CLIP_DURATION_SECONDS;
  const maxDur = Math.min(DEFAULT_MAX_CLIP_DURATION_SECONDS, sourceDurationSeconds);
  const targetDur = Math.max(minDur, Math.min(targetClipDurationSeconds, maxDur));

  const isVisualOnly = transcript.isVisualOnly || transcript.segments.length === 0;

  const candidateWindows: ScoredWindow[] = [];

  // Generate anchor points from scene cuts or periodic time steps
  const anchorPoints = new Set<number>([0]);
  for (const cut of sceneCuts) {
    if (cut.timestampSeconds + minDur <= sourceDurationSeconds) {
      anchorPoints.add(Math.round(cut.timestampSeconds * 10) / 10);
    }
  }

  // Also sample periodic steps (every 5-10 seconds)
  const step = Math.max(5, Math.floor(targetDur / 3));
  for (let t = 0; t + minDur <= sourceDurationSeconds; t += step) {
    anchorPoints.add(t);
  }

  const sortedAnchors = Array.from(anchorPoints).sort((a, b) => a - b);

  for (const anchor of sortedAnchors) {
    const rawEnd = Math.min(sourceDurationSeconds, anchor + targetDur);
    if (rawEnd - anchor < minDur) continue;

    // Check scene cut alignment and potential snap
    const { score: sceneScore, snappedStart, snappedEnd } = calculateSceneAlignmentScore(
      anchor,
      rawEnd,
      sceneCuts,
    );

    const startTime = Math.max(0, snappedStart);
    const endTime = Math.min(sourceDurationSeconds, snappedEnd);
    const durationSeconds = Math.round((endTime - startTime) * 100) / 100;

    if (durationSeconds < minDur || durationSeconds > maxDur) continue;

    if (isVisualOnly) {
      // Visual-only scoring: scene pacing, position bias
      const sceneCutsInWindow = sceneCuts.filter(
        (c) => c.timestampSeconds >= startTime && c.timestampSeconds <= endTime,
      );
      const visualScore = Math.min(40.0, sceneCutsInWindow.length * 10.0) + sceneScore;
      const positionBonus = startTime < sourceDurationSeconds * 0.3 ? 15.0 : 5.0;
      const finalScore = Math.round(visualScore + positionBonus);

      candidateWindows.push({
        startTime,
        endTime,
        durationSeconds,
        score: finalScore,
        reason: `Visual pacing with ${sceneCutsInWindow.length} scene cuts and strong transition alignment.`,
        title: generateHighlightTitle(candidateWindows.length, [], "", true),
        transcriptText: "",
        words: [],
      });
      continue;
    }

    // Audio / Speech scoring
    // 1. Collect words in window
    const windowWords: TranscriptWord[] = [];
    for (const seg of transcript.segments) {
      for (const w of seg.words) {
        if (w.end >= startTime && w.start <= endTime) {
          windowWords.push(w);
        }
      }
    }

    // 2. Speech density
    const densityScore = calculateSpeechDensityScore(windowWords.length, durationSeconds);

    // 3. Hook score (first 4 seconds of candidate)
    const hookWords = windowWords
      .filter((w) => w.start <= startTime + 4.0)
      .map((w) => w.word)
      .join(" ");
    const { score: hookScore, foundTriggers } = calculateHookScore(hookWords);

    // 4. Silence penalty
    const silencePenalty = calculateSilencePenalty(startTime, endTime, silenceIntervals);

    // 5. Composite score
    const totalScore = Math.max(
      0,
      Math.min(100, Math.round(densityScore + hookScore + sceneScore + silencePenalty)),
    );

    const windowText = windowWords.map((w) => w.word).join(" ");
    const reasonParts: string[] = [];
    if (foundTriggers.length > 0) reasonParts.push(`Hook: ${foundTriggers.join(", ")}`);
    reasonParts.push(`${Math.round(windowWords.length / durationSeconds * 10) / 10} words/sec`);
    if (sceneScore > 0) reasonParts.push("scene-aligned");

    candidateWindows.push({
      startTime,
      endTime,
      durationSeconds,
      score: totalScore,
      reason: reasonParts.join(" | "),
      title: generateHighlightTitle(candidateWindows.length, foundTriggers, windowText, false),
      transcriptText: windowText,
      words: windowWords,
    });
  }

  // Sort candidate windows by score descending
  candidateWindows.sort((a, b) => b.score - a.score);

  // Greedy non-overlapping selection
  const selected: CandidateHighlight[] = [];

  for (const cand of candidateWindows) {
    if (selected.length >= clipCount) break;

    // Check overlap with already selected clips (allow maximum 20% overlap)
    let overlaps = false;
    for (const existing of selected) {
      const overlapStart = Math.max(cand.startTime, existing.startTime);
      const overlapEnd = Math.min(cand.endTime, existing.endTime);
      if (overlapEnd > overlapStart) {
        const overlapDuration = overlapEnd - overlapStart;
        const minDuration = Math.min(cand.durationSeconds, existing.durationSeconds);
        if (overlapDuration / minDuration > 0.2) {
          overlaps = true;
          break;
        }
      }
    }

    if (!overlaps) {
      // Re-index word timestamps relative to clip start (startTime = 0)
      const reindexedWords: TranscriptWord[] = cand.words.map((w) => ({
        word: w.word,
        start: Math.max(0, Math.round((w.start - cand.startTime) * 1000) / 1000),
        end: Math.max(0, Math.round((w.end - cand.startTime) * 1000) / 1000),
        confidence: w.confidence,
        isInterpolated: w.isInterpolated,
      }));

      selected.push({
        id: `highlight-${selected.length + 1}`,
        title: cand.title,
        startTime: cand.startTime,
        endTime: cand.endTime,
        durationSeconds: cand.durationSeconds,
        score: cand.score,
        reason: cand.reason,
        transcriptText: cand.transcriptText,
        words: reindexedWords,
        aspectRatio: targetAspectRatio,
        framing: targetFraming,
      });
    }
  }

  // Fallback: If no candidate was found (e.g. video shorter than minDur), create a single safe window
  if (selected.length === 0) {
    const end = Math.min(sourceDurationSeconds, targetDur);
    selected.push({
      id: "highlight-1",
      title: "Clip #1",
      startTime: 0,
      endTime: end,
      durationSeconds: Math.round(end * 100) / 100,
      score: 50,
      reason: "Default full video segment",
      transcriptText: "",
      words: [],
      aspectRatio: targetAspectRatio,
      framing: targetFraming,
    });
  }

  return selected;
}
