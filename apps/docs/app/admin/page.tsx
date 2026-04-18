import { redirect } from "next/navigation";
import { getAdminSession, isAdmin } from "./session";

export const dynamic = "force-dynamic";

export default async function AdminIndexPage() {
  const session = await getAdminSession();
  redirect(isAdmin(session) ? "/admin/database" : "/admin/sign-in");
}
