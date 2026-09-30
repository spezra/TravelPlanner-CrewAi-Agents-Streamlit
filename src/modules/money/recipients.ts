/**
 * Payees: the workspace itself (its retained share), its members, and outside
 * collaborators. Payees who can receive platform transfers are onboarded to
 * Stripe Connect (Express); everyone else is paid by settlement instruction,
 * using remittance details stored encrypted.
 */
import type { Db, Queryable } from "@/db/client";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import type { StripeAccount } from "@/providers/stripe";
import { decryptFor, encryptFor } from "@/server/crypto";
import { onboardingToken, requireRole, requireStripe, sendSystemMail, WRITERS, type MoneyDeps } from "./deps";
import * as repo from "./repo";

const detailsContext = (recipientId: string) => `money-recipient:${recipientId}`;

export function addRecipient(db: Db, tenant: Tenant, input: { kind: "member" | "external"; memberId: string | null; name: string; email: string | null }) {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "add payees");
    await repo.ensureWorkspaceRecipient(q, tenant.workspaceId);
    let { name, email } = input;
    if (input.kind === "member") {
      const { rows } = await q.query<{ name: string; email: string }>("select name, email from members where id = $1", [input.memberId]);
      if (!rows[0]) throw new DomainError("not_found", "Member not found");
      name ||= rows[0].name;
      email ||= rows[0].email;
    }
    if (!name.trim()) throw new DomainError("bad_input", "A payee needs a name");
    const { rows } = await q.query<{ id: string }>(
      `insert into money_recipients (workspace_id, kind, member_id, name, email) values ($1,$2,$3,$4,$5)
       on conflict (workspace_id, member_id) where member_id is not null do nothing returning id`,
      [tenant.workspaceId, input.kind, input.kind === "member" ? input.memberId : null, name.trim(), email?.trim() || null],
    );
    if (!rows[0]) throw new DomainError("duplicate", "That member is already a payee");
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.recipient_added", rows[0].id, { kind: input.kind });
    return rows[0].id;
  });
}

export function setSettlementDetails(db: Db, tenant: Tenant, recipientId: string, details: string) {
  return withTenant(db, tenant, async (q) => {
    // Where money goes is an owner's decision: nobody else can redirect a payee's payouts.
    await requireRole(q, ["owner"], "change where a payee is paid");
    const sealed = details.trim() ? await encryptFor(q, tenant.workspaceId, detailsContext(recipientId), details.trim()) : null;
    const { rows } = await q.query("update money_recipients set settlement_details_enc = $2, destination_changed_at = now() where id = $1 returning id", [recipientId, sealed]);
    if (!rows.length) throw new DomainError("not_found", "Payee not found");
    // Never log or audit the details themselves.
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.recipient_details_changed", recipientId);
  });
}

export async function settlementDetails(q: Queryable, workspaceId: string, recipientId: string): Promise<string | null> {
  const { rows } = await q.query<{ settlement_details_enc: string | null }>("select settlement_details_enc from money_recipients where id = $1", [recipientId]);
  const sealed = rows[0]?.settlement_details_enc;
  return sealed ? decryptFor(q, workspaceId, detailsContext(recipientId), sealed) : null;
}

export function onboardingStatusOf(a: Pick<StripeAccount, "details_submitted" | "payouts_enabled">): "pending" | "restricted" | "enabled" {
  if (a.details_submitted && a.payouts_enabled) return "enabled";
  return a.details_submitted ? "restricted" : "pending";
}

async function saveAccountState(q: Queryable, account: StripeAccount): Promise<number> {
  const { rows } = await q.query(
    `update money_recipients set onboarding_status = $2, payouts_enabled = $3, details_submitted = $4 where stripe_account_id = $1 returning id`,
    [account.id, onboardingStatusOf(account), account.payouts_enabled, account.details_submitted],
  );
  return rows.length;
}

function linkUrls(deps: MoneyDeps, recipientId: string) {
  const token = onboardingToken(deps.linkSecret ?? "", recipientId);
  const base = `${deps.appUrl}/api/webhooks/stripe/connect?r=${encodeURIComponent(recipientId)}&t=${token}`;
  return { refreshUrl: base, returnUrl: `${base}&done=1` };
}

