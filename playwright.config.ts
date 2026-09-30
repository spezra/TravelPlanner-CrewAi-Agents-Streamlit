import { defineConfig, devices } from "@playwright/test";

const PORT = 3200;
export const MAIL_FILE = "test-results/e2e-mail.jsonl";

/**
 * End-to-end tests against a production build. NODE_ENV=test keeps dev
 * sign-in and the mail sink available; everything else runs as in production.
 * Set E2E_DATABASE_URL to run against real Postgres (CI does); otherwise a
 * fresh embedded database is used.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.PW_CHROMIUM ?? undefined } } },
  ],
  webServer: {
    command: `rm -rf .data-e2e test-results/e2e-mail.jsonl && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      ALLOW_DEV_LOGIN: "1",
      APP_URL: `http://127.0.0.1:${PORT}`,
      E2E_MAIL_FILE: MAIL_FILE,
      STORAGE_LOCAL_DIR: ".data-e2e/blobs",
      PGLITE_DIR: ".data-e2e/pglite",
      LOG_LEVEL: "warn",
      SEED_DEMO: "1",
      ...(process.env.E2E_DATABASE_URL ? { DATABASE_URL: process.env.E2E_DATABASE_URL } : {}),
    },
  },
});
