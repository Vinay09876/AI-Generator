"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowUpRight, Check, ImageIcon, Play, Scissors, Video, type LucideIcon } from "lucide-react";
import { SectionHeading } from "@/components/ui/section-heading";
import { ROUTES } from "@/lib/constants";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Feature = {
  icon: LucideIcon;
  title: string;
  description: string;
  points: string[];
  href: string;
  /** RGB triplet used for the cursor spotlight and accents. */
  glow: string;
  iconClass: string;
  visual: React.ReactNode;
};

const FEATURES: Feature[] = [
  {
    icon: ImageIcon,
    title: "AI Image Generator",
    description:
      "Turn a written idea into polished visuals. Explore styles, aspect ratios and variations until it looks exactly right.",
    points: ["Multiple styles & aspect ratios", "Generate variations side by side", "Download in high resolution"],
    href: ROUTES.aiImage,
    glow: "167 139 250",
    iconClass: "bg-violet/15 text-violet-300",
    visual: <ImageVisual />,
  },
  {
    icon: Video,
    title: "AI Video Generator",
    description:
      "Bring scenes to life with short AI-generated videos. Describe the motion, mood and camera, and let YourAI render it.",
    points: ["Text-to-video from a prompt", "Control duration & framing", "Export for social and web"],
    href: ROUTES.aiVideo,
    glow: "232 121 249",
    iconClass: "bg-fuchsia/15 text-fuchsia-300",
    visual: <VideoVisual />,
  },
  {
    icon: Scissors,
    title: "AI Video Clipper",
    description:
      "Upload long-form content and get short, shareable highlights. Perfect for podcasts, streams, webinars and interviews.",
    points: ["Automatic highlight detection", "Vertical-ready short clips", "Trim and fine-tune before export"],
    href: ROUTES.videoClipper,
    glow: "34 211 238",
    iconClass: "bg-cyan/15 text-cyan-300",
    visual: <ClipperVisual />,
  },
];

export function Features() {
  return (
    <section id="features" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Three tools, one studio"
          title={
            <>
              Everything you need to <span className="text-gradient">create with AI</span>
            </>
          }
          description="Generate images, produce videos and repurpose long recordings without switching between apps. All three tools are in active development."
        />

        <div className="mt-16 grid gap-5 md:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <FeatureCard key={feature.title} feature={feature} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ feature, index }: { feature: Feature; index: number }) {
  const { icon: Icon } = feature;

  function handleMove(e: React.MouseEvent<HTMLElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--x", `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty("--y", `${e.clientY - rect.top}px`);
  }

  return (
    <motion.article
      initial={{ opacity: 0, y: 40, rotateX: 8 }}
      whileInView={{ opacity: 1, y: 0, rotateX: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.9, delay: index * 0.12, ease: EASE_OUT }}
      whileHover={{ y: -6 }}
      onMouseMove={handleMove}
      style={{ transformPerspective: 1000 }}
      className="group relative flex flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-surface p-6 transition-colors duration-500 hover:border-white/15 sm:p-7"
    >
      {/* Cursor spotlight */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        style={{
          background: `radial-gradient(420px circle at var(--x, 50%) var(--y, 50%), rgb(${feature.glow} / 0.14), transparent 60%)`,
        }}
      />

      <div className="relative h-40 overflow-hidden rounded-2xl border border-white/[0.06] bg-black/30">
        {feature.visual}
      </div>

      <div className="relative mt-6 flex items-center gap-3">
        <span
          className={cn(
            "grid size-10 place-items-center rounded-xl transition-transform duration-500 group-hover:scale-110 group-hover:-rotate-6",
            feature.iconClass,
          )}
        >
          <Icon className="size-5" />
        </span>
        <h3 className="font-display text-xl font-semibold tracking-tight">{feature.title}</h3>
      </div>

      <p className="relative mt-4 text-sm leading-relaxed text-muted">{feature.description}</p>

      <ul className="relative mt-5 space-y-2.5">
        {feature.points.map((p) => (
          <li key={p} className="flex items-center gap-2.5 text-sm text-foreground/90">
            <Check className="size-4 shrink-0 text-violet-300" />
            {p}
          </li>
        ))}
      </ul>

      <Link
        href={feature.href}
        className="relative mt-7 inline-flex items-center gap-1.5 self-start text-sm font-medium text-foreground after:absolute after:inset-0 after:content-['']"
      >
        Preview {feature.title.replace("AI ", "")}
        <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </Link>
    </motion.article>
  );
}

/* ---------- Mini visuals ---------- */

function ImageVisual() {
  const tiles = [
    "linear-gradient(150deg,#4c1d95,#be185d)",
    "linear-gradient(200deg,#0e7490,#312e81)",
    "linear-gradient(160deg,#a21caf,#1e1b4b)",
    "linear-gradient(120deg,#6d28d9,#0891b2)",
  ];
  return (
    <div className="grid h-full grid-cols-4 gap-2 p-3">
      {tiles.map((bg, i) => (
        <div
          key={i}
          className={cn(
            "rounded-lg transition-transform duration-700 ease-out group-hover:scale-[1.04]",
            i % 2 === 0 ? "group-hover:-translate-y-1.5" : "group-hover:translate-y-1.5",
          )}
          style={{ background: bg, transitionDelay: `${i * 50}ms` }}
        />
      ))}
    </div>
  );
}

function VideoVisual() {
  return (
    <div className="relative flex h-full flex-col justify-between p-3">
      <div className="relative flex-1 overflow-hidden rounded-lg bg-[linear-gradient(135deg,#701a75,#1e1b4b_60%,#0c4a6e)]">
        <div className="absolute inset-0 grid place-items-center">
          <span className="grid size-10 place-items-center rounded-full bg-white/15 backdrop-blur transition-transform duration-500 group-hover:scale-110">
            <Play className="ml-0.5 size-4 fill-white text-white" />
          </span>
        </div>
      </div>
      <div className="mt-2 flex gap-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-5 flex-1 rounded-sm bg-white/10 transition-colors duration-300 group-hover:bg-fuchsia/40"
            style={{ transitionDelay: `${i * 60}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

const CLIP_WAVE = [35, 60, 45, 80, 95, 70, 40, 30, 55, 75, 90, 65, 45, 35, 60, 85, 100, 70, 50, 40, 30, 55, 70, 45];

function ClipperVisual() {
  return (
    <div className="relative flex h-full items-center px-4">
      <div className="relative flex h-16 w-full items-center gap-[3px]">
        {CLIP_WAVE.map((h, i) => (
          <span
            key={i}
            className={cn(
              "flex-1 rounded-full transition-colors duration-500",
              (i >= 3 && i <= 6) || (i >= 14 && i <= 18) ? "bg-cyan/70 group-hover:bg-cyan" : "bg-white/15",
            )}
            style={{ height: `${h}%` }}
          />
        ))}
        <span className="absolute inset-y-[-6px] left-[12%] w-[17%] rounded-md border border-cyan/60 bg-cyan/5 transition-transform duration-500 group-hover:-translate-y-0.5" />
        <span className="absolute inset-y-[-6px] left-[58%] w-[21%] rounded-md border border-cyan/60 bg-cyan/5 transition-transform duration-500 group-hover:-translate-y-0.5" />
      </div>
    </div>
  );
}
