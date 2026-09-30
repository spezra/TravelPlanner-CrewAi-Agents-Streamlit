/**
 * Inbound Duffel webhooks. Verified by signature, deduplicated by event id,
 * located with withSystem (the only cross-tenant step: which workspace and
 * trip does this order belong to?), then applied with withTenant acting as the
 * trip owner, through the item state machine, with an audit event.
 *
 *  - order.airline_initiated_change_detected: the booking becomes 'disrupted'
 *    and lands in the owner's attention queue with the whole trip in view.
 *  - order.created: if our booking was left outcome-unknown, this is the
 *    reconciliation (matched on the idempotency key in the order's metadata).
 *  - order.updated: a cancellation we asked for completes; one we didn't ask
 *    for is a disruption; a new booking reference is recorded.
 */
import { transitionItem, type TripItem } from "@/domain/bookings";
import type { Db } from "@/db/client";
import * as coreRepo from "@/db/repo";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { eventOrderId, IDEMPOTENCY_METADATA_KEY, verifyDuffelSignature, type DuffelWebhookEvent } from "@/providers/duffel";
import { log } from "@/server/log";
import * as repo from "./repo";

export interface WebhookResult {
  status: number;
  body: { ok: boolean; result?: string; error?: string };
}

/** A processing claim older than this is assumed abandoned (crashed handler) and taken over. */
const PROCESSING_LEASE_MS = 5 * 60_000;

export async function handleDuffelWebhook(db: Db, input: { rawBody: string; signature: string | null; secret: string; now: Date }): Promise<WebhookResult> {
  const check = verifyDuffelSignature(input.signature, input.rawBody, input.secret, input.now);
  if (!check.ok) return { status: 401, body: { ok: false, error: `signature ${check.reason}` } };

  let event: DuffelWebhookEvent;
  try {
    event = JSON.parse(input.rawBody) as DuffelWebhookEvent;
  } catch {
    return { status: 400, body: { ok: false, error: "invalid JSON" } };
  }
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") return { status: 400, body: { ok: false, error: "missing id or type" } };

  const claim = await claimEvent(db, event, input.now);
  if (claim !== "claimed") return { status: claim === "busy" ? 409 : 200, body: { ok: true, result: claim } };

  try {
    const { result, workspaceId } = await applyEvent(db, event);
    await withSystem(db, (q) =>
      q.query("update provider_webhook_events set status = $3, workspace_id = $4, processed_at = $5 where provider = 'duffel' and event_id = $1 and event_type = $2", [
        event.id,
        event.type,
        result === "ignored" ? "ignored" : "processed",
        workspaceId,
        input.now.toISOString(),
      ]),
    );
    return { status: 200, body: { ok: true, result } };
  } catch (err) {
    // Release the claim so Duffel's retry is processed.
    await withSystem(db, (q) => q.query("delete from provider_webhook_events where provider = 'duffel' and event_id = $1 and status = 'processing'", [event.id]));
    log.error({ eventType: event.type, err: err instanceof Error ? err.message : String(err) }, "duffel webhook failed");
    return { status: 500, body: { ok: false, error: "processing failed" } };
  }
}

async function claimEvent(db: Db, event: DuffelWebhookEvent, now: Date): Promise<"claimed" | "duplicate" | "busy"> {
  return withSystem(db, async (q) => {
    const inserted = await q.query(
      `insert into provider_webhook_events (provider, event_id, event_type, received_at) values ('duffel', $1, $2, $3)
       on conflict (provider, event_id) do nothing returning event_id`,
      [event.id, event.type, now.toISOString()],
    );
    if (inserted.rows.length === 1) return "claimed";
    const { rows } = await q.query<{ status: string; received_at: unknown }>(
      "select status, received_at from provider_webhook_events where provider = 'duffel' and event_id = $1 for update",
      [event.id],
    );
    const row = rows[0];
    if (!row || row.status !== "processing") return "duplicate";
    if (now.getTime() - new Date(String(row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at)).getTime() < PROCESSING_LEASE_MS) return "busy";
    await q.query("update provider_webhook_events set received_at = $2 where provider = 'duffel' and event_id = $1", [event.id, now.toISOString()]);
    return "claimed";
  });
}

interface Located {
  workspaceId: string;
  itemId: string;
  owner: Tenant;
  attemptKey: string | null;
}

