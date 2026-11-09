import { Coins, Download, History, Layers, SlidersHorizontal, Zap, type LucideIcon } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";
import { SectionHeading } from "@/components/ui/section-heading";
import { cn } from "@/lib/utils";

type Benefit = {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
  visual?: React.ReactNode;
};

const BENEFITS: Benefit[] = [
  {
    icon: Coins,
    title: "One credit balance for everything",
    description:
      "Images, videos and clips all draw from a single balance, and every generation shows its cost before you run it.",
    className: "md:col-span-2",
    visual: <CreditsVisual />,
  },
  {
    icon: History,
    title: "Complete generation history",
    description: "Every prompt, setting and output is saved, so you can revisit, download or remix past work.",
  },
  {
    icon: SlidersHorizontal,
    title: "Precise creative control",
    description: "Tune style, aspect ratio, duration and quality instead of settling for a single default output.",
  },
  {
    icon: Zap,
    title: "Fast iteration",
    description: "Re-run prompts and generate variations without losing context or starting over.",
  },
  {
    icon: Download,
    title: "Publish-ready exports",
    description: "Download in formats sized for social feeds, websites and presentations.",
  },
  {
    icon: Layers,
    title: "One focused workspace",
    description:
      "No juggling separate subscriptions and tools. Create images, videos and short clips side by side in a single dashboard.",
    className: "md:col-span-2 lg:col-span-1",
  },
];

export function Benefits() {
  return (
    <section id="benefits" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Why YourAI"
          title={
            <>
              Built for creators who <span className="text-gradient">ship often</span>
            </>
          }
          description="Thoughtful details we are building in to keep your creative flow fast, organised and predictable."
        />

        <div className="mt-16 grid gap-4 md:grid-cols-3">
          {BENEFITS.map((b, i) => (
            <Reveal key={b.title} delay={(i % 3) * 0.08} className={b.className}>
              <BenefitCard benefit={b} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function BenefitCard({ benefit }: { benefit: Benefit }) {
  const { icon: Icon } = benefit;
  return (
    <div
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-surface p-6 transition-[border-color,transform] duration-500 hover:-translate-y-1 hover:border-white/15 sm:p-7",
        benefit.visual && "md:flex-row md:items-center md:gap-8",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 size-56 rounded-full bg-violet/10 opacity-0 blur-3xl transition-opacity duration-700 group-hover:opacity-100"
      />
      <div className="relative flex-1">
        <span className="grid size-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-violet-200 transition-[transform,background-color] duration-500 group-hover:-rotate-6 group-hover:bg-violet/15">
          <Icon className="size-5" />
        </span>
        <h3 className="mt-5 font-display text-lg font-semibold tracking-tight">{benefit.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{benefit.description}</p>
      </div>
      {benefit.visual && <div className="relative mt-6 md:mt-0 md:w-[45%]">{benefit.visual}</div>}
    </div>
  );
}

function CreditsVisual() {
  const rows = [
    { label: "Image", width: "w-[38%]", color: "from-violet to-violet-400" },
    { label: "Video", width: "w-[72%]", color: "from-fuchsia to-pink-400" },
    { label: "Clipper", width: "w-[54%]", color: "from-cyan to-sky-400" },
  ];
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-black/30 p-4">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">Credit usage</span>
        <span className="text-foreground">This month</span>
      </div>
      <div className="mt-4 space-y-3">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[56px_1fr] items-center gap-3 text-xs">
            <span className="text-muted">{r.label}</span>
            <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={cn(
                  "h-full origin-left scale-x-90 rounded-full bg-gradient-to-r transition-transform duration-700 ease-out group-hover:scale-x-100",
                  r.width,
                  r.color,
                )}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
