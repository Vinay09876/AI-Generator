import { auth } from "@/lib/auth";
import { MotionProvider } from "@/components/ui/motion-provider";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";

export default async function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Server-verified session (the same check the dashboard uses), so a signed-in visitor sees
  // "Dashboard" instead of "Log in" and is never told they are signed out when they are not.
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);

  return (
    <MotionProvider>
      <Navbar signedIn={signedIn} />
      <main>{children}</main>
      <Footer signedIn={signedIn} />
    </MotionProvider>
  );
}
