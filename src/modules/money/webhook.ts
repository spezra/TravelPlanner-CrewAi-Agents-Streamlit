/**
 * Stripe webhooks. The endpoint verifies the signature, stores the event once
 * (event ids dedupe redeliveries and replays) and enqueues processing, so the
 * HTTP reply is fast and a failure in processing retries through the job
 * queue instead of relying on Stripe's redelivery.
 */
import type { Db } from "@/db/client";
import { withSystem } from "@/db/tenant";
import { formatMoney } from "@/domain/common";
import { verifyStripeSignature, type StripeAccount, type StripeCheckoutSession, type StripeEvent, type StripeSetupIntent, type StripeTransfer } from "@/providers/stripe";
import { enqueue } from "@/server/jobs/queue";
import { log } from "@/server/log";
import { paymentMethodFromSetupIntent, storePaymentMethod } from "./cards";
import { ownerEmails, requireStripe, sendSystemMail, type MoneyDeps } from "./deps";
import { applyTransferCreated, applyTransferReversal, notifyReversal } from "./payouts";
import { applyAccountUpdate } from "./recipients";
import * as repo from "./repo";

export type IngestResult = { status: 200; duplicate: boolean; eventId: string } | { status: 400 | 503; error: string };

export async function ingestStripeWebhook(db: Db, rawBody: string, signature: string | null, secret: string | undefined, now: Date): Promise<IngestResult> {
  if (!secret) return { status: 503, error: "Stripe webhooks are not configured" };
  const check = verifyStripeSignature(rawBody, signature, secret, now);
  if (!check.ok) return { status: 400, error: `Invalid signature (${check.reason})` };
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { status: 400, error: "Malformed JSON" };
  }
  if (typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) return { status: 400, error: "Not a Stripe event" };
  return withSystem(db, async (q) => {
    const { rows } = await q.query(
      "insert into money_stripe_events (id, type, account, payload, received_at) values ($1,$2,$3,$4,$5) on conflict (id) do nothing returning id",
      [event.id, event.type, event.account ?? null, rawBody, now.toISOString()],
    );
    if (!rows.length) return { status: 200 as const, duplicate: true, eventId: event.id };
    await enqueue(q, { kind: "money.stripe_event", payload: { eventId: event.id }, dedupeKey: `money.stripe_event:${event.id}` });
    return { status: 200 as const, duplicate: false, eventId: event.id };
  });
}

const HANDLED = new Set(["account.updated", "transfer.created", "transfer.reversed", "payout.failed", "checkout.session.completed", "setup_intent.succeeded"]);

/** Processes one stored event. Idempotent: each handler is, and processed events are skipped. */
export async function processStripeEvent(db: Db, eventId: string, deps: MoneyDeps, now: Date): Promise<string> {
  const event = await withSystem(db, async (q) => {
    const { rows } = await q.query<{ payload: StripeEvent; processed_at: string | null }>("select payload, processed_at from money_stripe_events where id = $1", [eventId]);
    return rows[0] ?? null;
  });
  if (!event) return "missing";
  if (event.processed_at) return "already_processed";
  const e = typeof event.payload === "string" ? (JSON.parse(event.payload) as StripeEvent) : event.payload;
  const outcome = HANDLED.has(e.type) ? await handle(db, e, deps, now) : "ignored";
  await withSystem(db, (q) => q.query("update money_stripe_events set processed_at = $2, outcome = $3 where id = $1", [eventId, now.toISOString(), outcome]));
  log.info({ eventId, type: e.type, outcome }, "stripe event processed");
  return outcome;
}

async function handle(db: Db, e: StripeEvent, deps: MoneyDeps, now: Date): Promise<string> {
  switch (e.type) {
    case "account.updated": {
      const n = await withSystem(db, (q) => applyAccountUpdate(q, e.data.object as unknown as StripeAccount));
      return n ? "recipient_updated" : "unknown_account";
    }
    case "transfer.created": {
      const ws = await withSystem(db, (q) => applyTransferCreated(q, e.data.object as unknown as StripeTransfer, now));
      return ws ? "line_settled" : "no_line";
    }
    case "transfer.reversed": {
      const r = await withSystem(db, (q) => applyTransferReversal(q, e.data.object as unknown as StripeTransfer, now));
      if (!r) return "no_change";
      await notifyReversal(db, deps, r);
      return "adjustment_recorded";
    }
    case "payout.failed": {
      // A connected account's payout to its bank failed: the payee isn't paid even though our transfer settled.
      const payout = e.data.object as { id: string; amount: number; currency: string; failure_message?: string | null; failure_code?: string | null };
      if (!e.account) {
        log.error({ payout: payout.id, code: payout.failure_code }, "platform payout failed");
        return "platform_payout_failed";
      }
      const message = `${payout.failure_message ?? payout.failure_code ?? "Payout failed"} (${formatMoney({ amountMinor: payout.amount, currency: payout.currency.toUpperCase() })})`;
      const hit = await withSystem(db, async (q) => {
        const { rows } = await q.query<{ id: string; workspace_id: string; name: string }>(
          "update money_recipients set last_payout_failure = $2 where stripe_account_id = $1 returning id, workspace_id, name",
          [e.account, message.slice(0, 500)],
        );
        const out: { workspaceId: string; name: string; to: string[] }[] = [];
        for (const r of rows) {
          await repo.audit(q, r.workspace_id, "system:stripe", "money.payee_payout_failed", r.id, { payout: payout.id, code: payout.failure_code ?? null });
          out.push({ workspaceId: r.workspace_id, name: r.name, to: await ownerEmails(q, r.workspace_id) });
        }
        return out;
      });
      for (const h of hit) {
        await sendSystemMail(deps.mail, h.to, `Payout to ${h.name} failed at their bank`, `Stripe could not pay out to ${h.name}'s bank account: ${message}.\nThey need to update their payout details in Stripe; the money stays in their Stripe balance until then.`);
      }
      return hit.length ? "payee_notified" : "unknown_account";
    }
    case "checkout.session.completed": {
      const s = e.data.object as unknown as StripeCheckoutSession;
      if (s.mode !== "setup" || !s.setup_intent) return "ignored";
      const si = typeof s.setup_intent === "string" ? await requireStripe(deps).retrieveSetupIntent(s.setup_intent) : s.setup_intent;
      return saveFromSetupIntent(db, deps, si, s.metadata);
    }
    case "setup_intent.succeeded": {
      const si = e.data.object as unknown as StripeSetupIntent;
      return saveFromSetupIntent(db, deps, si, si.metadata);
    }
  }
  return "ignored";
}

async function saveFromSetupIntent(db: Db, deps: MoneyDeps, si: StripeSetupIntent, metadata: Record<string, string> | undefined): Promise<string> {
  const workspaceId = metadata?.workspace_id;
  const clientId = metadata?.client_id;
  if (!workspaceId || !clientId) return "no_client_metadata";
  const pm = await paymentMethodFromSetupIntent(deps, si);
  if (!pm) return "no_payment_method";
  const saved = await withSystem(db, (q) => storePaymentMethod(q, { workspaceId, clientId, setupId: metadata?.card_setup_id ?? null }, pm));
  return saved ? "card_saved" : "card_already_saved";
}