/** Platform step: which workspace, item and trip owner does this order belong to? */
async function locate(db: Db, orderId: string | null, key: string | null): Promise<Located | null> {
  if (!orderId && !key) return null;
  return withSystem(db, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>(
      `select i.workspace_id, i.id as item_id, t.owner_id, a.idempotency_key
         from trip_items i
         join trips t on t.id = i.trip_id
         left join execution_attempts a on a.item_id = i.id and a.provider = 'duffel' and a.action = 'book'
        where (i.provider = 'duffel' and i.provider_ref = $1)
           or (a.provider_ref = $1)
           or (a.idempotency_key = $2)
        order by a.updated_at desc nulls last
        limit 1`,
      [orderId, key],
    );
    const r = rows[0];
    if (!r) return null;
    const workspaceId = String(r.workspace_id);
    return {
      workspaceId,
      itemId: String(r.item_id),
      owner: { workspaceId, memberId: String(r.owner_id) },
      attemptKey: r.idempotency_key ? String(r.idempotency_key) : null,
    };
  });
}

type Applied = { result: string; workspaceId: string | null };

async function applyEvent(db: Db, event: DuffelWebhookEvent): Promise<Applied> {
  const obj = event.data?.object ?? {};
  const orderId = eventOrderId(event);
  const metadata = (obj.metadata ?? null) as Record<string, string> | null;
  const key = event.type === "order.created" ? (metadata?.[IDEMPOTENCY_METADATA_KEY] ?? null) : null;
  const handled = ["order.airline_initiated_change_detected", "order.created", "order.updated"];
  if (!handled.includes(event.type)) return { result: "ignored", workspaceId: null };

  const where = await locate(db, orderId, key);
  if (!where) return { result: "ignored", workspaceId: null };

  const result = await withTenant(db, where.owner, async (q) => {
    const item = await coreRepo.getItem(q, where.itemId);
    if (!item) return "ignored";
    const audit = (action: string, data: Record<string, unknown>) =>
      coreRepo.audit(q, where.workspaceId, "system:duffel", action, item.id, { eventId: event.id, orderId, ...data });
    const move = async (to: TripItem["state"], ref?: string | null) => {
      const next = { ...transitionItem(item, to), confirmationRef: ref === undefined ? item.confirmationRef : ref };
      await coreRepo.updateItemState(q, next);
      return next;
    };

    switch (event.type) {
      case "order.airline_initiated_change_detected": {
        const changeId = typeof obj.id === "string" ? obj.id : null;
        if (item.state === "confirmed") {
          await move("disrupted");
          await repo.setExecutionNote(q, item.id, "The airline changed this flight. Review the whole trip: accept the change, rebook or cancel.");
          await audit("booking.disrupted", { changeId, source: "airline_initiated_change" });
          return "disrupted";
        }
        await audit("booking.airline_change_noted", { changeId, state: item.state });
        return "noted";
      }

      case "order.created": {
        if (!orderId || !key || where.attemptKey !== key) return "ignored";
        if (item.state !== "outcome_unknown" && item.state !== "booking") return "noted";
        const attempt = await coreRepo.getAttemptByKey(q, key);
        if (attempt) await coreRepo.saveAttempt(q, where.workspaceId, { ...attempt, state: "succeeded", providerRef: orderId, lastError: null }, "duffel");
        const pnr = typeof obj.booking_reference === "string" ? obj.booking_reference : orderId;
        await move("confirmed", pnr);
        await repo.setProviderRef(q, item.id, "duffel", orderId);
        await repo.setExecutionNote(q, item.id, null);
        await audit("booking.reconciled", { result: "succeeded", via: "webhook" });
        return "confirmed";
      }

      case "order.updated": {
        const cancelled = typeof obj.cancelled_at === "string" && obj.cancelled_at.length > 0;
        if (cancelled && item.state === "cancel_requested") {
          const attempt = await repo.latestAttempt(q, item.id, "cancel");
          if (attempt && attempt.state !== "succeeded") await repo.setAttemptState(q, attempt.id, "succeeded", null);
          await move("canceled");
          await repo.setExecutionNote(q, item.id, null);
          await audit("cancellation.confirmed", { via: "webhook" });
          return "canceled";
        }
        if (cancelled && item.state === "confirmed") {
          // Cancelled outside the platform: a person decides what that means for the trip.
          await move("disrupted");
          await repo.setExecutionNote(q, item.id, "This order was cancelled outside the platform. Check with the client and airline.");
          await audit("booking.disrupted", { source: "cancelled_outside_platform" });
          return "disrupted";
        }
        const pnr = typeof obj.booking_reference === "string" ? obj.booking_reference : null;
        if (pnr && item.state === "confirmed" && pnr !== item.confirmationRef) {
          await coreRepo.updateItemState(q, { ...item, confirmationRef: pnr });
          await audit("booking.reference_updated", { from: item.confirmationRef, to: pnr });
          return "updated";
        }
        await audit("booking.supplier_updated", { state: item.state });
        return "noted";
      }
    }
    return "ignored";
  });
  return { result, workspaceId: where.workspaceId };
}
