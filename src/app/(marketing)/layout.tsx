import { MotionProvider } from "@/components/ui/motion-provider";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <MotionProvider>
      <Navbar />
      <main>{children}</main>
      <Footer />
    </MotionProvider>
  );
}
