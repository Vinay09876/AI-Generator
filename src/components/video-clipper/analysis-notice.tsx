import { AudioLines, CaptionsOff, Clapperboard, MicOff } from "lucide-react";
import type { ClipJobView } from "@/features/clipper/job-view";

type Analysis = ClipJobView["analysis"];

/**
 * Permanent, plain statement of what the clipper does and does not analyse. Driven by the API's
 * `analysis` capabilities so it cannot drift from the backend.
 */
export function AnalysisNotice({ analysis }: { analysis: Analysis }) {
  const rows = [
    {
      icon: Clapperboard,
      label: "How clips are chosen",
      value: analysis.highlightMode === "scene_pacing" ? "Scene changes and pacing (cuts and pauses)" : "Not available",
      ok: true,
    },
    {
      icon: MicOff,
      label: "Speech analysis",
      value: analysis.speechAnalysis === "unavailable" ? "Not available yet: what people say is not analysed" : "Available",
      ok: analysis.speechAnalysis !== "unavailable",
    },
    {
      icon: CaptionsOff,
      label: "Captions",
      value: analysis.captions === "unavailable" ? "Not available yet: clips have no subtitles" : "Available",
      ok: analysis.captions !== "unavailable",
    },
    {
      icon: AudioLines,
      label: "Audio",
      value: analysis.originalAudio === "preserved" ? "Original audio kept, loudness evened out" : "Not kept",
      ok: true,
    },
  ];
  return (
    <section aria-labelledby="clipper-analysis-heading" className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
      <h2 id="clipper-analysis-heading" className="text-xs font-medium tracking-wider text-muted/80 uppercase">
        What this tool does
      </h2>
      <ul className="mt-3 space-y-2.5">
        {rows.map(({ icon: Icon, label, value, ok }) => (
          <li key={label} className="flex items-start gap-3 text-sm">
            <Icon className={ok ? "mt-0.5 size-4 shrink-0 text-cyan" : "mt-0.5 size-4 shrink-0 text-amber-300"} aria-hidden="true" />
            <span>
              <span className="font-medium text-foreground">{label}:</span> <span className="text-muted">{value}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
