import { expect, test } from "@playwright/test";
import { devSignIn, DIEGO, MARISOL } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("money: receivables, payouts prepared by the expert, refused to the assistant, approved into settlement instructions", async ({ page }) => {
  await devSignIn(page, MARISOL);
  await page.goto("/money");
  await expect(page.getByRole("heading", { level: 1, name: "Money" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Receivables" })).toBeVisible();
  const cdmx = page.locator("section.card").filter({ has: page.getByRole("heading", { name: /Casa Alma, Roma Norte/ }) });
  await expect(cdmx).toContainText("Example Travel Collective");
  await expect(cdmx).toContainText("$1,120.00");
  await expect(cdmx).toContainText("Host agency fee (10%)");

  await page.goto("/money/payouts");
  await page.getByRole("button", { name: "Prepare payouts" }).click();
  const draft = page.locator("section.card").filter({ hasText: "draft" }).filter({ has: page.getByRole("button", { name: /Approve and pay/ }) }).first();
  await expect(draft).toBeVisible();
  await expect(draft).toContainText("Lena Brandt");
  const approveLabel = (await draft.getByRole("button", { name: /Approve and pay/ }).innerText()).trim();

  // The assistant can see the draft but not approve it.
  await devSignIn(page, DIEGO);
  await page.goto("/money/payouts");
  const asDiego = page.locator("section.card").filter({ hasText: "draft" }).first();
  await expect(asDiego).toContainText("Waiting for an owner to approve.");
  await expect(page.getByRole("button", { name: /Approve and pay/ })).toHaveCount(0);

  // The owner approves; without Stripe keys every share becomes a settlement instruction.
  await devSignIn(page, MARISOL);
  await page.goto("/money/payouts");
  await page.getByRole("button", { name: approveLabel }).first().click();
  await expect(page.getByText("Approved; payouts are being sent")).toBeVisible();
  await expect(page.getByRole("button", { name: approveLabel })).toHaveCount(0);
  const approved = page.locator("section.card").filter({ hasText: "approved by Marisol Vega" }).first();
  await expect(approved.getByRole("row", { name: /Lena Brandt/ })).toContainText("approved");

  // Paying the batch is the job worker's work. The e2e server runs no worker; when CRON_SECRET is
  // exported for the run, drive the queue through /api/cron and check the settlement-instruction path.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    test.info().annotations.push({ type: "note", description: "Settlement instructions not checked: set CRON_SECRET to let the test drive the job queue." });
    return;
  }
  const res = await page.request.post("/api/cron", { headers: { authorization: `Bearer ${secret}` } });
  expect(res.ok()).toBe(true);
  await page.goto("/money/payouts");
  const instructions = page.locator("h2", { hasText: "Settlement instructions" }).locator("xpath=following-sibling::*[1]");
  await expect(instructions.getByRole("row", { name: /Lena Brandt/ })).toContainText("issued");
  await instructions.getByRole("row", { name: /Lena Brandt/ }).getByRole("link").click();
  await expect(page).toHaveURL(/\/money\/instructions\/[0-9a-f-]{36}/);
  await expect(page.getByText(/Lena Brandt/).first()).toBeVisible();
});
