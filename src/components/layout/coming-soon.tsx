import { ArrowLeft } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { ROUTES } from "@/lib/constants";

/** Temporary placeholder for routes that are linked from the site but not built yet. */
export function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <main className="relative isolate flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_45%_at_50%_0%,rgb(139_92_246/0.25),transparent)]"
      />
      <Logo />
      <span className="mt-10 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-medium tracking-wide text-violet-200 uppercase">
        Coming soon
      </span>
      <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-4 max-w-md text-muted">{description}</p>
      <ButtonLink href={ROUTES.home} variant="secondary" className="mt-8">
        <ArrowLeft className="size-4" />
        Back to home
      </ButtonLink>
    </main>
  );
}
