/**
 * Per-trip response plans and escalation. The plan names a primary, a backup
 * with pre-authorized scoped access to the trip, coverage hours, an
 * acknowledgement deadline, an escalation chain and the client-contact policy.
 * Events that need a human are escalated along that chain, one step per
 * missed deadline, until someone acknowledges.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import type { TripItem } from "@/domain/bookings";
import type { Commitment } from "@/domain/commitments";
import { DomainError, type Id } from "@/domain/common";
import { assertCanAcknowledge, assertCanResolve, escalationCandidates, nextEscalationStep, systemMayResolve, type EscalationKind } from "@/domain/escalation";
import type { ResponsePlan } from "@/domain/responsePlan";
import { backupAccessExpiry, validateResponsePlan } from "@/domain/responsePlanRules";
import { config } from "@/server/config";
import { log } from "@/server/log";
import { SYSTEM_FOOTER, type Mailer } from "@/server/mail";
import { actor, audit, day, iso, str } from "./common";

async function loadTrip(q: Queryable, tripId: string) {
  const t = (await q.query<Record<string, unknown>>("select id, owner_id, title, ends_on from trips where id = $1", [tripId])).rows[0];
  if (!t) throw new DomainError("not_found", "Trip not found");
  return { id: String(t.id), ownerId: String(t.owner_id), title: String(t.title), endsOn: day(t.ends_on) };
}

async function loadPlan(q: Queryable, tripId: string): Promise<ResponsePlan | null> {
  const { rows } = await q.query<{ plan: ResponsePlan }>("select plan from response_plans where trip_id = $1", [tripId]);
  return rows[0]?.plan ?? null;
}

export interface PlanEditorData {
  trip: { id: string; title: string; ownerId: string; endsOn: string | null };
  plan: ResponsePlan | null;
  members: { id: string; name: string; role: string; timeZone: string }[];
  backupDelegation: { memberId: string; expiresAt: string | null } | null;
  canEdit: boolean;
  escalations: EscalationRow[];
}

export interface EscalationRow {
  id: string;
  kind: EscalationKind;
  title: string;
  detail: string;
  raisedAt: string;
  raisedBy: string;
  step: number;
  tried: Id[];
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

function mapEscalation(r: Record<string, unknown>): EscalationRow {
  return {
    id: String(r.id),
    kind: r.kind as EscalationKind,
    title: String(r.title),
    detail: String(r.detail),
    raisedAt: iso(r.raised_at)!,
    raisedBy: String(r.raised_by),
    step: Number(r.step),
    tried: (r.tried as Id[]) ?? [],
    acknowledgedAt: iso(r.acknowledged_at),
    acknowledgedBy: str(r.acknowledged_by),
    resolvedAt: iso(r.resolved_at),
    resolvedBy: str(r.resolved_by),
    resolutionNote: str(r.resolution_note),
  };
}

const canEditPlan = (me: { id: string; role: string }, trip: { ownerId: string }) => me.id === trip.ownerId || me.role === "owner" || me.role === "admin";

export async function planEditor(db: Db, tenant: Tenant, tripId: string): Promise<PlanEditorData | null> {
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    const t = (await q.query<Record<string, unknown>>("select id, owner_id, title, ends_on from trips where id = $1", [tripId])).rows[0];
    if (!t) return null;
    const trip = { id: String(t.id), ownerId: String(t.owner_id), title: String(t.title), endsOn: day(t.ends_on) };
    const members = (
      await q.query<{ id: string; name: string; role: string; time_zone: string }>("select id, name, role, time_zone from members where disabled_at is null order by name")
    ).rows.map((m) => ({ id: m.id, name: m.name, role: m.role, timeZone: m.time_zone }));
    const deleg = (await q.query<Record<string, unknown>>("select member_id, expires_at from trip_delegations where trip_id = $1 and purpose = 'backup'", [tripId])).rows[0];
    const escalations = (
      await q.query<Record<string, unknown>>("select * from escalations where trip_id = $1 order by resolved_at nulls first, raised_at desc limit 50", [tripId])
    ).rows.map(mapEscalation);
    return {
      trip,
      plan: await loadPlan(q, tripId),
      members,
      backupDelegation: deleg ? { memberId: String(deleg.member_id), expiresAt: iso(deleg.expires_at) } : null,
      canEdit: canEditPlan(me, trip),
      escalations,
    };
  });
}

/**
 * Save the plan. Naming a backup grants (or extends) their scoped access to
 * this trip until a week after it ends; replacing a backup revokes the
 * previous one's backup access.
 */
