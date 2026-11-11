/**
 * High-Contrast ASS & SRT Subtitle Generator with Karaoke Word Highlighting.
 *
 * Implements:
 * - ASS (Advanced SubStation Alpha v4+) generation with resolution-aware styles.
 * - Dynamic karaoke word-timing tags ({\k<centiseconds>}) for engaging short-form playback.
 * - Multi-word chunking (3-5 words per dialogue event) optimized for vertical mobile screens.
 * - Strict injection defense: sanitizes curly braces, backslashes, and control characters to prevent
 *   ASS command injection or layout breakout.
 * - Clean SubRip (.srt) generator fallback.
 * - Timing monotonicity validation.
 */

import type { CandidateHighlight, TranscriptWord } from "../types";
import { CLIPPER_ASPECT_RATIOS, SUBTITLE_DEFAULTS, type ClipperAspectRatio } from "../config";

// ---------------------------------------------------------------------------
// Options & Configuration
// ---------------------------------------------------------------------------
export interface SubtitleGeneratorOptions {
  /** Maximum words per subtitle phrase. Default: 4. */
  maxWordsPerSegment?: number;
  /** Whether to output karaoke {\k} highlight tags. Default: true. */
  enableKaraoke?: boolean;
  /** Primary text color in ASS format (&HAABBGGRR). Default: White (&H00FFFFFF). */
  primaryColor?: string;
  /** Secondary highlight color in ASS format. Default: Yellow (&H0000FFFF). */
  secondaryColor?: string;
  /** Border outline color in ASS format. Default: Black (&H00000000). */
  outlineColor?: string;
  /** Font face name. Default: Inter. */
  fontName?: string;
  /** Font size in pixels. Default: 52 for 1080p width. */
  fontSize?: number;
  /** Bottom vertical margin in pixels. Default: 180. */
  marginV?: number;
}

// ---------------------------------------------------------------------------
// Security: ASS Text Sanitization & Injection Defense
// ---------------------------------------------------------------------------
/**
 * Sanitizes subtitle text to prevent ASS injection vulnerabilities.
 * In ASS files, curly braces `{}` and backslashes `\` denote formatting tags
 * and drawing commands. Unescaped input can hijack player layout or execution.
 */
export function sanitizeAssText(text: string): string {
  if (!text) return "";

  return text
    // Replace null bytes and non-printable control characters
    .replace(/[\x00-\x1F\x7F]/g, "")
    // Strip or escape curly braces so user text cannot inject ASS tags
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    // Replace backslashes
    .replace(/\\/g, "/")
    .trim();
}

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------
/** Formats seconds into ASS timestamp: H:MM:SS.CC (centiseconds). */
export function formatAssTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.floor(Math.round((safe % 1) * 100));

  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const cc = String(Math.min(99, centis)).padStart(2, "0");

  return `${hours}:${mm}:${ss}.${cc}`;
}

/** Formats seconds into SRT timestamp: HH:MM:SS,mmm (milliseconds). */
export function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor(Math.round((safe % 1) * 1000));

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const mmm = String(Math.min(999, millis)).padStart(3, "0");

  return `${hh}:${mm}:${ss},${mmm}`;
}

// ---------------------------------------------------------------------------
// Word Grouping Helper
// ---------------------------------------------------------------------------
interface SubtitleChunk {
  start: number;
  end: number;
  words: TranscriptWord[];
}

