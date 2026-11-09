import { ArrowLeft, type LucideIcon } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";

/** In-dashboard placeholder for tools that are not implemented yet. */
export function ToolPlaceholder({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-white/[0.08] bg-surface px-6 py-16 text-center sm:py-24">
      <span className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-violet/25 to-cyan/15 text-violet-200">
        <Icon className="size-6" />
      </span>
      <span className="mt-6 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-medium tracking-wide text-violet-200 uppercase">
        Coming soon
      </span>
      <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 max-w-md text-muted">{description}</p>
      <ButtonLink href={ROUTES.dashboard} variant="secondary" className="mt-8">
        <ArrowLeft className="size-4" />
        Back to dashboard
      </ButtonLink>
    </div>
  );
}