export async function saveResponsePlan(db: Db, tenant: Tenant, plan: ResponsePlan): Promise<ResponsePlan> {
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    const trip = await loadTrip(q, plan.tripId);
    if (!canEditPlan(me, trip)) throw new DomainError("forbidden", "Only the trip owner or a workspace owner/admin can change the response plan");
    const active = (await q.query<{ id: string }>("select id from members where disabled_at is null")).rows.map((r) => r.id);
    const valid = validateResponsePlan(plan, active);
    const previous = await loadPlan(q, plan.tripId);

    await q.query(
      `insert into response_plans (trip_id, workspace_id, plan) values ($1, $2, $3)
       on conflict (trip_id) do update set plan = excluded.plan`,
      [plan.tripId, tenant.workspaceId, JSON.stringify(valid)],
    );

    let granted: { memberId: string; expiresAt: string } | null = null;
    if (valid.backup) {
      const expiresAt = backupAccessExpiry(trip.endsOn).toISOString();
      // Extend, never shorten: an existing longer (or open-ended) delegation stays as it is.
      await q.query(
        `insert into trip_delegations (trip_id, workspace_id, member_id, purpose, expires_at) values ($1, $2, $3, 'backup', $4)
         on conflict (trip_id, member_id) do update
           set expires_at = case when trip_delegations.expires_at is null then null else greatest(trip_delegations.expires_at, excluded.expires_at) end`,
        [plan.tripId, tenant.workspaceId, valid.backup.memberId, expiresAt],
      );
      granted = { memberId: valid.backup.memberId, expiresAt };
    }
    const revoked = (
      await q.query<{ member_id: string }>("delete from trip_delegations where trip_id = $1 and purpose = 'backup' and member_id <> $2 returning member_id", [
        plan.tripId,
        valid.backup?.memberId ?? "00000000-0000-0000-0000-000000000000",
      ])
    ).rows.map((r) => r.member_id);

    await audit(q, tenant, "response_plan.saved", plan.tripId, {
      primary: valid.primary.memberId,
      backup: valid.backup?.memberId ?? null,
      previousBackup: previous?.backup?.memberId ?? null,
      ackDeadlineMinutes: valid.ackDeadlineMinutes,
      escalation: valid.escalation,
      delegationGranted: granted,
      delegationRevoked: revoked,
    });
    return valid;
  });
}

// ---------------------------------------------------------------------------
// Escalation

/** A member reports an unhappy client. It escalates like any event and only a person can close it. */
export async function raiseUnhappyClient(db: Db, tenant: Tenant, tripId: string, summary: string, now: Date): Promise<string> {
  const text = summary.trim();
  if (text.length < 3) throw new DomainError("bad_summary", "Say what the client is unhappy about");
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const trip = await loadTrip(q, tripId);
    const id = randomUUID();
    await q.query(
      `insert into escalations (id, workspace_id, trip_id, source_key, kind, title, detail, raised_at, raised_by)
       values ($1, $2, $3, $4, 'unhappy_client', $5, $6, $7, $8)`,
      [id, tenant.workspaceId, tripId, `unhappy_client:${id}`, `Unhappy client: ${trip.title}`, text, now.toISOString(), tenant.memberId],
    );
    await audit(q, tenant, "escalation.raised", id, { tripId, kind: "unhappy_client" });
    return id;
  });
}

export async function acknowledgeEscalation(db: Db, tenant: Tenant, escalationId: string, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    const e = (await q.query<Record<string, unknown>>("select * from escalations where id = $1 for update", [escalationId])).rows[0];
    if (!e) throw new DomainError("not_found", "Escalation not found");
    const esc = mapEscalation(e);
    const trip = await loadTrip(q, String(e.trip_id));
    assertCanAcknowledge(me, trip, await loadPlan(q, trip.id), esc.tried);
    if (esc.resolvedAt) throw new DomainError("closed", "Already closed");
    if (esc.acknowledgedAt) return;
    await q.query("update escalations set acknowledged_at = $2, acknowledged_by = $3 where id = $1 and acknowledged_at is null", [escalationId, now.toISOString(), me.id]);
    await audit(q, tenant, "escalation.acknowledged", escalationId, { step: esc.step, tried: esc.tried });
  });
}

