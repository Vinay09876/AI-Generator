import { CheckCircle2, CircleDashed, ImageIcon, Loader2, Scissors, Video, XCircle, Ban, type LucideIcon } from "lucide-react";
import type { GenerationStatus, GenerationType } from "@/generated/prisma/client";
import { ROUTES } from "@/lib/constants";

export const GENERATION_TYPE_META: Record<
  GenerationType,
  { label: string; plural: string; short: string; icon: LucideIcon; href: string; iconClass: string; filter: string }
> = {
  IMAGE: {
    label: "AI Image",
    plural: "Images",
    short: "Image",
    icon: ImageIcon,
    href: ROUTES.aiImage,
    iconClass: "bg-violet/15 text-violet-300",
    filter: "image",
  },
  VIDEO: {
    label: "AI Video",
    plural: "Videos",
    short: "Video",
    icon: Video,
    href: ROUTES.aiVideo,
    iconClass: "bg-fuchsia/15 text-fuchsia-300",
    filter: "video",
  },
  VIDEO_CLIP: {
    label: "Video Clip",
    plural: "Clips",
    short: "Clip",
    icon: Scissors,
    href: ROUTES.videoClipper,
    iconClass: "bg-cyan/15 text-cyan-300",
    filter: "clip",
  },
};

/** URL filter value -> enum. Unknown values are ignored (treated as "all"). */
export function parseTypeFilter(value: unknown): GenerationType | undefined {
  const entry = Object.entries(GENERATION_TYPE_META).find(([, m]) => m.filter === value);
  return entry?.[0] as GenerationType | undefined;
}

/** Status is always shown as icon + label, never colour alone. */
export const GENERATION_STATUS_META: Record<
  GenerationStatus,
  { label: string; icon: LucideIcon; className: string; spin?: boolean }
> = {
  PENDING: { label: "Queued", icon: CircleDashed, className: "border-white/10 bg-white/[0.04] text-muted" },
  PROCESSING: {
    label: "Processing",
    icon: Loader2,
    className: "border-sky-400/25 bg-sky-400/10 text-sky-200",
    spin: true,
  },
  COMPLETED: { label: "Completed", icon: CheckCircle2, className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200" },
  FAILED: { label: "Failed", icon: XCircle, className: "border-rose-400/25 bg-rose-400/10 text-rose-200" },
  CANCELLED: { label: "Cancelled", icon: Ban, className: "border-white/10 bg-white/[0.03] text-muted" },
};
