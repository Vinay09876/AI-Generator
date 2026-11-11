"use client";

import { useId } from "react";
import { Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";

const SAMPLE_PROMPTS = [
  {
    label: "Drone Flight",
    prompt:
      "FPV cinematic drone diving through misty Icelandic waterfalls at golden hour, volumetric sun rays, photorealistic 8k",
  },
  {
    label: "Cyberpunk Alley",
    prompt:
      "Rain-slicked neon cyberpunk street, steam rising from asphalt grates, anamorphic lens flares, cinematic depth of field",
  },
  {
    label: "Macro Wildlife",
    prompt:
      "Extreme macro slow-motion of a dew drop falling from a vibrant tropical leaf, prismatic light refractions, crystal sharp",
  },
  {
    label: "Deep Space",
    prompt:
      "Sleek futuristic spacecraft cruising past a colossal purple ringed gas giant, starry cosmic background, cinematic 35mm",
  },
  {
    label: "Vintage Drift",
    prompt:
      "Classic 1970s sports car drifting along a sun-drenched coastal mountain road, authentic 35mm film grain, sunset glow",
  },
];

interface VideoPromptEditorProps {
  value: string;
  maxLength: number;
  error?: string | null;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSelectSample?: (prompt: string) => void;
}

export function VideoPromptEditor({
  value,
  maxLength,
  error,
  readOnly,
  onChange,
  onSelectSample,
}: VideoPromptEditorProps) {
  const textareaId = useId();
  const errorId = useId();
  const countId = useId();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label htmlFor={textareaId} className="text-xs font-medium tracking-wider text-muted/80 uppercase">
          Video Prompt
        </label>
        <span
          id={countId}
          aria-live="polite"
          className={cn(
            "font-mono text-xs tabular-nums transition-colors",
            value.length > maxLength * 0.9 ? "text-amber-400" : "text-muted/60",
          )}
        >
          {value.length} / {maxLength}
        </span>
      </div>

      <div className="relative">
        <textarea
          id={textareaId}
          rows={4}
          value={value}
          maxLength={maxLength}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : countId}
          placeholder="Describe your scene with camera movements, lighting, and cinematic style (e.g., 'Slow tracking shot through a bioluminescent forest, volumetric morning haze, 35mm anamorphic lens...')"
          className={cn(
            "w-full resize-none rounded-2xl border bg-black/30 p-4 text-sm leading-relaxed text-foreground placeholder:text-muted/50 transition-all",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet",
            "disabled:cursor-not-allowed disabled:opacity-60",
            error
              ? "border-rose-500/50 focus-visible:outline-rose-500"
              : "border-white/[0.08] focus:border-white/20 hover:border-white/15",
          )}
        />

        {value.length > 0 && !readOnly && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="Clear prompt"
            aria-label="Clear prompt"
            className="absolute top-3 right-3 rounded-lg p-1.5 text-muted/60 transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-rose-400">
          {error}
        </p>
      )}

      {/* Inspiration Quick-Start Chips */}
      {!readOnly && (
        <div className="space-y-1.5 pt-1">
          <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-muted/60 uppercase">
            <Sparkles className="size-3 text-violet-400" />
            Inspiration Ideas
          </p>
          <div className="flex flex-wrap gap-1.5">
            {SAMPLE_PROMPTS.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  onChange(item.prompt);
                  onSelectSample?.(item.prompt);
                }}
                className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-xs text-muted/80 transition-all hover:border-violet/40 hover:bg-violet/10 hover:text-violet-200"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

