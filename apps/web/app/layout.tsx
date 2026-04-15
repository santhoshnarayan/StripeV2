import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { AppNav } from "@/components/app-nav";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/lib/theme";
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
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
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
    <html lang="en" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <head>
        <script
          // Avoid dark-mode flash: apply the stored theme before React hydrates.
          dangerouslySetInnerHTML={{
            __html: `(() => { try { const s = localStorage.getItem('player-pool:theme'); const p = s === 'light' || s === 'dark' ? s : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); document.documentElement.classList.add(p); document.documentElement.style.colorScheme = p; } catch (e) {} })();`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ThemeProvider>
          <div className="flex min-h-screen flex-col bg-[radial-gradient(circle_at_top_left,_color-mix(in_oklch,_var(--foreground)_8%,_transparent),_transparent_28%),linear-gradient(180deg,_var(--background),_color-mix(in_oklch,_var(--background)_92%,_var(--muted)))]">
            <AppNav />
            <div className="flex-1 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] md:pb-0">
              {children}
            </div>
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
