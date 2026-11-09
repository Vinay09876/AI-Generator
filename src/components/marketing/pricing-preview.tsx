import { ArrowRight, Check } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Reveal } from "@/components/ui/reveal";
import { SectionHeading } from "@/components/ui/section-heading";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";

type Plan = {
  name: string;
  tagline: string;
  features: string[];
  cta: string;
  highlighted?: boolean;
};

// Placeholder plans: final pricing, credit amounts and limits are not decided yet.
const PLANS: Plan[] = [
  {
    name: "Starter",
    tagline: "For trying YourAI and personal projects.",
    features: ["Starter credit allowance", "AI Image Generator", "Standard-resolution exports", "Generation history"],
    cta: "Get started",
  },
  {
    name: "Pro",
    tagline: "For creators who publish regularly.",
    features: [
      "Larger monthly credit allowance",
      "Image, Video & Clipper tools",
      "High-resolution exports",
      "Priority generation queue",
    ],
    cta: "Get started",
    highlighted: true,
  },
  {
    name: "Studio",
    tagline: "For teams and agencies at scale.",
    features: ["Custom credit volume", "Everything in Pro", "Team workspace", "Dedicated support"],
    cta: "Contact us",
  },
];

export function PricingPreview() {
  return (
    <section id="pricing" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Pricing"
          title="Simple, credit-based plans"
          description="Start small and scale as you create more. Plan details and pricing will be announced at launch."
        />

        <div className="mt-16 grid items-stretch gap-5 lg:grid-cols-3">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.name} delay={i * 0.1} className="h-full">
              <PlanCard plan={plan} />
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.2}>
          <p className="mt-10 text-center text-xs text-muted">
            Plans shown are a preview. Features, credit allowances and prices may change before launch.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div
      className={cn(
        "group relative flex h-full flex-col rounded-3xl p-7 transition-transform duration-500 hover:-translate-y-1",
        plan.highlighted
          ? "border-glow shadow-[0_30px_80px_-30px_rgb(139_92_246/0.6)]"
          : "border border-white/[0.08] bg-surface hover:border-white/15",
      )}
    >
      {plan.highlighted && (
        <span className="absolute -top-3 left-7 rounded-full bg-gradient-to-r from-violet to-fuchsia px-3 py-1 text-[11px] font-medium text-white">
          Recommended
        </span>
      )}

      <h3 className="font-display text-xl font-semibold tracking-tight">{plan.name}</h3>
      <p className="mt-2 text-sm text-muted">{plan.tagline}</p>

      <div className="mt-6 flex items-baseline gap-2">
        <span className="font-display text-3xl font-semibold tracking-tight">Coming soon</span>
      </div>
      <p className="mt-1 text-xs text-muted">Pricing to be announced</p>

      <ul className="mt-7 flex-1 space-y-3 border-t border-white/[0.06] pt-7">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-foreground/90">
            <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-violet/20">
              <Check className="size-3 text-violet-200" strokeWidth={3} />
            </span>
            {f}
          </li>
        ))}
      </ul>

      <ButtonLink
        href={ROUTES.register}
        variant={plan.highlighted ? "primary" : "secondary"}
        className="mt-8 w-full"
      >
        {plan.cta}
        <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" />
      </ButtonLink>
    </div>
  );
}
