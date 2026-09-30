import type { NextConfig } from "next";

const config: NextConfig = {
  // PGlite ships a WASM build of Postgres; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default config;
