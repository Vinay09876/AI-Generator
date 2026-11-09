"use client";

import { useEffect, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import { ImageIcon, Scissors, SlidersHorizontal, Video, WandSparkles } from "lucide-react";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

const PROMPTS = [
  "Neon-lit Tokyo street at night, rain reflections, cinematic 35mm",
  "Golden hour over desert dunes, soft haze, aerial wide shot",
  "Minimal product shot of a glass perfume bottle on stone",
];

/** Abstract gradient "renders" that stand in for generated images. */
const TILE_SETS = [
  [
    "radial-gradient(circle at 30% 20%, #f0abfc 0%, transparent 40%), linear-gradient(160deg, #1e1b4b, #831843 60%, #0c0a1d)",
    "radial-gradient(circle at 70% 70%, #22d3ee 0%, transparent 45%), linear-gradient(200deg, #172554, #4c1d95 60%, #020617)",
    "radial-gradient(circle at 50% 30%, #f472b6 0%, transparent 35%), linear-gradient(180deg, #312e81, #0f172a)",
    "radial-gradient(circle at 20% 80%, #a78bfa 0%, transparent 40%), linear-gradient(140deg, #0e7490, #3b0764 70%)",
  ],
  [
    "radial-gradient(circle at 70% 25%, #fde68a 0%, transparent 35%), linear-gradient(180deg, #f59e0b, #9a3412 55%, #431407)",
    "radial-gradient(circle at 30% 30%, #fef3c7 0%, transparent 30%), linear-gradient(170deg, #fb923c, #b45309 50%, #451a03)",
    "radial-gradient(ellipse at 50% 90%, #92400e 0%, transparent 60%), linear-gradient(180deg, #fdba74, #ea580c 60%, #7c2d12)",
    "radial-gradient(circle at 80% 20%, #fff7ed 0%, transparent 30%), linear-gradient(200deg, #f97316, #7c2d12 70%)",
  ],
  [
    "radial-gradient(ellipse at 50% 45%, #e0f2fe 0%, transparent 30%), linear-gradient(180deg, #334155, #0f172a)",
    "radial-gradient(ellipse at 50% 50%, #ccfbf1 0%, transparent 28%), linear-gradient(160deg, #57534e, #1c1917)",
    "radial-gradient(ellipse at 45% 40%, #f5f5f4 0%, transparent 25%), linear-gradient(200deg, #44403c, #0c0a09)",
    "radial-gradient(ellipse at 55% 50%, #e9d5ff 0%, transparent 28%), linear-gradient(180deg, #3f3f46, #09090b)",
  ],
];

const WAVE = [
  30, 55, 40, 70, 90, 65, 45, 35, 60, 80, 95, 70, 40, 30, 50, 75, 60, 45, 85, 100, 70, 50, 35, 55,
  40, 30, 65, 45,
];
const HIGHLIGHTS: [number, number][] = [
  [3, 5],
  [9, 11],
  [18, 20],
];

type Phase = "typing" | "generating" | "done" | "deleting";

function usePromptCycle(reduced: boolean) {
  const [index, setIndex] = useState(0);
  const [length, setLength] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");

  useEffect(() => {
    if (reduced) return;
    const current = PROMPTS[index];
    let timer: ReturnType<typeof setTimeout>;

    if (phase === "typing") {
      timer =
        length < current.length
          ? setTimeout(() => setLength((l) => l + 1), 32)
          : setTimeout(() => setPhase("generating"), 250);
    } else if (phase === "generating") {
      timer = setTimeout(() => setPhase("done"), 1400);
    } else if (phase === "done") {
      timer = setTimeout(() => setPhase("deleting"), 3600);
    } else {
      timer =
        length > 0
          ? setTimeout(() => setLength((l) => Math.max(0, l - 3)), 14)
          : setTimeout(() => {
              setIndex((i) => (i + 1) % PROMPTS.length);
              setPhase("typing");
            }, 200);
    }
    return () => clearTimeout(timer);
  }, [index, length, phase, reduced]);

  // With reduced motion, show a static, finished state.
  if (reduced) return { text: PROMPTS[0], index: 0, phase: "done" as Phase };
  return { text: PROMPTS[index].slice(0, length), index, phase };
}

export function HeroVisual() {
  // Only apply the reduced-motion state after mount so the first client render
  // matches the server HTML (avoids a hydration mismatch).
  const prefersReduced = useReducedMotion() ?? false;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const reduced = mounted && prefersReduced;
  const { text, index, phase } = usePromptCycle(reduced);

  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const rotateX = useSpring(useTransform(py, [-0.5, 0.5], [5, -5]), { stiffness: 120, damping: 20 });
  const rotateY = useSpring(useTransform(px, [-0.5, 0.5], [-7, 7]), { stiffness: 120, damping: 20 });

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (reduced || e.pointerType !== "mouse") return;
    const rect = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - rect.left) / rect.width - 0.5);
    py.set((e.clientY - rect.top) / rect.height - 0.5);
  }

  const showTiles = phase === "done" || phase === "deleting";

  return (
    <div
      aria-hidden
      className="relative mx-auto max-w-5xl [perspective:1800px]"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => {
        px.set(0);
        py.set(0);
      }}
    >
      {/* Glow beneath the panel */}
      <div className="pointer-events-none absolute -inset-x-10 top-10 -bottom-10 -z-10 rounded-[3rem] bg-[radial-gradient(closest-side,rgb(139_92_246/0.35),transparent)] blur-3xl" />

      <motion.div
        style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
        className="border-glow relative rounded-2xl shadow-[0_40px_120px_-30px_rgb(0_0_0/0.9)] sm:rounded-3xl"
      >
        {/* Window chrome */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
          <div className="hidden gap-1.5 sm:flex">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <div className="mx-auto flex gap-1 rounded-full bg-white/[0.04] p-1 text-[11px] sm:text-xs">
            {[
              { icon: ImageIcon, label: "Image", active: true },
              { icon: Video, label: "Video", active: false },
              { icon: Scissors, label: "Clipper", active: false },
            ].map(({ icon: Icon, label, active }) => (
              <span
                key={label}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 sm:px-3",
                  active ? "bg-white/10 text-foreground" : "text-muted",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </span>
            ))}
          </div>
          <div className="hidden w-[46px] sm:block" />
        </div>

        <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-[200px_1fr]">
          {/* Settings rail */}
          <div className="hidden flex-col gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 md:flex">
            <p className="flex items-center gap-2 text-xs font-medium text-foreground">
              <SlidersHorizontal className="size-3.5 text-violet-300" /> Settings
            </p>
            {[
              ["Aspect", "4 : 5"],
              ["Style", "Cinematic"],
              ["Quality", "High"],
              ["Variations", "4"],
            ].map(([k, v]) => (
              <div
                key={k}
                className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-xs"
              >
                <span className="text-muted">{k}</span>
                <span className="text-foreground">{v}</span>
              </div>
            ))}
            <div className="mt-auto rounded-lg bg-gradient-to-br from-violet/15 to-cyan/10 p-3 text-xs">
              <p className="text-muted">Credits</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-violet to-cyan" />
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {/* Prompt bar */}
            <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-black/30 p-2 pl-4">
              <WandSparkles className="size-4 shrink-0 text-fuchsia-300" />
              <p className="min-w-0 flex-1 truncate text-left text-xs text-foreground sm:text-sm">
                {text}
                <span className="caret ml-px inline-block h-4 w-px translate-y-0.5 bg-foreground" />
              </p>
              <span
                className={cn(
                  "relative shrink-0 overflow-hidden rounded-lg px-3 py-2 text-xs font-medium transition-colors duration-300",
                  phase === "generating" ? "shimmer bg-violet/30 text-violet-100" : "bg-white text-zinc-950",
                )}
              >
                {phase === "generating" ? "Generating…" : "Generate"}
              </span>
            </div>

            {/* Output grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {TILE_SETS[index].map((bg, i) => (
                <div
                  key={i}
                  className="relative aspect-[4/5] overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.03]"
                >
                  <AnimatePresence>
                    {showTiles ? (
                      <motion.div
                        key={`${index}-${i}`}
                        className="absolute inset-0"
                        style={{ background: bg }}
                        initial={{ opacity: 0, scale: 1.15, filter: "blur(16px)" }}
                        animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.9, delay: i * 0.12, ease: EASE_OUT }}
                      >
                        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/50 to-transparent" />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="placeholder"
                        className={cn("absolute inset-0", phase === "generating" && "shimmer")}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                      />
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>

      <FloatingCard className="top-1/3 -left-6 lg:-left-16" delay={1.4} floatOffset={-8}>
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-lg bg-fuchsia/20 text-fuchsia-300">
            <Video className="size-4" />
          </span>
          <div>
            <p className="text-xs font-medium text-foreground">Video render</p>
            <p className="text-[11px] text-muted">1080p · 8s clip</p>
          </div>
        </div>
        <div className="mt-3 h-1.5 w-44 overflow-hidden rounded-full bg-white/10">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-fuchsia to-violet"
            initial={{ width: "8%" }}
            animate={reduced ? { width: "100%" } : { width: ["8%", "100%"] }}
            transition={{ duration: 5, repeat: Infinity, repeatDelay: 1, ease: "easeInOut" }}
          />
        </div>
      </FloatingCard>

      <FloatingCard className="-right-4 -bottom-8 lg:-right-14" delay={1.6} floatOffset={8}>
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-lg bg-cyan/15 text-cyan-300">
            <Scissors className="size-4" />
          </span>
          <div>
            <p className="text-xs font-medium text-foreground">Highlights found</p>
            <p className="text-[11px] text-muted">3 clips ready to export</p>
          </div>
        </div>
        <div className="relative mt-3 flex h-6 w-52 items-end gap-[2px] overflow-hidden rounded-md bg-white/[0.04] px-1">
          {WAVE.map((h, i) => (
            <span
              key={i}
              className={cn(
                "flex-1 rounded-sm",
                HIGHLIGHTS.some(([a, b]) => i >= a && i <= b) ? "bg-cyan/80" : "bg-white/15",
              )}
              style={{ height: `${h}%` }}
            />
          ))}
          <motion.span
            className="absolute inset-y-0 w-px bg-white"
            animate={reduced ? { left: "50%" } : { left: ["2%", "98%"] }}
            transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
          />
        </div>
      </FloatingCard>
    </div>
  );
}

function FloatingCard({
  children,
  className,
  delay,
  floatOffset,
}: {
  children: React.ReactNode;
  className?: string;
  delay: number;
  floatOffset: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.8, delay, ease: EASE_OUT }}
      className={cn("absolute z-10 hidden sm:block", className)}
    >
      <motion.div
        animate={{ y: [0, floatOffset, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        className="rounded-2xl border border-white/10 bg-zinc-950/80 p-3.5 shadow-[0_20px_60px_-20px_rgb(0_0_0/0.9)] backdrop-blur-xl"
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
