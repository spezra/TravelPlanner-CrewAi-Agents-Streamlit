import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

export async function lastEmailTo(email: string): Promise<{ subject: string; text: string }> {
  for (let i = 0; i < 50; i++) {
    const raw = await readFile("test-results/e2e-mail.jsonl", "utf8").catch(() => "");
    const mine = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { to: string; subject: string; text: string })
      .filter((m) => m.to === email);
    if (mine.length) return mine.at(-1)!;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No email to ${email}`);
}

export async function devSignIn(page: Page, label: RegExp) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: label }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
}

/** Demo ids from src/db/seed.ts (duplicated so specs don't import app code). */
export const DEMO = {
  workspace: "00000000-0000-4000-8000-000000000001",
  client: "00000000-0000-4000-8000-0000000000c1",
  trip: "00000000-0000-4000-8000-0000000000d1",
  transfer: "00000000-0000-4000-8000-0000000000e4",
  gm: "00000000-0000-4000-8000-000000000101",
} as const;

export const MARISOL = /Marisol Vega/;
export const DIEGO = /Diego Ortiz/;
export const CAMILLE = /Camille Roux/;

/** A short unique suffix so journeys never collide with each other's data. */
export const uniq = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** A unique letters-only word (digits could be redacted as figures). */
export const uniqWord = (prefix: string) =>
  `${prefix}${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`;

/** Create a trip through the UI as the signed-in member; returns its id. */
export async function createTrip(page: Page, title: string, opts: { client?: string; startsInDays?: number; nights?: number } = {}): Promise<string> {
  await page.goto("/trips/new");
  await page.getByLabel("Title").fill(title);
  if (opts.client) await page.getByLabel("Client").selectOption({ label: opts.client });
  if (opts.startsInDays !== undefined) {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel("Starts").fill(day(opts.startsInDays));
    await page.getByLabel("Ends").fill(day(opts.startsInDays + (opts.nights ?? 5)));
  }
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  return /\/trips\/([0-9a-f-]{36})/.exec(page.url())![1]!;
}

/** Add a hotel item with complete booking credentials and perks; returns the item id. */
export async function addHotel(page: Page, tripId: string, title: string): Promise<string> {
  await page.goto(`/trips/${tripId}/items/new`);
  await page.getByLabel("Kind").selectOption("hotel");
  await page.getByLabel("Supplier").fill("Hotel Ejemplo");
  await page.getByLabel("Title (traveler-facing)").fill(title);
  await page.getByLabel("Price", { exact: true }).fill("2,400.00");
  await page.getByLabel("Booking entity").fill("Host agency: Example Travel Collective (IATA 00000000)");
  await page.getByLabel("Permitted channel").fill("Direct to property");
  await page.getByLabel("Program").fill("Example Preferred Partner");
  await page.getByLabel("Rate", { exact: true }).fill("Best flexible rate");
  await page.getByLabel("Perk 1", { exact: true }).fill("Daily breakfast for two");
  await page.getByLabel("Perk 1 basis").selectOption("guaranteed");
  await page.getByLabel("Perk 2", { exact: true }).fill("Room upgrade");
  await page.getByLabel("Perk 2 basis").selectOption("availability_dependent");
  await page.getByLabel("Servicing owner").fill("Marisol Vega");
  await page.getByLabel("Commission recipient").fill("Example Travel Collective, 80% to Marisol Vega");
  await page.getByLabel("modify").check();
  await page.getByLabel("cancel").check();
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  return /\/items\/([0-9a-f-]{36})/.exec(page.url())![1]!;
}

/** Request approval to book (and pay for) one item from the trip page. */
export async function requestBookApproval(page: Page, tripId: string, itemTitle: string) {
  await page.goto(`/trips/${tripId}`);
  await page.getByRole("link", { name: "Request approval" }).click();
  await page.getByRole("checkbox", { name: new RegExp(`Book ${escapeRe(itemTitle)}`) }).check();
  await page.getByRole("listitem").filter({ hasText: itemTitle }).getByRole("checkbox", { name: "and pay" }).check();
  await page.getByLabel("Price", { exact: true }).fill("2,400.00");
  await page.getByLabel("Who will act").fill("Booking agent, direct to property");
  await page.getByLabel("Cancellation terms").fill("Free cancellation until 14 days before arrival");
  await page.getByRole("button", { name: "Request approval" }).click();
  await expect(page.getByText("Approval requested", { exact: true })).toBeVisible();
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Create a client link on a trip's access page (as its owner); returns the one-time URL. */
export async function createPortalLink(page: Page, tripId: string, label: string): Promise<string> {
  await page.goto(`/trips/${tripId}/access`);
  await page.getByLabel("Label (for you)").fill(label);
  await page.getByLabel("Valid for (days)").fill("7");
  await page.getByRole("button", { name: "Create link" }).click();
  const link = page.getByRole("textbox", { name: "Client link" });
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toMatch(/\/portal\/[A-Za-z0-9_-]{20,}/);
  await expect(page.getByRole("row", { name: new RegExp(escapeRe(label)) })).toContainText("active");
  return url;
}
