import { expect, test } from "@playwright/test";
import { DEMO, devSignIn, MARISOL, uniq } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("relationships: open Rafael Montes, log to the ledger, record a role move", async ({ page }) => {
  await devSignIn(page, MARISOL);
  await page.goto("/people");
  await expect(page.getByRole("heading", { level: 1, name: "Relationships" })).toBeVisible();
  await page.getByRole("link", { name: "Rafael Montes", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Rafael Montes" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/people/${DEMO.gm}`));

  // A touch.
  const touch = uniq("Sent a note about his daughter's ceramics show");
  await page.getByLabel("What happened").selectOption({ label: "Touch" });
  await page.getByLabel("Note", { exact: true }).fill(touch);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByText("Logged", { exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(touch) })).toContainText("Touch");

  // A favor ask: three open asks and no recognition, so the ledger advises giving first; acknowledging logs it anyway.
  const ask = uniq("Late checkout for the Whitfields");
  await page.getByLabel("What happened").selectOption({ label: "Favor asked" });
  await page.getByLabel("Ask type (favors)").fill("late_checkout");
  await page.getByLabel("How much this ask matters (favors asked)").selectOption("important");
  await page.getByLabel("Note", { exact: true }).fill(ask);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByText(/The ledger says give first/)).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(ask) })).toHaveCount(0);
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue(ask);
  await page.getByRole("checkbox", { name: /log it anyway/ }).check();
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByText(/^Logged against advice/)).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(ask) })).toContainText("Favor asked · late_checkout");

  // Rafael moves on: the old role closes, the new one opens, dependent knowledge is flagged.
  const org = uniq("Casa Sierra Azul");
  await page.getByLabel("New organization").fill(org);
  await page.getByLabel("Title", { exact: true }).first().fill("General Manager");
  await page.getByLabel("Measured on").fill("RevPAR");
  await page.getByRole("button", { name: "Record move" }).click();
  await expect(page.getByText(/knowledge items? flagged for review/)).toBeVisible();
  const roles = page.locator("h2", { hasText: "Role history" }).locator("xpath=following-sibling::div[1]");
  await expect(roles.getByRole("listitem").filter({ hasText: org })).toContainText("now");
  await expect(roles.getByRole("listitem").filter({ hasText: "Hacienda Tierra Roja" })).not.toContainText("– now");
  await expect(page.getByText(`Knowledge that depends on Rafael Montes`)).toBeVisible();
});

test("inbox: accepting the parsed supplier confirmation settles the outcome-unknown transfer", async ({ page }) => {
  await devSignIn(page, MARISOL);
  await page.goto(`/trips/${DEMO.trip}`);
  const transferRow = page.getByRole("row", { name: /Private transfer, Oaxaca airport → Hacienda transfer/ });
  await expect(transferRow).toContainText("outcome unknown");

  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  const card = page.locator("div.card").filter({ hasText: "Attach confirmation to a booking" }).filter({ hasText: "VT-20931" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Valle Transportes");
  await expect(card.getByRole("combobox", { name: "Booking" })).toHaveValue(DEMO.transfer);
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await expect(page.locator("div.card").filter({ hasText: "Attach confirmation to a booking" }).filter({ hasText: "VT-20931" })).toHaveCount(0);

  await page.goto(`/trips/${DEMO.trip}`);
  const after = page.getByRole("row", { name: /Private transfer, Oaxaca airport → Hacienda transfer/ });
  await expect(after).toContainText("confirmed");
  await expect(after).toContainText("Conf. VT-20931");
  await expect(after).not.toContainText("outcome unknown");
});
