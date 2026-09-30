import { expect, test } from "@playwright/test";
import { createPortalLink, DEMO, devSignIn, MARISOL, uniq } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("proposal: start from items, a promised upgrade blocks sending, fix wording, send, client sees it", async ({ page, browser }) => {
  await devSignIn(page, MARISOL);
  await page.goto(`/proposals/${DEMO.trip}`);
  await page.getByRole("button", { name: "Start from trip items" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Version \d+/ })).toBeVisible();
  await expect(page.getByLabel("Introduction")).toBeVisible();

  const tag = uniq("Anniversary");
  await page.getByLabel("Introduction").fill(`${tag}: a week of gardens and mezcal. You will receive a room upgrade at the hacienda.`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const block = page.getByText(/Must fix · intro: "Room upgrade" depends on availability but reads as promised/).first();
  await expect(block).toBeVisible();

  // Sending is refused while the blocking issue stands.
  await page.getByRole("button", { name: "Send to client portal" }).click();
  await expect(page.locator(".notice.error")).toBeVisible();
  await expect(page.getByText("Sent to the client portal")).toHaveCount(0);

  const fixed = `${tag}: a week of gardens and mezcal. We will request a room upgrade at the hacienda, subject to availability.`;
  await page.getByLabel("Introduction").fill(fixed);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByText(/Must fix · intro/)).toHaveCount(0);

  await page.getByRole("button", { name: "Send to client portal" }).click();
  await expect(page.getByText("Sent to the client portal")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /Version \d+/ })).toContainText("sent");

  const url = await createPortalLink(page, DEMO.trip, uniq("Proposal link"));
  const ctx = await browser.newContext();
  const client = await ctx.newPage();
  await client.goto(url);
  await expect(client.locator("article.proposal-doc")).toContainText(fixed);
  await expect(client.getByText("You will receive a room upgrade")).toHaveCount(0);
  await ctx.close();
});
