import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import { InteractiveBackground } from "@/components/InteractiveBackground";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jeeva",
  description: "Jev-driven Hyperliquid perp trading dashboard",
};

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  display: "swap",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${montserrat.variable} h-full`}>
      <body className="min-h-full font-sans antialiased">
        <InteractiveBackground />
        <div className="relative z-10 min-h-full">{children}</div>
      </body>
    </html>
  );
}
