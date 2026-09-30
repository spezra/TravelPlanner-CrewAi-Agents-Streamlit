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
