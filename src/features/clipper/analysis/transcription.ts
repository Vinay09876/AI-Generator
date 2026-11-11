/**
 * Whisper Transcription Parser for JSON, WebVTT, and SRT Formats.
 *
 * Implements:
 * - Multi-format ingestion: Whisper native JSON, WebVTT (.vtt), and SubRip (.srt).
 * - Segment-to-word linear interpolation when ground-truth word timestamps are absent.
 * - Crucial accuracy safeguard: explicitly flags isInterpolated: true and hasWordLevelAlignment: false
 *   when acoustic word timestamps are missing. Never misrepresents segment boundaries as word accuracy.
 * - Visual-only / silent audio handling (clean empty result with isVisualOnly: true).
 */

import type { TranscriptResult, TranscriptSegment, TranscriptWord } from "../types";

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------
export class TranscriptionParseError extends Error {
  readonly code: string;

  constructor(message: string, code = "TRANSCRIPT_PARSE_FAILED") {
    super(message);
    this.name = "TranscriptionParseError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Timestamp Conversion Helpers
// ---------------------------------------------------------------------------
/**
 * Converts VTT / SRT timestamp string to seconds.
 * Supports:
 *   - "00:01:23.456" (VTT with period)
 *   - "00:01:23,456" (SRT with comma)
 *   - "01:23.456" (VTT short format)
 */
export function parseTimestampToSeconds(ts: string): number {
  const cleaned = ts.trim().replace(",", ".");
  const parts = cleaned.split(":");

  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    if (Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000) / 1000;
    }
  } else if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return Math.round((minutes * 60 + seconds) * 1000) / 1000;
    }
  }

  const direct = parseFloat(cleaned);
  return Number.isFinite(direct) ? direct : 0;
}

/**
 * Linearly interpolates word boundaries across a segment window when
 * word-level acoustic timestamps are not provided by the model.
 *
 * Explicitly marks words with isInterpolated: true to prevent claiming
 * false word-level precision.
 */
export function interpolateSegmentWords(text: string, start: number, end: number): TranscriptWord[] {
  const rawWords = text.trim().split(/\s+/).filter(Boolean);
  if (rawWords.length === 0) return [];

  const duration = Math.max(0.1, end - start);
  const wordDuration = duration / rawWords.length;

  return rawWords.map((word, idx) => {
    const wStart = Math.round((start + idx * wordDuration) * 1000) / 1000;
    const wEnd = Math.round((wStart + wordDuration) * 1000) / 1000;
    return {
      word,
      start: wStart,
      end: Math.min(wEnd, end),
      isInterpolated: true, // Safeguard: acoustic alignment was not present
    };
  });
}

// ---------------------------------------------------------------------------
// Whisper JSON Parser
// ---------------------------------------------------------------------------
export function parseWhisperJson(raw: unknown): TranscriptResult {
  if (!raw) {
    return { segments: [], fullText: "", language: "en", isVisualOnly: true };
  }

  let obj: any = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) {
      return { segments: [], fullText: "", language: "en", isVisualOnly: true };
    }
    try {
      obj = JSON.parse(raw);
    } catch (err: any) {
      throw new TranscriptionParseError(`Invalid Whisper JSON payload: ${err.message}`, "INVALID_JSON");
    }
  }

  if (obj.isVisualOnly) {
    return { segments: [], fullText: "", language: obj.language ?? "en", isVisualOnly: true };
  }

  const rawSegments = Array.isArray(obj.segments) ? obj.segments : [];
  const language = typeof obj.language === "string" ? obj.language : "en";
  let fullText = typeof obj.text === "string" ? obj.text.trim() : "";

  const segments: TranscriptSegment[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const s = rawSegments[i];
    const start = typeof s.start === "number" ? s.start : parseFloat(s.start ?? "0");
    const end = typeof s.end === "number" ? s.end : parseFloat(s.end ?? "0");
    const text = typeof s.text === "string" ? s.text.trim() : "";

    if (!text || end <= start) continue;

    const segmentId = s.id !== undefined ? `seg-${s.id}` : `seg-${i}`;

    let words: TranscriptWord[] = [];
    let hasWordLevelAlignment = false;

    if (Array.isArray(s.words) && s.words.length > 0) {
      // Acoustic word-level timestamps present
      words = s.words.map((w: any) => ({
        word: typeof w.word === "string" ? w.word.trim() : String(w),
        start: typeof w.start === "number" ? w.start : parseFloat(w.start ?? String(start)),
        end: typeof w.end === "number" ? w.end : parseFloat(w.end ?? String(end)),
        confidence: typeof w.probability === "number" ? w.probability : undefined,
        isInterpolated: false,
      })).filter((w: TranscriptWord) => Boolean(w.word));

      hasWordLevelAlignment = words.length > 0;
    }

    if (!hasWordLevelAlignment) {
      // Fallback: interpolate segment words linearly
      words = interpolateSegmentWords(text, start, end);
    }

    segments.push({
      id: segmentId,
      text,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      words,
      hasWordLevelAlignment,
    });
  }

  if (!fullText && segments.length > 0) {
    fullText = segments.map((s) => s.text).join(" ");
  }

  return {
    segments: segments.sort((a, b) => a.start - b.start),
    fullText,
    language,
    isVisualOnly: segments.length === 0,
  };
}

