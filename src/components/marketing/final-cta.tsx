"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Sparkles } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";
import { EASE_OUT } from "@/lib/motion";

export function FinalCta() {
  const reduce = useReducedMotion();
  return (
    <section className="relative px-4 pt-8 pb-24 sm:px-6 sm:pb-32">
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 40 }}
        whileInView={{ opacity: 1, scale: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 1, ease: EASE_OUT }}
        className="border-glow relative mx-auto max-w-5xl overflow-hidden rounded-[2rem] px-6 py-16 text-center sm:px-12 sm:py-20"
      >
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_60%_70%_at_50%_100%,black,transparent)]" />
          <motion.div
            className="absolute -bottom-40 left-1/2 h-80 w-[44rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(168_85_247/0.45),transparent)] blur-2xl"
            animate={reduce ? undefined : { opacity: [0.6, 1, 0.6] }}
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>

        <div className="relative">
          <motion.span
            initial={{ rotate: -20, scale: 0.6, opacity: 0 }}
            whileInView={{ rotate: 0, scale: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ type: "spring", stiffness: 200, damping: 14, delay: 0.3 }}
            className="mx-auto grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-violet via-fuchsia to-cyan shadow-[0_0_40px_-6px_rgb(217_70_239/0.8)]"
          >
            <Sparkles className="size-5 text-white" />
          </motion.span>
          <h2 className="mx-auto mt-7 max-w-2xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            Your next idea deserves to be seen
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Create images, videos and highlight clips in one place. Create your account to get access as each
            tool launches.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href={ROUTES.register} size="lg" className="w-full sm:w-auto">
              Create your account
              <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
            </ButtonLink>
            <ButtonLink href={ROUTES.login} variant="secondary" size="lg" className="w-full sm:w-auto">
              Log in
            </ButtonLink>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