/**
 * Creates (once) the payee's Express account and a fresh onboarding link.
 * The account is created under an idempotency key tied to the payee, so a
 * crash between Stripe's reply and our write can't create a second account.
 */
export async function startOnboarding(db: Db, tenant: Tenant, recipientId: string, deps: MoneyDeps, now: Date, opts: { email: boolean } = { email: true }) {
  const stripe = requireStripe(deps);
  const recipient = await withTenant(db, tenant, async (q) => {
    await requireRole(q, ["owner"], "onboard payees");
    const r = await repo.getRecipient(q, recipientId);
    if (!r) throw new DomainError("not_found", "Payee not found");
    if (r.kind === "workspace") throw new DomainError("bad_input", "The workspace's own share is retained, not paid out");
    // The link is only ever emailed to the payee, so whoever completes it is the payee.
    if (!r.email) throw new DomainError("no_email", "Add the payee's email first; the onboarding link goes only to them");
    return r;
  });
  let accountId = recipient.stripeAccountId;
  if (!accountId) {
    const account = await stripe.createExpressAccount(
      { email: recipient.email, metadata: { workspace_id: tenant.workspaceId, recipient_id: recipientId } },
      `acct-${recipientId}`,
    );
    accountId = account.id;
    await withTenant(db, tenant, async (q) => {
      await q.query("update money_recipients set stripe_account_id = $2, onboarding_status = $3, destination_changed_at = now() where id = $1 and stripe_account_id is null", [
        recipientId,
        account.id,
        onboardingStatusOf(account),
      ]);
      await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.connect_account_created", recipientId, { account: account.id });
    });
  }
  const link = await stripe.createAccountLink({ account: accountId, ...linkUrls(deps, recipientId) }, `acctlink-${recipientId}-${now.getTime()}`);
  if (opts.email && recipient.email) {
    await sendSystemMail(
      deps.mail,
      [recipient.email],
      "Set up payouts for your collaboration fees",
      `Hello ${recipient.name},\n\nTo receive your share of collaboration commission and fees by transfer, finish setting up a payout account with Stripe, our payments provider:\n\n${link.url}\n\nThe link expires shortly; if it has, open it anyway and you'll be sent a fresh one.`,
    );
  }
  return link.url;
}

export async function refreshRecipient(db: Db, tenant: Tenant, recipientId: string, deps: MoneyDeps) {
  const stripe = requireStripe(deps);
  const r = await withTenant(db, tenant, (q) => repo.getRecipient(q, recipientId));
  if (!r?.stripeAccountId) throw new DomainError("not_found", "This payee has no Stripe account yet");
  const account = await stripe.retrieveAccount(r.stripeAccountId);
  await withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "update payees");
    await saveAccountState(q, account);
  });
  return onboardingStatusOf(account);
}

/** Public: the payee's expired onboarding link (refresh_url) or their return from Stripe (return_url). */
export async function onboardingLinkForRefresh(db: Db, recipientId: string, deps: MoneyDeps, now: Date, done: boolean): Promise<{ redirect: string } | { status: string }> {
  const stripe = requireStripe(deps);
  const r = await withSystem(db, async (q) => {
    const { rows } = await q.query<{ stripe_account_id: string | null }>("select stripe_account_id from money_recipients where id = $1", [recipientId]);
    return rows[0] ?? null;
  });
  if (!r?.stripe_account_id) throw new DomainError("not_found", "Unknown payee");
  if (done) {
    const account = await stripe.retrieveAccount(r.stripe_account_id);
    await withSystem(db, (q) => saveAccountState(q, account));
    return { status: onboardingStatusOf(account) };
  }
  const link = await stripe.createAccountLink({ account: r.stripe_account_id, ...linkUrls(deps, recipientId) }, `acctlink-${recipientId}-${now.getTime()}`);
  return { redirect: link.url };
}

/** Webhook: account.updated. */
export function applyAccountUpdate(q: Queryable, account: StripeAccount): Promise<number> {
  return saveAccountState(q, account);
}
