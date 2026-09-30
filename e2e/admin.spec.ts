import { expect, test } from "@playwright/test";
import { addHotel, createTrip, devSignIn, DIEGO, MARISOL, requestBookApproval, uniq } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("admin: the audit log records the owner's actions and filters by action", async ({ page }) => {
  await devSignIn(page, MARISOL);
  const tripId = await createTrip(page, uniq("Audit trail trip"));
  const hotel = uniq("Audit hotel");
  await addHotel(page, tripId, hotel);
  await requestBookApproval(page, tripId, hotel);

  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  for (const action of ["trip.created", "item.created", "approval.requested"]) {
    await expect(page.getByRole("row").filter({ hasText: action }).first()).toContainText("Marisol Vega");
  }
  await expect(page.getByRole("row").filter({ hasText: "trip.created" }).filter({ hasText: tripId })).toHaveCount(1);

  // Filter narrows to one action.
  await page.getByLabel("Action").selectOption("trip.created");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/action=trip\.created/);
  await expect(page.getByRole("row").filter({ hasText: tripId })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "item.created" })).toHaveCount(0);
});

test("admin: the assistant is turned away from admin pages", async ({ page }) => {
  await devSignIn(page, DIEGO);
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  for (const path of ["/admin", "/admin/audit", "/admin/exports"]) {
    await page.goto(path);
    await expect(page).not.toHaveURL(/\/admin/);
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await expect(page.getByText("You don't have access to that.")).toBeVisible();
  }
});

test("admin: the owner requests a workspace export and sees it listed", async ({ page }) => {
  await devSignIn(page, MARISOL);
  await page.goto("/admin/exports");
  await expect(page.getByRole("heading", { level: 1, name: "Data export" })).toBeVisible();
  const before = await page.getByRole("row").filter({ hasText: "workspace" }).count();
  await page.getByRole("button", { name: "Prepare export" }).click();
  await expect(page.getByText("Export queued. It appears here when ready")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "workspace" })).toHaveCount(before + 1);
  await expect(page.getByRole("row").filter({ hasText: "workspace" }).first()).toContainText(/queued|ready/);

  await page.goto("/admin/audit?action=export.requested");
  await expect(page.getByRole("row").filter({ hasText: "export.requested" }).first()).toContainText("Marisol Vega");

  // Building the file is the job worker's work; drive it when the run exposes CRON_SECRET.
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  expect((await page.request.post("/api/cron", { headers: { authorization: `Bearer ${secret}` } })).ok()).toBe(true);
  await page.goto("/admin/exports");
  const ready = page.getByRole("row").filter({ hasText: "workspace" }).first();
  await expect(ready).toContainText("ready");
  const download = page.waitForEvent("download");
  await ready.getByRole("link", { name: /Download/ }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
});
