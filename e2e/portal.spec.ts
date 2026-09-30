import { expect, test } from "@playwright/test";
import { createPortalLink, DEMO, devSignIn, MARISOL, uniq } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("client portal shows the itinerary, takes acceptance, hides internals, and dies when revoked", async ({ page, browser }) => {
  await devSignIn(page, MARISOL);
  const label = uniq("Whitfields portal");
  const url = await createPortalLink(page, DEMO.trip, label);

  // The client opens it with no session at all.
  const ctx = await browser.newContext();
  const client = await ctx.newPage();
  await client.goto(url);
  await expect(client.getByRole("heading", { level: 1, name: /Mexico City & Oaxaca/ })).toBeVisible();
  await expect(client.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  await expect(client.getByRole("heading", { name: /Casa Alma, Roma Norte/ })).toBeVisible();
  await expect(client.getByText("Room upgrade (requested; subject to availability at arrival)").first()).toBeVisible();

  const body = (await client.locator("body").innerText()).toLowerCase();
  for (const secret of ["iata", "commission", "example travel collective", "80% to marisol", "best flexible rate", "net dmc rate", "mezcal-garden casita 4 held"]) {
    expect(body, `portal must not show "${secret}"`).not.toContain(secret);
  }

  // The seeded pending approval for the Oaxaca hacienda waits for the client's go-ahead.
  await expect(client.getByRole("heading", { name: "Waiting for your go-ahead" })).toBeVisible();
  const proposal = client.locator("section.card", { hasText: "Hacienda Tierra Roja" }).filter({ has: client.getByRole("button", { name: "Accept proposal" }) });
  await expect(proposal).toContainText("$14,750.00");
  await expect(proposal).toContainText("Free cancellation until 21 days before arrival");
  await proposal.getByLabel("Your full name").fill("Priya Whitfield");
  await proposal.getByRole("checkbox", { name: /I accept this proposal/ }).check();
  await proposal.getByRole("button", { name: "Accept proposal" }).click();
  await expect(client.getByText(/We've recorded your acceptance/)).toBeVisible();
  await expect(client.getByText(/Accepted by Priya Whitfield/)).toBeVisible();

  // The expert sees the acceptance; her approval is still required.
  await page.goto(`/trips/${DEMO.trip}`);
  const approval = page.locator("section.card", { hasText: "Hacienda Tierra Roja" }).filter({ hasText: "client accepted" });
  await expect(approval).toContainText("Priya Whitfield");
  await expect(approval).toContainText("Your approval is still required.");

  // Revoke; the same link stops working.
  await page.goto(`/trips/${DEMO.trip}/access`);
  await page.getByRole("row", { name: new RegExp(label) }).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("row", { name: new RegExp(label) })).toContainText("revoked");
  await client.goto(url);
  await expect(client.getByText("This link is no longer valid")).toBeVisible();
  await expect(client.getByText("Hacienda Tierra Roja")).toHaveCount(0);
  await ctx.close();
});
