import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../"),
  // Allow long-running API requests (LLM generation pipelines can take 2+ minutes)
  experimental: {
    proxyTimeout: 660_000, // 11 minutes in ms — must exceed backend safety-net (600 s)
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8000/:path*",
      },
    ];
  },
};

export default nextConfig;
