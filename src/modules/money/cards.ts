/**
 * Card vault. Card numbers never reach the platform: the client enters them on
 * a Stripe-hosted Checkout page in setup mode, and the webhook stores only the
 * payment-method id with its brand, last four digits and expiry, linked to the
 * client. That keeps the platform out of PCI scope for card data.
 */
import type { Db, Queryable } from "@/db/client";
import { withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import type { StripePaymentMethod, StripeSetupIntent } from "@/providers/stripe";
import { requireRole, requireStripe, sendSystemMail, WRITERS, type MoneyDeps } from "./deps";
import * as repo from "./repo";

/**
 * Creates a Stripe customer for the client (once) and a Checkout session in
 * setup mode; returns the hosted URL to send to the client. Assistants may
 * prepare this: collecting a card spends nothing.
 */
export async function createCardSetupLink(db: Db, tenant: Tenant, input: { clientId: string; email: string | null }, deps: MoneyDeps, now: Date): Promise<string> {
  const stripe = requireStripe(deps);
  const prep = await withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<{ name: string }>("select name from clients where id = $1", [input.clientId]);
    if (!rows[0]) throw new DomainError("not_found", "Client not found");
    const { rows: cust } = await q.query<{ stripe_customer_id: string }>("select stripe_customer_id from money_stripe_customers where client_id = $1", [input.clientId]);
    const { rows: setup } = await q.query<{ id: string }>(
      "insert into money_card_setups (workspace_id, client_id, created_by, created_at) values ($1,$2,$3,$4) returning id",
      [tenant.workspaceId, input.clientId, tenant.memberId, now.toISOString()],
    );
    return { clientName: rows[0].name, customerId: cust[0]?.stripe_customer_id ?? null, setupId: setup[0]!.id };
  });
  const metadata = { workspace_id: tenant.workspaceId, client_id: input.clientId, card_setup_id: prep.setupId };
  let customerId = prep.customerId;
  if (!customerId) {
    const customer = await stripe.createCustomer({ name: prep.clientName, email: input.email, metadata: { workspace_id: tenant.workspaceId, client_id: input.clientId } }, `customer-${input.clientId}`);
    customerId = customer.id;
    await withTenant(db, tenant, (q) =>
      q.query("insert into money_stripe_customers (client_id, workspace_id, stripe_customer_id) values ($1,$2,$3) on conflict (client_id) do nothing", [input.clientId, tenant.workspaceId, customer.id]),
    );
  }
  const session = await stripe.createSetupCheckoutSession(
    {
      customer: customerId,
      successUrl: `${deps.appUrl}/api/webhooks/stripe/setup-complete?status=done`,
      cancelUrl: `${deps.appUrl}/api/webhooks/stripe/setup-complete?status=canceled`,
      metadata,
    },
    `card-setup-${prep.setupId}`,
  );
  if (!session.url) throw new DomainError("stripe_error", "Stripe did not return a checkout link");
  await withTenant(db, tenant, async (q) => {
    await q.query("update money_card_setups set checkout_session_id = $2, url = $3 where id = $1", [prep.setupId, session.id, session.url]);
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.card_setup_link", input.clientId, { session: session.id, emailed: Boolean(input.email) });
  });
  if (input.email) {
    await sendSystemMail(
      deps.mail,
      [input.email],
      "Securely save a card for your upcoming travel",
      `Your travel advisor has asked you to save a card for bookings. Card details are entered on Stripe's secure page and never shared with anyone else:\n\n${session.url}\n\nThe link expires in 24 hours.`,
    );
  }
  return session.url;
}

/**
 * Stores a saved card's token and display metadata (webhook, app_system).
 * Deliberately narrow: only these fields are ever written.
 */
export async function storePaymentMethod(q: Queryable, meta: { workspaceId: string; clientId: string; setupId: string | null }, pm: StripePaymentMethod): Promise<boolean> {
  if (pm.type !== "card" || !pm.card || !pm.customer) return false;
  // Check the client really belongs to the workspace named in the metadata before linking anything to it.
  // ...and that the card sits on the Stripe customer we created for that client.
  const { rows: ok } = await q.query(
    "select 1 from clients c join money_stripe_customers sc on sc.client_id = c.id where c.id = $1 and c.workspace_id = $2 and sc.stripe_customer_id = $3",
    [meta.clientId, meta.workspaceId, pm.customer],
  );
  if (!ok.length) return false;
  const { rows } = await q.query(
    `insert into money_payment_methods (workspace_id, client_id, stripe_customer_id, stripe_payment_method_id, brand, last4, exp_month, exp_year)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (stripe_payment_method_id) do nothing returning id`,
    [meta.workspaceId, meta.clientId, pm.customer, pm.id, pm.card.brand, pm.card.last4, pm.card.exp_month, pm.card.exp_year],
  );
  if (meta.setupId) await q.query("update money_card_setups set status = 'completed' where id = $1 and workspace_id = $2", [meta.setupId, meta.workspaceId]);
  if (rows.length) await repo.audit(q, meta.workspaceId, "system:stripe", "money.card_saved", meta.clientId, { brand: pm.card.brand, last4: pm.card.last4 });
  return rows.length > 0;
}

export async function paymentMethodFromSetupIntent(deps: MoneyDeps, si: StripeSetupIntent): Promise<StripePaymentMethod | null> {
  if (!si.payment_method) return null;
  if (typeof si.payment_method !== "string") return si.payment_method;
  return requireStripe(deps).retrievePaymentMethod(si.payment_method);
}

export async function removePaymentMethod(db: Db, tenant: Tenant, id: string, deps: MoneyDeps, now: Date) {
  const pm = await withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "remove saved cards");
    const { rows } = await q.query<{ stripe_payment_method_id: string; client_id: string }>(
      "select stripe_payment_method_id, client_id from money_payment_methods where id = $1 and removed_at is null",
      [id],
    );
    if (!rows[0]) throw new DomainError("not_found", "Card not found");
    return rows[0];
  });
  if (deps.stripe) await deps.stripe.detachPaymentMethod(pm.stripe_payment_method_id, `detach-${pm.stripe_payment_method_id}`);
  await withTenant(db, tenant, async (q) => {
    await q.query("update money_payment_methods set removed_at = $2 where id = $1", [id, now.toISOString()]);
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.card_removed", pm.client_id, { id });
  });
}
