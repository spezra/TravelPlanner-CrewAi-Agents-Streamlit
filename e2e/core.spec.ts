import { expect, test } from "@playwright/test";
import { devSignIn } from "./helpers";

test("row-level security shapes what each member sees", async ({ page }) => {
  await devSignIn(page, /Marisol Vega/);
  await page.goto("/trips");
  await expect(page.getByText("Scouting: Valle de Guadalupe")).toBeVisible();

  await devSignIn(page, /Diego Ortiz/);
  await page.goto("/trips");
  await expect(page.getByText("Mexico City & Oaxaca")).toBeVisible();
  await expect(page.getByText("Scouting: Valle de Guadalupe")).toHaveCount(0);

  await devSignIn(page, /Camille Roux/);
  await page.goto("/trips");
  await expect(page.getByText("Loire weekend")).toBeVisible();
  await expect(page.getByText("Mexico City & Oaxaca")).toHaveCount(0);
});

test("unauthenticated API and pages redirect or refuse", async ({ page, request }) => {
  await page.context().clearCookies();
  await page.goto("/trips");
  await expect(page).toHaveURL(/\/login/);
  expect((await request.post("/api/cron")).status()).toBe(401);
  expect((await request.get("/api/health")).ok()).toBe(true);
});
