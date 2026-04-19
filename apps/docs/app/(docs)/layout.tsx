import Link from "next/link";

const navLinks = [
  { href: "/docs/getting-started", label: "Getting Started" },
  { href: "/docs/architecture", label: "Architecture" },
  { href: "/docs/game-flow", label: "Game Flow" },
  { href: "/docs/draft-room", label: "Draft Room" },
  { href: "/docs/simulator", label: "Simulator" },
  { href: "/docs/deployments", label: "Deployments" },
  { href: "/docs/auth", label: "Auth" },
  { href: "/docs/graphql", label: "GraphQL" },
  { href: "/docs/cron-jobs", label: "Cron Jobs" },
  { href: "/docs/background-tasks", label: "Background Tasks" },
];

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <nav className="w-60 shrink-0 border-r border-gray-200 px-4 py-8">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Player Pool Docs
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
        <div className="mt-6 border-t border-gray-200 pt-4">
          <Link
            href="/admin"
            className="block rounded-md px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            Admin sign in →
          </Link>
        </div>
      </nav>
      <main className="flex-1 max-w-3xl px-8 py-8 prose prose-gray">
        {children}
      </main>
    </div>
  );
}
