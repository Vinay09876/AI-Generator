"use client";

import { Timer } from "lucide-react";
import { CLIPPER_FRAMING_MODES, type ClipperAspectRatio, type ClipperFramingMode } from "@/features/clipper/config";
import { cn } from "@/lib/utils";

const ASPECTS: { value: ClipperAspectRatio; name: string; use: string; box: string }[] = [
  { value: "9:16", name: "Vertical", use: "Reels, Shorts, TikTok", box: "h-7 w-4" },
  { value: "1:1", name: "Square", use: "Feeds", box: "size-6" },
  { value: "16:9", name: "Landscape", use: "Web, YouTube", box: "h-4 w-7" },
];

const FRAMINGS = (Object.keys(CLIPPER_FRAMING_MODES) as ClipperFramingMode[]).map((id) => ({
  id,
  label: CLIPPER_FRAMING_MODES[id].label,
  description:
    id === "pillarbox_blur"
      ? "Whole frame centred over a blurred copy of itself. Nothing is cut off."
      : id === "center_crop"
        ? "Fills the canvas by cropping the edges. Fine when the action is centred."
        : "Whole frame with solid bars where it doesn't fill the canvas.",
}));

const optionCard =
  "flex cursor-pointer rounded-2xl border p-3 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-violet peer-checked:border-violet/50 peer-checked:bg-violet/10 peer-checked:text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-50 border-white/[0.08] bg-white/[0.02] text-muted hover:border-white/15 hover:bg-white/[0.04]";

export interface ClipSettingsValue {
  aspectRatio: ClipperAspectRatio;
  framing: ClipperFramingMode;
  clipCount: number;
}

export function ClipSettings({
  value,
  onChange,
  maxClips,
  clipDuration,
  disabled,
}: {
  value: ClipSettingsValue;
  onChange: (next: ClipSettingsValue) => void;
  maxClips: number;
  clipDuration: { targetSeconds: number; minSeconds: number; maxSeconds: number };
  disabled?: boolean;
}) {
  return (
    <div className="space-y-6">
      <fieldset disabled={disabled}>
        <legend className="text-xs font-medium tracking-wider text-muted/80 uppercase">Aspect ratio</legend>
        <div className="mt-2 grid grid-cols-3 gap-2.5">
          {ASPECTS.map((a) => (
            <label key={a.value} className="relative">
              <input
                type="radio"
                name="clip-aspect"
                value={a.value}
                checked={value.aspectRatio === a.value}
                onChange={() => onChange({ ...value, aspectRatio: a.value })}
                className="peer sr-only"
              />
              <span className={cn(optionCard, "flex-col items-center gap-2 text-center")}>
                <span className="grid h-8 place-items-center" aria-hidden="true">
                  <span className={cn("rounded-[3px] border-2 border-current", a.box)} />
                </span>
                <span className="text-xs font-semibold text-foreground">{a.value}</span>
                <span className="text-[11px] leading-tight">
                  {a.name}
                  <span className="sr-only">, for </span>
                  <span className="block text-muted/70">{a.use}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend className="text-xs font-medium tracking-wider text-muted/80 uppercase">Framing</legend>
        <div className="mt-2 space-y-2">
          {FRAMINGS.map((f) => (
            <label key={f.id} className="relative block">
              <input
                type="radio"
                name="clip-framing"
                value={f.id}
                checked={value.framing === f.id}
                onChange={() => onChange({ ...value, framing: f.id })}
                className="peer sr-only"
              />
              <span className={cn(optionCard, "flex-col gap-0.5")}>
                <span className="text-sm font-medium text-foreground">{f.label}</span>
                <span className="text-xs">{f.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend className="text-xs font-medium tracking-wider text-muted/80 uppercase">Number of clips</legend>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${maxClips}, minmax(0, 1fr))` }}>
          {Array.from({ length: maxClips }, (_, i) => i + 1).map((n) => (
            <label key={n} className="relative">
              <input
                type="radio"
                name="clip-count"
                value={n}
                checked={value.clipCount === n}
                onChange={() => onChange({ ...value, clipCount: n })}
                className="peer sr-only"
              />
              <span className={cn(optionCard, "justify-center py-2.5 text-sm font-semibold tabular-nums")}>
                {n}
                <span className="sr-only"> clip{n === 1 ? "" : "s"}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-start gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-3 text-xs text-muted">
        <Timer className="mt-0.5 size-4 shrink-0 text-cyan" aria-hidden="true" />
        <p>
          <span className="font-medium text-foreground">Clip length: about {clipDuration.targetSeconds} seconds each</span> (always between{" "}
          {clipDuration.minSeconds} and {clipDuration.maxSeconds} seconds). Start and end points follow scene changes, so lengths vary. Length
          can&apos;t be adjusted yet.
        </p>
      </div>
    </div>
  );
}
