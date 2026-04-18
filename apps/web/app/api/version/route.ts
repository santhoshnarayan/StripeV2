// Runtime version endpoint. Returns the commit SHA of the current Vercel
// deployment. Compared against the build-time NEXT_PUBLIC_APP_VERSION baked
// into the client bundle so the client can detect a stale bundle.
//
// FORCE_APP_VERSION overrides the auto-detected version — bump it in Vercel
// env vars to force every client to refresh without a new deployment.

export const dynamic = "force-dynamic";
export const runtime = "edge";

export function GET() {
  const version =
    process.env.FORCE_APP_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
    process.env.APP_VERSION ||
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
