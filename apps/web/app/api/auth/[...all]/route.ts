const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

async function handler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname; // e.g. /api/auth/sign-in/email
  const targetUrl = `${API_URL}${path}${url.search}`;

  const headers = new Headers(req.headers);
  headers.set("host", new URL(API_URL).host);

  const res = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : undefined,
  });

  const responseHeaders = new Headers(res.headers);
  // Remove hop-by-hop headers
  responseHeaders.delete("transfer-encoding");

  return new Response(res.body, {
    status: res.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
