import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // A shared real Postgres can't take parallel files resetting it.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
