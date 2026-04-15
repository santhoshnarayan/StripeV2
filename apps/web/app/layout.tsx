import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { AppNav } from "@/components/app-nav";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Player Pool",
  description: "NBA Playoffs player pool leagues",
  applicationName: "Player Pool",
  appleWebApp: {
    capable: true,
    title: "Player Pool",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex min-h-screen flex-col bg-[radial-gradient(circle_at_top_left,rgba(15,23,42,0.08),transparent_28%),linear-gradient(180deg,rgba(255,255,255,1),rgba(248,250,252,1))]">
          <AppNav />
          <div className="flex-1 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] md:pb-0">
            {children}
          </div>
        </div>
        <Toaster />
      </body>
    </html>
  );
}
