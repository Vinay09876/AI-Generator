import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Generator",
  description: "Generate AI images and videos",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
