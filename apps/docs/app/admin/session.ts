import { headers as nextHeaders } from "next/headers";

export const ADMIN_EMAIL = "santhoshnarayan@gmail.com";

type SessionUser = {
  id: string;
  email: string;
  name?: string;
};

type SessionResponse = {
  user?: SessionUser;
  session?: { id: string };
};

export async function getAdminSession(): Promise<SessionResponse | null> {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) return null;

  const incoming = await nextHeaders();
  const cookie = incoming.get("cookie") ?? "";
  if (!cookie) return null;

  const forwarded = new Headers();
  forwarded.set("cookie", cookie);
  if (process.env.INTERNAL_API_TOKEN) {
    forwarded.set("x-internal-api-token", process.env.INTERNAL_API_TOKEN);
  }

  try {
    const res = await fetch(`${apiUrl}/api/auth/get-session`, {
      headers: forwarded,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as SessionResponse | null;
    return body ?? null;
  } catch {
    return null;
  }
}

export function isAdmin(session: SessionResponse | null): boolean {
  return session?.user?.email?.toLowerCase() === ADMIN_EMAIL;
}
