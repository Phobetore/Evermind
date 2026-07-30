import type { NextConfig } from "next";

const BACKEND = process.env.EVERMIND_BACKEND_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND}/api/:path*` }];
  },
  // Long-running SSE generations must survive the dev proxy.
  httpAgentOptions: { keepAlive: true },
  experimental: { proxyTimeout: 600_000 },
  // Gzip buffers proxied SSE in production: chat events would all arrive at
  // once instead of streaming. Static assets barely suffer on a LAN.
  compress: false,
};

export default nextConfig;
