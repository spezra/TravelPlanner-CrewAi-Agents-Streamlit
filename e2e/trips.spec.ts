import { expect, test } from "@playwright/test";
import { addHotel, createTrip, devSignIn, DIEGO, escapeRe, MARISOL, requestBookApproval, uniq } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("expert builds a trip, requests approval and approves; the assistant cannot", async ({ page }) => {
  await devSignIn(page, MARISOL);
  const tripTitle = uniq("E2E Trip");
  const tripId = await createTrip(page, tripTitle);
  const hotel = uniq("Hotel Ejemplo, garden room");
  await addHotel(page, tripId, hotel);

  await page.goto(`/trips/${tripId}`);
  const row = page.getByRole("row", { name: new RegExp(escapeRe(hotel)) });
  await expect(row).toContainText("Room upgrade (requested; subject to availability at arrival)");
  await expect(row).toContainText("Daily breakfast for two");
  await expect(row).not.toContainText("Daily breakfast for two (requested");
  await expect(row).toContainText("design");

  await requestBookApproval(page, tripId, hotel);
  const approval = page.locator("section.card", { hasText: `book ${hotel}` }).first();
  await expect(approval).toContainText("pending");

  // The assistant sees the trip but cannot decide on money.
  await devSignIn(page, DIEGO);
  await page.goto(`/trips/${tripId}`);
  const asDiego = page.locator("section.card", { hasText: `book ${hotel}` }).first();
  await expect(asDiego).toContainText("Waiting for Marisol Vega to decide.");
  await expect(asDiego.getByRole("button", { name: /Approve all/ })).toHaveCount(0);

  // The expert approves on the trip page.
  await devSignIn(page, MARISOL);
  await page.goto(`/trips/${tripId}`);
  await page.locator("section.card", { hasText: `book ${hotel}` }).first().getByRole("button", { name: /Approve all 2 actions/ }).click();
  const decided = page.locator("section.card", { hasText: `book ${hotel}` }).first();
  await expect(decided).toContainText("approved");
  await expect(decided).toContainText("Decided by Marisol Vega");
  await expect(page.getByRole("row", { name: new RegExp(escapeRe(hotel)) })).toContainText("approved");
  await expect(page.getByRole("row", { name: new RegExp(escapeRe(hotel)) }).getByRole("button", { name: "Book with supplier" })).toBeVisible();
});
