async function handler(req: Request) {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    return Response.json(
      { error: "API_URL is not configured on the docs deployment" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const targetUrl = `${apiUrl}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.set("host", new URL(apiUrl).host);
  if (process.env.INTERNAL_API_TOKEN) {
    headers.set("x-internal-api-token", process.env.INTERNAL_API_TOKEN);
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
