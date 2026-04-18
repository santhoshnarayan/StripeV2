import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Player Pool Docs",
  description: "Documentation for the Player Pool NBA Playoffs app",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased bg-white text-gray-900">
        {children}
      </body>
    </html>
  );
}
