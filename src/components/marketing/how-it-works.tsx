"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useSpring } from "motion/react";
import { Download, PenLine, WandSparkles, type LucideIcon } from "lucide-react";
import { SectionHeading } from "@/components/ui/section-heading";
import { EASE_OUT } from "@/lib/motion";

type Step = { icon: LucideIcon; title: string; description: string; detail: React.ReactNode };

const STEPS: Step[] = [
  {
    icon: PenLine,
    title: "Describe your idea",
    description: "Write a prompt or upload a long video. Pick the tool, style and format you need.",
    detail: (
      <div className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 font-mono text-[11px] text-muted">
        <span className="text-violet-300">prompt:</span> a cozy cabin in snowfall, warm light
      </div>
    ),
  },
  {
    icon: WandSparkles,
    title: "Generate with AI",
    description: "YourAI renders images, videos or highlight clips and shows the credit cost up front.",
    detail: <PulseSwatches />,
  },
  {
    icon: Download,
    title: "Refine & export",
    description: "Iterate on the best result, then download or revisit it anytime from your history.",
    detail: (
      <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 text-[11px]">
        <span className="text-muted">final_render.mp4</span>
        <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-emerald-300">Ready</span>
      </div>
    ),
  },
];

function PulseSwatches() {
  const reduce = useReducedMotion();
  return (
    <div className="flex gap-1.5">
      {["#7c3aed", "#c026d3", "#0891b2"].map((c, i) => (
        <motion.span
          key={c}
          className="h-8 flex-1 rounded-md"
          style={{ background: c }}
          animate={reduce ? undefined : { opacity: [0.35, 1, 0.35] }}
          transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.4, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

export function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 75%", "end 55%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 90, damping: 24 });

  return (
    <section id="how-it-works" className="relative py-24 sm:py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 -z-10 h-[30rem] -translate-y-1/2 bg-[radial-gradient(ellipse_50%_50%_at_50%_50%,rgb(139_92_246/0.08),transparent)]"
      />
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="How it works"
          title="From prompt to publish in three steps"
          description="A simple flow that stays the same whether you are making an image, a video or a clip."
        />

        <div ref={ref} className="relative mt-16">
          {/* Progress rail: horizontal on desktop, vertical on mobile */}
          <div className="absolute top-6 right-[16.66%] left-[16.66%] hidden h-px bg-white/[0.08] md:block">
            <motion.div
              style={{ scaleX: progress }}
              className="h-full origin-left bg-gradient-to-r from-violet via-fuchsia to-cyan"
            />
          </div>
          <div className="absolute top-6 bottom-6 left-6 w-px bg-white/[0.08] md:hidden">
            <motion.div
              style={{ scaleY: progress }}
              className="h-full origin-top bg-gradient-to-b from-violet via-fuchsia to-cyan"
            />
          </div>

          <ol className="grid gap-10 md:grid-cols-3 md:gap-6">
            {STEPS.map((step, i) => (
              <motion.li
                key={step.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.8, delay: i * 0.15, ease: EASE_OUT }}
                className="relative flex gap-5 md:flex-col md:items-center md:text-center"
              >
                <div className="relative z-10 grid size-12 shrink-0 place-items-center rounded-2xl border border-white/10 bg-surface-2 shadow-[0_0_30px_-6px_rgb(139_92_246/0.6)]">
                  <step.icon className="size-5 text-violet-200" />
                  <span className="absolute -top-2 -right-2 grid size-5 place-items-center rounded-full bg-gradient-to-br from-violet to-fuchsia text-[10px] font-semibold text-white">
                    {i + 1}
                  </span>
                </div>
                <div className="min-w-0 flex-1 md:mt-6">
                  <h3 className="font-display text-lg font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted md:mx-auto md:max-w-xs">
                    {step.description}
                  </p>
                  <div className="mt-5 rounded-2xl border border-white/[0.06] bg-surface p-3 text-left md:mx-auto md:max-w-xs">
                    {step.detail}
                  </div>
                </div>
              </motion.li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
