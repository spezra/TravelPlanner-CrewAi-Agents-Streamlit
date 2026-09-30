import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // The first test in each file builds the migrated+seeded PGlite snapshot; under parallel load that exceeds the 10s default.
    hookTimeout: 60_000,
    // A shared real Postgres can't take parallel files resetting it.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
