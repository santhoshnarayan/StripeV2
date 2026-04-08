import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/validators"],
};

export default nextConfig;
