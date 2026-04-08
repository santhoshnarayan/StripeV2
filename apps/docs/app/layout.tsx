import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "StripeV2 Docs",
  description: "Documentation for StripeV2",
};

const navLinks = [
  { href: "/docs/getting-started", label: "Getting Started" },
  { href: "/docs/architecture", label: "Architecture" },
  { href: "/docs/auth", label: "Auth" },
  { href: "/docs/graphql", label: "GraphQL" },
  { href: "/docs/cron-jobs", label: "Cron Jobs" },
  { href: "/docs/background-tasks", label: "Background Tasks" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased bg-white text-gray-900">
        <div className="flex min-h-screen">
          <nav className="w-60 shrink-0 border-r border-gray-200 px-4 py-8">
            <Link href="/" className="text-lg font-bold tracking-tight">
              StripeV2 Docs
            </Link>
            <ul className="mt-6 space-y-1">
              {navLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="block rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <main className="flex-1 max-w-3xl px-8 py-8 prose prose-gray">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
