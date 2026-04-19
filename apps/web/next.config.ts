import type { NextConfig } from "next";

// Build-time app version. On Vercel this is the git commit SHA for the deploy;
// locally we fall back to "dev" so the refresh banner never fires during dev.
const APP_VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
  process.env.APP_VERSION ||
  "dev";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/validators", "@repo/sim", "@repo/sim-engine-wasm"],
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
};

export default nextConfig;
