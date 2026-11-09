"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";
import { ArrowRight, Sparkles } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";
import { EASE_OUT } from "@/lib/motion";
import { HeroVisual } from "./hero-visual";

const LINES: { words: string[]; gradient?: boolean }[] = [
  { words: ["Create", "stunning", "images,"] },
  { words: ["videos", "and", "clips"], gradient: true },
  { words: ["from", "a", "single", "prompt."] },
];

const word: Variants = {
  hidden: { y: "110%", rotate: 4 },
  show: (i: number) => ({
    y: "0%",
    rotate: 0,
    transition: { duration: 0.9, delay: 0.15 + i * 0.06, ease: EASE_OUT },
  }),
};

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.8, delay, ease: EASE_OUT },
  }),
};

export function Hero() {
  let wordIndex = 0;

  return (
    <section className="relative isolate overflow-hidden pt-32 pb-20 sm:pt-40 md:pb-28">
      <HeroBackdrop />

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <motion.div initial="hidden" animate="show" className="mx-auto max-w-4xl text-center">
          <motion.a
            href="#features"
            variants={fadeUp}
            custom={0}
            className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pr-3 pl-1 text-xs text-muted backdrop-blur transition-colors hover:border-white/20 hover:text-foreground sm:text-sm"
          >
            <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-violet to-fuchsia px-2 py-0.5 text-xs font-medium text-white">
              <Sparkles className="size-3" /> Early access
            </span>
            Image, video &amp; clipping in one studio
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </motion.a>

          <h1 className="mt-7 font-display text-[2.6rem] leading-[1.05] font-semibold tracking-tight sm:text-6xl md:text-7xl">
            {LINES.map((line, li) => (
              <span key={li} className="block">
                {line.words.map((w) => {
                  const i = wordIndex++;
                  return (
                    <span key={w + i} className="inline-block overflow-hidden pb-[0.12em] align-bottom">
                      <motion.span
                        variants={word}
                        custom={i}
                        className={`inline-block origin-bottom-left ${line.gradient ? "text-gradient" : ""}`}
                      >
                        {w}
                      </motion.span>
                      {" "}
                    </span>
                  );
                })}
              </span>
            ))}
          </h1>

          <motion.p
            variants={fadeUp}
            custom={0.75}
            className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-pretty text-muted sm:text-lg"
          >
            YourAI brings AI image generation, AI video generation and smart video clipping into one
            focused workspace. Describe your idea, iterate quickly, and export content that is ready to
            publish.
          </motion.p>

          <motion.div
            variants={fadeUp}
            custom={0.9}
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <ButtonLink href={ROUTES.register} size="lg" className="w-full sm:w-auto">
              Get early access
              <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
            </ButtonLink>
            <ButtonLink href="#how-it-works" variant="secondary" size="lg" className="w-full sm:w-auto">
              See how it works
            </ButtonLink>
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 60, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 1.2, delay: 0.7, ease: EASE_OUT }}
          className="mt-16 sm:mt-20"
        >
          <HeroVisual />
        </motion.div>
      </div>
    </section>
  );
}

function HeroBackdrop() {
  const reduce = useReducedMotion();
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,black,transparent)]" />
      <motion.div
        className="absolute top-[-18rem] left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(139_92_246/0.35),transparent)] blur-2xl"
        animate={reduce ? undefined : { opacity: [0.7, 1, 0.7], scale: [1, 1.05, 1] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute top-40 -left-40 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(closest-side,rgb(217_70_239/0.18),transparent)] blur-2xl"
        animate={reduce ? undefined : { x: [0, 40, 0], y: [0, 20, 0] }}
        transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute top-72 -right-40 h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(closest-side,rgb(34_211_238/0.14),transparent)] blur-2xl"
        animate={reduce ? undefined : { x: [0, -40, 0], y: [0, -24, 0] }}
        transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}
