import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminSession, isAdmin } from "../session";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

export default async function ProtectedAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAdminSession();
  if (!isAdmin(session)) {
    redirect("/admin/sign-in");
  }

  return (
    <div>
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="flex items-center justify-between px-4 py-2 max-w-7xl mx-auto">
          <div className="flex items-center gap-4">
            <Link href="/admin/database" className="text-sm font-semibold tracking-tight">
              Player Pool Admin
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/admin/database"
                className="rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              >
                Database
              </Link>
              <Link
                href="/admin/logs"
                className="rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              >
                Logs
              </Link>
              <Link
                href="/admin/usage"
                className="rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              >
                Usage
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{session?.user?.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-4">{children}</main>
    </div>
  );
}
