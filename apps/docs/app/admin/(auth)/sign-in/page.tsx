import { redirect } from "next/navigation";
import { getAdminSession, isAdmin } from "../../session";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export default async function AdminSignInPage() {
  const session = await getAdminSession();
  if (isAdmin(session)) {
    redirect("/admin/database");
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <section className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.16em] text-gray-500">Admin</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sign In</h1>
        <p className="mt-2 text-sm text-gray-600">
          Admin access is restricted. Only the account owner can continue.
        </p>
        <SignInForm />
      </section>
    </div>
  );
}