export async function resolveEscalation(db: Db, tenant: Tenant, escalationId: string, note: string, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    const e = (await q.query<Record<string, unknown>>("select * from escalations where id = $1 for update", [escalationId])).rows[0];
    if (!e) throw new DomainError("not_found", "Escalation not found");
    const esc = mapEscalation(e);
    if (esc.resolvedAt) throw new DomainError("closed", "Already closed");
    const trip = await loadTrip(q, String(e.trip_id));
    assertCanResolve(esc.kind, me, trip, await loadPlan(q, trip.id), note);
    await q.query(
      `update escalations set resolved_at = $2, resolved_by = $3, resolution_note = $4,
              acknowledged_at = coalesce(acknowledged_at, $2), acknowledged_by = coalesce(acknowledged_by, $5::uuid)
        where id = $1`,
      [escalationId, now.toISOString(), me.id, note.trim() || null, me.id],
    );
    await audit(q, tenant, "escalation.resolved", escalationId, { kind: esc.kind });
  });
}

function mapItem(r: Record<string, unknown>): TripItem {
  return {
    id: String(r.id),
    tripId: String(r.trip_id),
    kind: r.kind as TripItem["kind"],
    title: String(r.title),
    supplierName: str(r.supplier_name),
    state: r.state as TripItem["state"],
    price: r.price_minor == null ? null : { amountMinor: Number(r.price_minor), currency: String(r.currency) },
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    credentials: null,
    confirmationRef: str(r.confirmation_ref),
  };
}

function mapCommitment(r: Record<string, unknown>): Commitment {
  return {
    id: String(r.id),
    tripId: str(r.trip_id),
    itemId: str(r.item_id),
    promisor: String(r.promisor),
    promisorPersonId: str(r.promisor_person_id),
    promise: String(r.promise),
    conditions: str(r.conditions),
    dueBy: iso(r.due_by),
    evidence: r.evidence as Commitment["evidence"],
    evidenceRef: str(r.evidence_ref),
    state: r.state as Commitment["state"],
    transcriptVerified: Boolean(r.transcript_verified),
    confidence: Number(r.confidence),
    consequential: Boolean(r.consequential),
    // Only overdue-ness matters here; review routing is the Today page's concern.
    reviewStatus: "reviewed",
    recapSentAt: iso(r.recap_sent_at),
    deliveredToTravelerAt: iso(r.delivered_to_traveler_at),
  };
}

export interface EscalationRunResult {
  raised: number;
  autoResolved: number;
  notified: { escalationId: string; memberId: string; step: number }[];
}

/**
 * The ops.escalate job. Platform work across workspaces (withSystem), so
 * every statement names its workspace explicitly.
 *   1. Raise an event for each open condition (outcome unknown, disruption,
 *      overdue commitment) and close events whose cause has cleared, except
 *      unhappy clients, which only a person closes.
 *   2. For each unacknowledged event, notify the next responder when their
 *      step is due. The notification row is the dedupe: one per responder.
 *   3. Send the emails after the claims commit; a row stays unsent until its
 *      email goes, so a failed send is retried on the next run.
 */
