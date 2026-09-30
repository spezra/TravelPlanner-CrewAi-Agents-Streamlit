import { expect, test } from "@playwright/test";
import { CAMILLE, devSignIn, MARISOL, uniqWord } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("knowledge: publish redacted guidance to the network; the other workspace sees it", async ({ page }) => {
  await devSignIn(page, MARISOL);
  await page.goto("/knowledge");
  const tag = uniqWord("Zapote");
  const body = `${tag} guidance: at the Oaxaca market inn, ask Inés Robles for the terrace rooms, call +52 951 555 0199. Garden side rooms are usually the quietest.`;
  await page.getByLabel("Category").selectOption("property_guidance");
  await page.getByLabel("Destination").fill("Oaxaca");
  await page.getByLabel("What you know").fill(body);
  await page.getByLabel("Sharing permission (the most you allow)").selectOption("network");
  await page.getByLabel("Confidentiality").selectOption("shareable");
  await page.getByLabel("Factual confidence").selectOption("high");
  await page.getByRole("button", { name: "Save privately" }).click();
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("paragraph").filter({ hasText: body })).toBeVisible();

  await page.getByRole("combobox", { name: "Publish to" }).selectOption("network");
  await page.getByRole("button", { name: "Prepare to publish" }).click();
  await expect(page.getByText("Ready for your review below")).toBeVisible();

  // Approve from the review queue: the redacted text is what goes out.
  await page.goto("/knowledge/review");
  await expect(page.getByRole("heading", { level: 1, name: "Awaiting your approval" })).toBeVisible();
  const card = page.locator("section.card").filter({ hasText: tag });
  await expect(card).toContainText("to the network");
  const candidate = card.getByLabel(/Edit before publishing/);
  await expect(candidate).toHaveValue(new RegExp(tag));
  await expect(candidate).not.toHaveValue(/Inés Robles/);
  await expect(candidate).not.toHaveValue(/555 0199/);
  await card.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  await expect(page.locator("section.card").filter({ hasText: tag })).toHaveCount(0);

  // Camille, in the other admitted workspace, sees only the redacted guidance.
  await devSignIn(page, CAMILLE);
  await page.goto("/network");
  await expect(page.getByRole("heading", { level: 2, name: "Published guidance" })).toBeVisible();
  const published = page.locator("section.card").filter({ hasText: tag });
  await expect(published).toBeVisible();
  await expect(published).toContainText("Garden side rooms are usually the quietest");
  await expect(published).not.toContainText("Inés");
  await expect(published).not.toContainText("555 0199");
  await expect(published).toContainText("Oaxaca");
});

test("knowledge: commercial terms stay private and restricted and cannot be published", async ({ page }) => {
  await devSignIn(page, MARISOL);
  await page.goto("/knowledge");
  const tag = uniqWord("Tejate");
  const body = `${tag}: the inn extends a private discount off BAR for long stays.`;
  await page.getByLabel("Category").selectOption("commercial_terms");
  await page.getByLabel("What you know").fill(body);
  await page.getByLabel("Sharing permission (the most you allow)").selectOption("network");
  await page.getByLabel("Confidentiality").selectOption("shareable");
  await page.getByRole("button", { name: "Save privately" }).click();
  await expect(page.getByText(/stay private and restricted/)).toBeVisible();

  await page.getByLabel("Category").selectOption("commercial_terms");
  await page.getByLabel("What you know").fill(body);
  await page.getByLabel("Sharing permission (the most you allow)").selectOption("private");
  await page.getByLabel("Confidentiality").selectOption("restricted");
  await page.getByRole("button", { name: "Save privately" }).click();
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: /Commercial terms/ })).toBeVisible();
  await expect(page.getByText("This item's permission keeps it private.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare to publish" })).toHaveCount(0);

  await devSignIn(page, CAMILLE);
  await page.goto(`/network?q=${tag}`);
  await expect(page.getByText(/Nothing published to the network matches/)).toBeVisible();
  // Nor do Marisol's seeded unpublished items leak: the pending guidance and the restricted 15%-off terms.
  await page.goto("/network");
  await expect(page.getByRole("heading", { level: 2, name: "Published guidance" })).toBeVisible();
  await expect(page.getByText(/15% off BAR/)).toHaveCount(0);
  await expect(page.getByText(/casitas 3–5 face the mezcal garden/)).toHaveCount(0);
});
