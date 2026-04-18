export const runtime = "edge";

if (!process.env.API_URL) {
  throw new Error(
    "API_URL environment variable is required for the app proxy. Set it in Vercel for Production and Preview environments.",
  );
}

const API_URL: string = process.env.API_URL;
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

async function handler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname; // e.g. /api/app/dashboard
  const targetUrl = `${API_URL}${path}${url.search}`;

  const headers = new Headers(req.headers);
  headers.set("host", new URL(API_URL).host);
  if (INTERNAL_API_TOKEN) {
    headers.set("x-internal-api-token", INTERNAL_API_TOKEN);
  }

  const res = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : undefined,
  });

  const responseHeaders = new Headers(res.headers);
  responseHeaders.delete("transfer-encoding");

  return new Response(res.body, {
    status: res.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
