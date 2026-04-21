// Returns the same build-time version the client bundle was compiled with.
// Reading NEXT_PUBLIC_APP_VERSION (inlined at build time by next.config.ts)
// keeps client + server in lockstep even when Vercel/Turbo serves a cached
// build — both values come from the same compilation and can't drift.
//
// FORCE_APP_VERSION overrides it at runtime to force a client refresh.

export const dynamic = "force-dynamic";
export const runtime = "edge";

export function GET() {
  const version =
    process.env.FORCE_APP_VERSION ||
    process.env.NEXT_PUBLIC_APP_VERSION ||
    "dev";
  return Response.json(
    { version },
    {
      headers: {
        "cache-control": "no-store, max-age=0",
      },
    },
  );
}