// ---------------------------------------------------------------------------
// WebVTT Parser
// ---------------------------------------------------------------------------
export function parseVttTranscript(vttText: string): TranscriptResult {
  if (!vttText || !vttText.trim()) {
    return { segments: [], fullText: "", language: "en", isVisualOnly: true };
  }

  const lines = vttText.split(/\r?\n/);
  const segments: TranscriptSegment[] = [];
  let cueIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("WEBVTT") || line.startsWith("NOTE")) continue;

    // Detect cue timestamp line: "00:00:01.000 --> 00:00:04.500"
    if (line.includes("-->")) {
      const [startStr, endStr] = line.split("-->").map((s) => s.trim().split(" ")[0]);
      const start = parseTimestampToSeconds(startStr);
      const end = parseTimestampToSeconds(endStr);

      // Collect payload text on subsequent lines until empty line
      const textLines: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].trim() && !lines[i + 1].includes("-->")) {
        i++;
        textLines.push(lines[i].trim());
      }

      const text = textLines.join(" ").replace(/<[^>]+>/g, "").trim(); // Strip HTML tags
      if (text && end > start) {
        cueIndex++;
        segments.push({
          id: `vtt-${cueIndex}`,
          text,
          start,
          end,
          words: interpolateSegmentWords(text, start, end),
          hasWordLevelAlignment: false, // VTT format provides cue-level timing only
        });
      }
    }
  }

  const fullText = segments.map((s) => s.text).join(" ");
  return {
    segments: segments.sort((a, b) => a.start - b.start),
    fullText,
    language: "en",
    isVisualOnly: segments.length === 0,
  };
}

// ---------------------------------------------------------------------------
// SubRip (.srt) Parser
// ---------------------------------------------------------------------------
export function parseSrtTranscript(srtText: string): TranscriptResult {
  if (!srtText || !srtText.trim()) {
    return { segments: [], fullText: "", language: "en", isVisualOnly: true };
  }

  const blocks = srtText.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  const segments: TranscriptSegment[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    let timeLineIndex = 1;
    // Handle cases where block does not start with an integer index
    if (lines[0].includes("-->")) {
      timeLineIndex = 0;
    }

    const timeLine = lines[timeLineIndex];
    if (!timeLine.includes("-->")) continue;

    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim().split(" ")[0]);
    const start = parseTimestampToSeconds(startStr);
    const end = parseTimestampToSeconds(endStr);

    const textLines = lines.slice(timeLineIndex + 1);
    const text = textLines.join(" ").replace(/<[^>]+>/g, "").trim();

    if (text && end > start) {
      segments.push({
        id: `srt-${i + 1}`,
        text,
        start,
        end,
        words: interpolateSegmentWords(text, start, end),
        hasWordLevelAlignment: false, // SRT format provides block-level timing only
      });
    }
  }

  const fullText = segments.map((s) => s.text).join(" ");
  return {
    segments: segments.sort((a, b) => a.start - b.start),
    fullText,
    language: "en",
    isVisualOnly: segments.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Auto-detecting Transcript Parser
// ---------------------------------------------------------------------------
export function parseTranscriptAuto(input: unknown): TranscriptResult {
  if (!input) {
    return { segments: [], fullText: "", language: "en", isVisualOnly: true };
  }

  if (typeof input === "object") {
    return parseWhisperJson(input);
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      return { segments: [], fullText: "", language: "en", isVisualOnly: true };
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return parseWhisperJson(trimmed);
    }

    if (trimmed.startsWith("WEBVTT")) {
      return parseVttTranscript(trimmed);
    }

    if (/^\d+\r?\n\d\d:\d\d:\d\d/.test(trimmed) || trimmed.includes("-->")) {
      return parseSrtTranscript(trimmed);
    }

    // Single line plain text fallback
    return {
      segments: [
        {
          id: "plain-1",
          text: trimmed,
          start: 0,
          end: Math.max(5, trimmed.split(/\s+/).length * 0.4),
          words: interpolateSegmentWords(trimmed, 0, Math.max(5, trimmed.split(/\s+/).length * 0.4)),
          hasWordLevelAlignment: false,
        },
      ],
      fullText: trimmed,
      language: "en",
      isVisualOnly: false,
    };
  }

  return { segments: [], fullText: "", language: "en", isVisualOnly: true };
}
