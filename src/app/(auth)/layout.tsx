import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { DEFAULT_LOGIN_REDIRECT, ROUTES } from "@/lib/constants";
import { Logo } from "@/components/ui/logo";

export default async function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  if (session?.user) redirect(DEFAULT_LOGIN_REDIRECT);

  return (
    <div className="relative isolate flex min-h-dvh flex-col">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]" />
        <div className="absolute top-[-14rem] left-1/2 h-[30rem] w-[50rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(139_92_246/0.3),transparent)] blur-2xl" />
        <div className="absolute -bottom-40 -left-40 h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(closest-side,rgb(217_70_239/0.12),transparent)] blur-2xl" />
        <div className="absolute -right-40 -bottom-40 h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(closest-side,rgb(34_211_238/0.1),transparent)] blur-2xl" />
      </div>

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <Link
          href={ROUTES.home}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-muted transition-colors hover:bg-white/[0.05] hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to home
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pt-6 pb-16 sm:px-6">{children}</main>
    </div>
  );
}
