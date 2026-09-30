import { expect, test } from "@playwright/test";
import { addHotel, createTrip, DEMO, devSignIn, MARISOL, requestBookApproval, uniq, uniqWord } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("today: fresh work shows up with Open links that land on the right page", async ({ page }) => {
  await devSignIn(page, MARISOL);

  // Something to approve…
  const tripTitle = uniq("Today trip");
  const tripId = await createTrip(page, tripTitle);
  const hotel = uniq("Today hotel");
  await addHotel(page, tripId, hotel);
  await requestBookApproval(page, tripId, hotel);

  // …and a knowledge item waiting for the owner's publication decision.
  await page.goto("/knowledge");
  await page.getByLabel("What you know").fill(`${uniqWord("Nopal")}: the courtyard rooms are the quietest in the old town.`);
  await page.getByLabel("Sharing permission (the most you allow)").selectOption("workspace");
  await page.getByRole("button", { name: "Save privately" }).click();
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]{36}$/);
  const knowledgePath = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "Prepare to publish" }).click();
  await expect(page.getByText("Ready for your review below")).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await expect(page.getByText(/decisions? needs? you/)).toBeVisible();

  const approval = page.locator("section.card").filter({ has: page.locator(`a[href="/trips/${tripId}"]`) });
  await expect(approval).toHaveCount(1);
  await expect(approval).toContainText("Approve: book, pay ($2,400.00)");
  await approval.getByRole("link", { name: "Open trip" }).click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}$`));
  await expect(page.getByRole("heading", { level: 1, name: tripTitle })).toBeVisible();

  await page.goto("/");
  const share = page.locator("section.card").filter({ has: page.locator(`a[href="${knowledgePath}"]`) });
  await expect(share).toContainText("Knowledge item ready to share");
  await share.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${knowledgePath}$`));
  await expect(page.getByRole("heading", { level: 2, name: "Your approval" })).toBeVisible();

  // Every Open link on Today resolves to a real page.
  await page.goto("/");
  const hrefs = new Set<string>();
  for (const link of await page.locator("main section.card").getByRole("link", { name: /^Open( trip)?$/ }).all()) hrefs.add((await link.getAttribute("href"))!);
  expect(hrefs.size).toBeGreaterThan(1);
  for (const href of hrefs) {
    const res = await page.goto(href);
    expect(res?.status(), href).toBe(200);
    await expect(page.getByRole("heading", { name: "Not found" }), href).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 }), href).toBeVisible();
  }
});

test("today: deciding an approval never redirects off-site", async ({ page }) => {
  // Bug: decideApproval/confirmCommitment in src/app/(app)/actions.ts redirect to the unvalidated `back` form field (open redirect).
  await devSignIn(page, MARISOL);
  const tripId = await createTrip(page, uniq("Redirect trip"));
  const hotel = uniq("Redirect hotel");
  await addHotel(page, tripId, hotel);
  await requestBookApproval(page, tripId, hotel);

  await page.goto("/");
  const card = page.locator("section.card").filter({ has: page.locator(`a[href="/trips/${tripId}"]`) });
  await card.locator('input[name="back"]').evaluate((el: HTMLInputElement) => (el.value = "https://example.org/phish"));
  const offsite = page
    .waitForRequest((r) => r.url().startsWith("https://example.org/"), { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  expect(await offsite, "the action must not send the browser to another site").toBe(false);
  expect(new URL(page.url()).host).toBe("127.0.0.1:3200");
});

test("trip page: confirming a commitment as checked is recorded in the audit log", async ({ page }) => {
  // Bug: confirmCommitment (src/app/(app)/actions.ts), used by Today and the trip page, updates review_status with no
  // audit entry and no role check, unlike /commitments' confirmChecked, which audits "commitment.reviewed".
  await devSignIn(page, MARISOL);
  await page.goto("/admin/audit?action=commitment.reviewed");
  const before = await page.getByRole("row").filter({ hasText: "commitment.reviewed" }).count();

  await page.goto(`/trips/${DEMO.trip}`);
  const row = page.getByRole("row", { name: /Casita 4 held for the Whitfields/ });
  await row.getByRole("button", { name: "Confirm checked" }).click();
  await expect(page.getByRole("row", { name: /Casita 4 held for the Whitfields/ }).getByRole("button", { name: "Confirm checked" })).toHaveCount(0);

  await page.goto("/admin/audit?action=commitment.reviewed");
  await expect(page.getByRole("row").filter({ hasText: "commitment.reviewed" })).toHaveCount(before + 1);
});
