import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Container target for GCP Cloud Run
  output: "standalone",
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
  poweredByHeader: false,
  // TypeScript 7 ships a native compiler without the Node compiler API that
  // Next.js links against; the TS CLI path is the supported route.
  experimental: {
    useTypeScriptCli: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
