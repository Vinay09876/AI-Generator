import Link from "next/link";

type AuthCardProps = {
  title: string;
  description: string;
  children: React.ReactNode;
  footer: { text: string; linkLabel: string; href: string };
};

export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <div className="w-full max-w-md">
      <div className="rounded-3xl border border-white/[0.08] bg-surface/80 p-6 shadow-[0_40px_120px_-30px_rgb(0_0_0/0.9)] backdrop-blur-xl sm:p-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
        <div className="mt-8">{children}</div>
      </div>
      <p className="mt-6 text-center text-sm text-muted">
        {footer.text}{" "}
        <Link href={footer.href} className="font-medium text-foreground underline-offset-4 hover:underline">
          {footer.linkLabel}
        </Link>
      </p>
    </div>
  );
}
