import { expect, test } from "@playwright/test";
import { addHotel, createTrip, devSignIn, escapeRe, MARISOL, uniq } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("clients and judgment: new client with a brief, a rejected item on /judgment, a backup in the response plan", async ({ page }) => {
  await devSignIn(page, MARISOL);

  // A new client and a brief statement.
  const clientName = uniq("The Okafors");
  await page.goto("/clients");
  await page.getByLabel(/^Name \(as you address them/).fill(clientName);
  await page.getByLabel("Email").fill(`okafor-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByRole("heading", { level: 1, name: clientName })).toBeVisible();
  const clientUrl = page.url();

  const statement = uniq("Prefer small hotels with a garden; no rooftop bars");
  await page.getByText("Add to the brief").click();
  await page.getByLabel("Dimension").selectOption({ index: 0 });
  await page.getByLabel(/^Statement:/).fill(statement);
  await page.getByLabel("Evidence", { exact: true }).selectOption("client_said");
  await page.getByLabel("Source").fill("call 2026-09-30");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: statement })).toContainText("client said");

  // A trip for them, and a decision recorded against one of its items.
  const tripTitle = uniq("Okafor Lisbon");
  const tripId = await createTrip(page, tripTitle, { client: clientName, startsInDays: 60, nights: 6 });
  await expect(page.getByText(statement)).toBeVisible();
  const hotel = uniq("Palacio Example, river room");
  await addHotel(page, tripId, hotel);

  await page.goto(`/trips/${tripId}`);
  await page.getByRole("link", { name: "Decisions" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Decisions: ${tripTitle}` })).toBeVisible();
  const itemForm = page.locator("form.card").filter({ hasText: hotel });
  await itemForm.getByRole("radio", { name: "Reject" }).check();
  await itemForm.getByText("Why (optional)").click();
  await itemForm.getByLabel("Reason").selectOption("expert_taste");
  const why = uniq("Lobby is loud and the service is staged");
  await itemForm.getByLabel("In your words").fill(why);
  await itemForm.getByRole("button", { name: "Record" }).click();
  const recorded = page.locator("section.card").filter({ hasText: hotel });
  await expect(recorded).toContainText("reject");
  await expect(recorded).toContainText("learned");
  await expect(recorded).toContainText(why);

  await page.goto("/judgment");
  await expect(page.getByRole("heading", { level: 1, name: "Your taste model" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: new RegExp(`Rejected ${escapeRe(hotel)}: ${escapeRe(why)}`) })).toBeVisible();

  // Response plan: name a backup and save.
  await page.goto(`/trips/${tripId}/plan`);
  await expect(page.getByRole("heading", { level: 1, name: "Response plan" })).toBeVisible();
  const backup = page.locator("section.card").filter({ has: page.getByRole("heading", { level: 3, name: "Backup" }) });
  await backup.getByLabel("Who").selectOption({ label: "Lena Brandt" });
  await backup.getByLabel("Time zone").fill("Europe/Berlin");
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) await backup.getByRole("checkbox", { name: d }).first().check();
  const primary = page.locator("section.card").filter({ has: page.getByRole("heading", { level: 3, name: "Primary" }) });
  for (const d of ["Mon", "Tue", "Wed"]) await primary.getByRole("checkbox", { name: d }).first().check();
  await page.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByText("Response plan saved")).toBeVisible();
  await expect(page.getByText(/Lena Brandt's backup access/)).toBeVisible();

  await page.goto(`/trips/${tripId}`);
  await expect(page.getByText("Backup: Lena Brandt (Europe/Berlin)")).toBeVisible();

  await page.goto(clientUrl);
  await expect(page.getByText(statement)).toBeVisible();
});