export async function runEscalations(db: Db, mail: Mailer, now: Date): Promise<EscalationRunResult> {
  const result: EscalationRunResult = { raised: 0, autoResolved: 0, notified: [] };
  await withSystem(db, async (q) => {
    const live = "(select id from workspaces where deleted_at is null)";
    const items = (await q.query<Record<string, unknown>>(`select * from trip_items where state in ('outcome_unknown', 'disrupted') and workspace_id in ${live}`)).rows;
    const commitments = (
      await q.query<Record<string, unknown>>(
        `select * from commitments where state in ('pending', 'disputed') and due_by < $1 and trip_id is not null and workspace_id in ${live}`,
        [now.toISOString()],
      )
    ).rows;
    const wsOf = new Map<string, string>();
    for (const r of [...items, ...commitments]) wsOf.set(String(r.trip_id), String(r.workspace_id));
    const candidates = escalationCandidates(items.map(mapItem), commitments.map(mapCommitment), now);
    const openKeys = new Set(candidates.map((c) => `${wsOf.get(c.tripId)}|${c.sourceKey}`));

    for (const c of candidates) {
      const { rows } = await q.query(
        `insert into escalations (id, workspace_id, trip_id, source_key, kind, title, detail, raised_at, raised_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'system')
         on conflict (workspace_id, source_key) where resolved_at is null do nothing returning id`,
        [randomUUID(), wsOf.get(c.tripId), c.tripId, c.sourceKey, c.kind, c.title, c.detail, now.toISOString()],
      );
      if (rows.length) result.raised++;
    }

    const open = (await q.query<Record<string, unknown>>(`select * from escalations where resolved_at is null and workspace_id in ${live}`)).rows;
    for (const r of open) {
      const kind = r.kind as EscalationKind;
      if (systemMayResolve(kind) && !openKeys.has(`${String(r.workspace_id)}|${String(r.source_key)}`)) {
        await q.query("update escalations set resolved_at = $2, resolved_by = 'system', resolution_note = 'Cause cleared' where id = $1", [r.id, now.toISOString()]);
        await audit(q, { workspaceId: String(r.workspace_id), memberId: null }, "escalation.auto_resolved", String(r.id), { kind }, "system:escalation");
        result.autoResolved++;
        continue;
      }
      if (r.acknowledged_at) continue;
      const trip = (await q.query<{ owner_id: string }>("select owner_id from trips where id = $1", [r.trip_id])).rows[0];
      if (!trip) continue;
      const plan = (await q.query<{ plan: ResponsePlan }>("select plan from response_plans where trip_id = $1", [r.trip_id])).rows[0]?.plan ?? null;
      const esc = mapEscalation(r);
      const next = nextEscalationStep(plan, trip.owner_id, { kind, raisedAt: esc.raisedAt, lastNotifiedAt: iso(r.last_notified_at), tried: esc.tried, acknowledgedAt: null, resolvedAt: null }, now);
      if (!next) continue;
      const claimed = await q.query(
        `insert into escalation_notifications (escalation_id, workspace_id, member_id, step, role) values ($1, $2, $3, $4, $5)
         on conflict (escalation_id, member_id) do nothing returning member_id`,
        [esc.id, r.workspace_id, next.memberId, next.step, next.role],
      );
      // Tried is updated even when the claim already existed, so a half-finished run converges.
      await q.query(
        "update escalations set tried = $2, step = $3, last_notified_at = $4 where id = $1",
        [esc.id, JSON.stringify([...esc.tried, next.memberId]), next.step, now.toISOString()],
      );
      if (claimed.rows.length) {
        await audit(q, { workspaceId: String(r.workspace_id), memberId: null }, "escalation.notified", esc.id, { memberId: next.memberId, step: next.step, role: next.role }, "system:escalation");
      }
    }
  });

  // Emails go out after the claims commit.
  const pending = await withSystem(db, (q) =>
    q.query<Record<string, unknown>>(
      `select n.escalation_id, n.member_id, n.step, n.role, m.email, m.name, e.title, e.detail, e.kind, e.trip_id
         from escalation_notifications n
         join escalations e on e.id = n.escalation_id
         join members m on m.id = n.member_id
        where n.sent_at is null and e.resolved_at is null and e.acknowledged_at is null and m.disabled_at is null`,
    ),
  );
  for (const p of pending.rows) {
    const link = `${config().APP_URL}/trips/${String(p.trip_id)}/plan`;
    const urgent = p.kind === "unhappy_client" ? "An unhappy client needs a person to respond. The system will not reply to them." : "This needs a person.";
    try {
      await mail.send({
        to: String(p.email),
        subject: `Needs a response: ${String(p.title)}`,
        text: `${String(p.name)},\n\n${urgent}\n\n${String(p.title)}\n${String(p.detail)}\n\nYou're being contacted as ${String(p.role)} (step ${Number(p.step) + 1}). Acknowledge here so it stops escalating:\n${link}${SYSTEM_FOOTER}`,
      });
      await withSystem(db, (q) => q.query("update escalation_notifications set sent_at = $3 where escalation_id = $1 and member_id = $2", [p.escalation_id, p.member_id, now.toISOString()]));
      result.notified.push({ escalationId: String(p.escalation_id), memberId: String(p.member_id), step: Number(p.step) });
    } catch (err) {
      log.warn({ escalationId: p.escalation_id, err: err instanceof Error ? err.message : String(err) }, "escalation email failed; will retry");
    }
  }
  return result;
}
