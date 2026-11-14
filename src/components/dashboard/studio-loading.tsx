import { StudioNav } from "./studio-nav";

/**
 * Route-level loading UI for the three studio tools (AI Image, AI Video, Video Clipper).
 * Renders the real StudioNav (already highlighting the destination tab) above a skeleton of the
 * header and the prompt/preview panels, so switching tools gives immediate visual feedback.
 */
export function StudioLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} className="space-y-6">
      <StudioNav className="mb-6" />
      <div className="space-y-3 pb-2">
        <div className="shimmer h-9 w-72 max-w-full rounded-lg bg-white/[0.06]" />
        <div className="shimmer h-4 w-96 max-w-full rounded-md bg-white/[0.04]" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="shimmer h-80 rounded-3xl border border-white/[0.06] bg-white/[0.03]" />
        <div className="shimmer h-80 rounded-3xl border border-white/[0.06] bg-white/[0.03]" />
      </div>
      <span className="sr-only">Loading {label}…</span>
    </div>
  );
}
