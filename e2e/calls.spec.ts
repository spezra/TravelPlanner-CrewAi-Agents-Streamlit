import { expect, test } from "@playwright/test";
import { DEMO, devSignIn, MARISOL, uniq } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("call task: consent gates recording, notes are filed, a manual commitment reaches /commitments", async ({ page }) => {
  await devSignIn(page, MARISOL);
  await page.goto("/calls/new");
  const purpose = uniq("Confirm casita and late checkout");
  await page.getByLabel("Trip", { exact: true }).selectOption({ label: "Mexico City & Oaxaca — 20th anniversary" });
  await page.getByLabel("Supplier contact").selectOption(DEMO.gm);
  await page.getByLabel("Purpose").fill(purpose);
  await page.getByLabel("The ask").fill("Confirm late checkout to 2pm on departure day");
  await page.getByLabel("What counts as done").fill("Rafael confirms in writing");
  await page.getByLabel("Our side").fill("Marisol Vega");
  await page.getByLabel("Jurisdiction").nth(0).fill("US-NY");
  await page.getByLabel("Their side").fill("Rafael Montes");
  await page.getByLabel("Jurisdiction").nth(1).fill("US-CA");
  await page.getByRole("button", { name: "Create call task" }).click();

  await expect(page.getByRole("heading", { level: 1, name: purpose })).toBeVisible();
  await expect(page).toHaveURL(/\/calls\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Before you call Rafael Montes" })).toBeVisible();

  // The consent rule: California requires every party's consent; recording is blocked until it is logged.
  const rafael = page.getByRole("row", { name: /Rafael Montes/ });
  await expect(rafael).toContainText("US-CA");
  await expect(rafael).toContainText("all parties must consent");
  await expect(page.getByText("Notes mode", { exact: true })).toBeVisible();
  const toRecorded = page.getByRole("button", { name: "Switch to recorded mode" });
  await expect(toRecorded).toBeDisabled();

  for (const who of ["Marisol Vega", "Rafael Montes"]) {
    const row = page.getByRole("row", { name: new RegExp(who) });
    await row.getByRole("textbox", { name: "How consent was disclosed" }).fill("Asked at the start of the call");
    await row.getByRole("button", { name: "Log consent" }).click();
    await expect(page.getByRole("row", { name: new RegExp(who) })).toContainText("logged");
    // Until the last party consents, recording stays blocked.
    if (who === "Marisol Vega") await expect(toRecorded).toBeDisabled();
  }
  await expect(toRecorded).toBeEnabled();
  await toRecorded.click();
  await expect(page.getByText("Recorded mode", { exact: true })).toBeVisible();

  // File notes.
  const notes = `Rafael agreed to late checkout at 2pm. ${purpose}.`;
  await page.getByRole("textbox", { name: "Call notes" }).fill(notes);
  await page.getByRole("button", { name: "File notes and extract commitments" }).click();
  await expect(page.getByText("Notes filed. Commitments are being extracted.")).toBeVisible();
  await expect(page.locator("section.card pre", { hasText: notes })).toBeVisible();

  // Enter a commitment by hand.
  const promise = uniq("Late checkout to 2pm on departure");
  await page.getByText("Enter a commitment by hand").click();
  await expect(page.getByLabel("Who promised")).toHaveValue("Rafael Montes");
  await page.getByLabel("What was promised").fill(promise);
  await page.getByLabel("Booking").selectOption({ label: "Hacienda Tierra Roja, Oaxaca — 5 nights, mezcal-garden casita" });
  await page.getByLabel("How we know").selectOption("verbal_statement");
  await page.getByRole("button", { name: "Record commitment" }).click();
  await expect(page.getByText("Commitment recorded.")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(promise) })).toBeVisible();

  await page.goto("/commitments");
  await expect(page.getByRole("heading", { level: 1, name: "Commitments" })).toBeVisible();
  await page.getByRole("link", { name: "Pending", exact: true }).click();
  await expect(page).toHaveURL(/filter=pending/);
  const row = page.getByRole("row", { name: new RegExp(promise) });
  await expect(row).toContainText("Rafael Montes");
  await expect(row).toContainText("Hacienda Tierra Roja");
  await expect(row.getByRole("link", { name: purpose })).toBeVisible();
});
