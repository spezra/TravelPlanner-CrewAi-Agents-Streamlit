import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// The Content-Security-Policy is set per request with a script nonce in src/proxy.ts.

const config: NextConfig = {
  poweredByHeader: false,
  // PGlite ships a WASM build of Postgres; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "pino", "nodemailer"],
  experimental: { serverActions: { bodySizeLimit: "30mb" } },
  async headers() {
    return [
      // JSON endpoints never render content.
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" }] },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
          ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
        ],
      },
    ];
  },
};

export default config;
