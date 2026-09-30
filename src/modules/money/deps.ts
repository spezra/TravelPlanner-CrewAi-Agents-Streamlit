/**
 * External dependencies of the money module, injectable so tests use a fake
 * Stripe (fake fetch) and an in-memory mailer. Without STRIPE_SECRET_KEY the
 * module still works: payouts fall back to settlement instructions and the
 * Stripe-only features (onboarding, card vault) say they are unavailable.
 */
import type { Queryable } from "@/db/client";
import { DomainError, type Role } from "@/domain/common";
import { StripeClient } from "@/providers/stripe";
import { config } from "@/server/config";
import { hmacSha256Hex, safeEqual } from "@/server/crypto";
import { mailer, SYSTEM_FOOTER, type Mailer } from "@/server/mail";
import { memberRole } from "./repo";

export interface MoneyDeps {
  stripe: StripeClient | null;
  mail: Mailer;
  appUrl: string;
  /** Signs public onboarding-link refresh URLs. Null when Stripe is not configured. */
  linkSecret: string | null;
}

export function moneyDeps(): MoneyDeps {
  const c = config();
  return {
    stripe: c.STRIPE_SECRET_KEY ? new StripeClient(c.STRIPE_SECRET_KEY) : null,
    mail: mailer(),
    appUrl: c.APP_URL.replace(/\/$/, ""),
    linkSecret: c.STRIPE_SECRET_KEY ?? null,
  };
}

export function requireStripe(deps: MoneyDeps): StripeClient {
  if (!deps.stripe) throw new DomainError("stripe_unavailable", "Stripe is not configured for this platform yet");
  return deps.stripe;
}

/** Throws unless the current member holds one of `roles` (RLS enforces the same on writes). */
export async function requireRole(q: Queryable, roles: Role[], what: string): Promise<Role> {
  const role = await memberRole(q);
  if (!role || !roles.includes(role)) throw new DomainError("forbidden", `Your role can't ${what}`);
  return role;
}

export const WRITERS: Role[] = ["owner", "advisor", "admin"];

/** Onboarding refresh links are public (the payee may not be a member), so they carry an HMAC. */
export function onboardingToken(secret: string, recipientId: string): string {
  return hmacSha256Hex(secret, `connect-refresh:${recipientId}`);
}

export function checkOnboardingToken(secret: string, recipientId: string, token: string): boolean {
  return safeEqual(onboardingToken(secret, recipientId), token);
}

/** Emails every active owner of a workspace. System-labeled; call after the transaction commits. */
export async function ownerEmails(q: Queryable, workspaceId: string): Promise<string[]> {
  const { rows } = await q.query<{ email: string }>(
    "select email from members where workspace_id = $1 and role = 'owner' and disabled_at is null order by email",
    [workspaceId],
  );
  return rows.map((r) => r.email);
}

export async function sendSystemMail(mail: Mailer, to: readonly string[], subject: string, text: string): Promise<void> {
  for (const addr of to) await mail.send({ to: addr, subject, text: text + SYSTEM_FOOTER });
}
