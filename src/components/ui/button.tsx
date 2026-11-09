import Link from "next/link";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-white text-zinc-950 shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_30px_-6px_rgb(139_92_246/0.55)] hover:shadow-[0_0_0_1px_rgb(255_255_255/0.2),0_10px_40px_-4px_rgb(217_70_239/0.6)]",
  secondary:
    "bg-white/[0.04] text-foreground ring-1 ring-inset ring-white/10 backdrop-blur hover:bg-white/[0.08] hover:ring-white/20",
  ghost: "text-muted hover:text-foreground hover:bg-white/[0.05]",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

type ButtonLinkProps = React.ComponentProps<typeof Link> & {
  variant?: Variant;
  size?: Size;
};

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      className={cn(
        "group relative inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap",
        "transition-[background-color,box-shadow,color,transform] duration-300 active:scale-[0.97]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </Link>
  );
}