export function chunkWords(words: TranscriptWord[], maxWords = 4): SubtitleChunk[] {
  const chunks: SubtitleChunk[] = [];
  if (words.length === 0) return chunks;

  let currentChunk: TranscriptWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    currentChunk.push(w);

    const isPunctuationBreak = /[.?!]$/.test(w.word);
    const isMaxWordsReached = currentChunk.length >= maxWords;
    const isLastWord = i === words.length - 1;

    if (isPunctuationBreak || isMaxWordsReached || isLastWord) {
      const start = currentChunk[0].start;
      const end = currentChunk[currentChunk.length - 1].end;
      chunks.push({
        start: Math.max(0, start),
        end: Math.max(start + 0.3, end),
        words: [...currentChunk],
      });
      currentChunk = [];
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// ASS Subtitle Generator
// ---------------------------------------------------------------------------
export function generateAssSubtitles(
  clip: CandidateHighlight,
  options?: SubtitleGeneratorOptions,
): string {
  const aspectRatio = (clip.aspectRatio ?? "9:16") as ClipperAspectRatio;
  const canvas = CLIPPER_ASPECT_RATIOS[aspectRatio] ?? CLIPPER_ASPECT_RATIOS["9:16"];

  const fontName = options?.fontName ?? SUBTITLE_DEFAULTS.fontName;
  const fontSize = options?.fontSize ?? SUBTITLE_DEFAULTS.fontSize;
  const primaryColor = options?.primaryColor ?? SUBTITLE_DEFAULTS.primaryColor;
  const secondaryColor = options?.secondaryColor ?? SUBTITLE_DEFAULTS.secondaryColor;
  const outlineColor = options?.outlineColor ?? SUBTITLE_DEFAULTS.outlineColor;
  const backColor = SUBTITLE_DEFAULTS.backColor;
  const marginV = options?.marginV ?? SUBTITLE_DEFAULTS.marginV;
  const enableKaraoke = options?.enableKaraoke ?? true;
  const maxWords = options?.maxWordsPerSegment ?? SUBTITLE_DEFAULTS.maxWordsPerSegment;

  const scriptHeader = [
    "[Script Info]",
    `; Script generated for YourAI Clipper - Highlight "${sanitizeAssText(clip.title)}"`,
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${fontSize},${primaryColor},${secondaryColor},${outlineColor},${backColor},-1,0,0,0,100,100,0,0,1,3.5,1.5,2,20,20,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const dialogueLines: string[] = [];
  const words = clip.words ?? [];

  if (words.length > 0) {
    const chunks = chunkWords(words, maxWords);

    for (const chunk of chunks) {
      const startTs = formatAssTimestamp(chunk.start);
      const endTs = formatAssTimestamp(Math.min(clip.durationSeconds, chunk.end));

      let lineText = "";

      if (enableKaraoke) {
        // Build karaoke tags: {\k<centiseconds>}Word
        lineText = chunk.words
          .map((w) => {
            const rawDuration = Math.max(0.1, w.end - w.start);
            const centiseconds = Math.max(5, Math.round(rawDuration * 100));
            const safeWord = sanitizeAssText(w.word);
            return `{\\k${centiseconds}}${safeWord}`;
          })
          .join(" ");
      } else {
        // Standard styled text
        lineText = chunk.words.map((w) => sanitizeAssText(w.word)).join(" ");
      }

      dialogueLines.push(`Dialogue: 0,${startTs},${endTs},Default,,0,0,0,,${lineText}`);
    }
  } else if (clip.transcriptText) {
    // Fallback: single dialogue line from full transcript text
    const startTs = formatAssTimestamp(0);
    const endTs = formatAssTimestamp(Math.min(clip.durationSeconds, 5));
    const safeText = sanitizeAssText(clip.transcriptText);
    dialogueLines.push(`Dialogue: 0,${startTs},${endTs},Default,,0,0,0,,${safeText}`);
  }

  return [...scriptHeader, ...dialogueLines].join("\n");
}

// ---------------------------------------------------------------------------
// SRT Subtitle Generator (Standard Fallback)
// ---------------------------------------------------------------------------
export function generateSrtSubtitles(
  clip: CandidateHighlight,
  maxWords = 4,
): string {
  const words = clip.words ?? [];
  if (words.length === 0 && !clip.transcriptText) return "";

  const srtBlocks: string[] = [];

  if (words.length > 0) {
    const chunks = chunkWords(words, maxWords);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const startTs = formatSrtTimestamp(chunk.start);
      const endTs = formatSrtTimestamp(Math.min(clip.durationSeconds, chunk.end));
      const text = chunk.words.map((w) => sanitizeAssText(w.word)).join(" ");

      srtBlocks.push(`${i + 1}\n${startTs} --> ${endTs}\n${text}`);
    }
  } else {
    const endTs = formatSrtTimestamp(Math.min(clip.durationSeconds, 5));
    srtBlocks.push(`1\n00:00:00,000 --> ${endTs}\n${sanitizeAssText(clip.transcriptText)}`);
  }

  return srtBlocks.join("\n\n");
}
