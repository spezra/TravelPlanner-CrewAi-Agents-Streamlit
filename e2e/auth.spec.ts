import { expect, test } from "@playwright/test";
import { devSignIn, lastEmailTo } from "./helpers";

test("magic-link sign-in, onboarding and sign-out", async ({ page }) => {
  const email = `new-${Date.now()}@example.com`;
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /Email me a sign-in link/ }).click();
  await expect(page.getByText(/Check your email/)).toBeVisible();

  const mail = await lastEmailTo(email);
  const link = /(http\S+\/auth\/verify\S+)/.exec(mail.text)![1]!;
  await page.goto(link);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Your name").fill("Aiko Tanaka");
  await page.getByLabel(/Workspace/).fill("Kyoto Quiet");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText("Kyoto Quiet")).toBeVisible();

  // The link was single-use.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/invalid or has expired/)).toBeVisible();
});

test("session cookie is httpOnly and security headers are set", async ({ page }) => {
  const res = await page.goto("/login");
  const h = res!.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-powered-by"]).toBeUndefined();
  await devSignIn(page, /Marisol Vega/);
  const sid = (await page.context().cookies()).find((c) => c.name === "sid");
  expect(sid?.httpOnly).toBe(true);
  expect(sid?.sameSite).toBe("Lax");
});
