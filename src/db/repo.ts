/**
 * Row <-> domain mapping. Every function takes a tenant-bound Queryable from
 * withTenant, so row-level security has already scoped what it can see.
 */
import type { ActionSpec, Approval, MaterialTerms } from "@/domain/approvals";
import type { BookingCredentials, ItemKind, ItemState, TripItem } from "@/domain/bookings";
import type { Commitment, CommitmentState, EvidenceType } from "@/domain/commitments";
import type { LedgerEntry, Person } from "@/domain/crm";
import type { ExecutionAttempt } from "@/domain/execution";
import type { ResponsePlan } from "@/domain/responsePlan";
import type { Queryable } from "./client";

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export interface TripRow {
  id: string;
  ownerId: string;
  ownerName: string;
  clientId: string | null;
  clientName: string | null;
  title: string;
  startsOn: string | null;
  endsOn: string | null;
  scope: "private" | "workspace";
}

export async function listTrips(q: Queryable): Promise<TripRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select t.id, t.owner_id, m.name as owner_name, t.client_id, c.name as client_name, t.title, t.starts_on, t.ends_on, t.scope
       from trips t join members m on m.id = t.owner_id left join clients c on c.id = t.client_id
      order by t.starts_on nulls last, t.title`,
  );
  return rows.map(mapTrip);
}

export async function getTrip(q: Queryable, id: string): Promise<TripRow | null> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select t.id, t.owner_id, m.name as owner_name, t.client_id, c.name as client_name, t.title, t.starts_on, t.ends_on, t.scope
       from trips t join members m on m.id = t.owner_id left join clients c on c.id = t.client_id where t.id = $1`,
    [id],
  );
  return rows[0] ? mapTrip(rows[0]) : null;
}

function mapTrip(r: Record<string, unknown>): TripRow {
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    ownerName: String(r.owner_name),
    clientId: r.client_id ? String(r.client_id) : null,
    clientName: r.client_name ? String(r.client_name) : null,
    title: String(r.title),
    startsOn: day(r.starts_on),
    endsOn: day(r.ends_on),
    scope: r.scope as TripRow["scope"],
  };
}

export async function listItems(q: Queryable, tripId?: string): Promise<TripItem[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from trip_items ${tripId ? "where trip_id = $1" : ""} order by trip_id, position, starts_at nulls last`,
    tripId ? [tripId] : [],
  );
  return rows.map(mapItem);
}

export async function getItem(q: Queryable, id: string): Promise<TripItem | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from trip_items where id = $1", [id]);
  return rows[0] ? mapItem(rows[0]) : null;
}

function mapItem(r: Record<string, unknown>): TripItem {
  return {
    id: String(r.id),
    tripId: String(r.trip_id),
    kind: r.kind as ItemKind,
    title: String(r.title),
    supplierName: (r.supplier_name as string | null) ?? null,
    state: r.state as ItemState,
    price: r.price_minor == null ? null : { amountMinor: Number(r.price_minor), currency: String(r.currency) },
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    credentials: (r.credentials as BookingCredentials | null) ?? null,
    confirmationRef: (r.confirmation_ref as string | null) ?? null,
  };
}

export async function updateItemState(q: Queryable, item: TripItem): Promise<void> {
  await q.query("update trip_items set state = $2, confirmation_ref = $3 where id = $1", [item.id, item.state, item.confirmationRef]);
}

export async function insertItem(q: Queryable, workspaceId: string, it: TripItem, position = 0): Promise<void> {
  await q.query(
    `insert into trip_items (id, workspace_id, trip_id, kind, title, supplier_name, state, price_minor, currency, starts_at, ends_at, credentials, confirmation_ref, position)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      it.id,
      workspaceId,
      it.tripId,
      it.kind,
      it.title,
      it.supplierName,
      it.state,
      it.price?.amountMinor ?? null,
      it.price?.currency ?? null,
      it.startsAt,
      it.endsAt,
      it.credentials ? JSON.stringify(it.credentials) : null,
      it.confirmationRef,
      position,
    ],
  );
}

export async function listApprovals(q: Queryable, filter: { tripId?: string; status?: Approval["status"] } = {}): Promise<Approval[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.tripId) where.push(`trip_id = $${params.push(filter.tripId)}`);
  if (filter.status) where.push(`status = $${params.push(filter.status)}`);
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from approvals ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at`,
    params,
  );
  return rows.map(mapApproval);
}

export async function getApproval(q: Queryable, id: string): Promise<Approval | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from approvals where id = $1", [id]);
  return rows[0] ? mapApproval(rows[0]) : null;
}

function mapApproval(r: Record<string, unknown>): Approval {
  return {
    id: String(r.id),
    tripId: String(r.trip_id),
    actions: r.actions as ActionSpec[],
    terms: r.terms as MaterialTerms,
    termsFingerprint: String(r.terms_fingerprint),
    status: r.status as Approval["status"],
    requestedBy: String(r.requested_by),
    decidedBy: r.decided_by ? String(r.decided_by) : null,
    decidedAt: iso(r.decided_at),
    note: (r.note as string | null) ?? null,
  };
}

export async function insertApproval(q: Queryable, workspaceId: string, a: Approval): Promise<void> {
  await q.query(
    `insert into approvals (id, workspace_id, trip_id, actions, terms, terms_fingerprint, status, requested_by, decided_by, decided_at, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [a.id, workspaceId, a.tripId, JSON.stringify(a.actions), JSON.stringify(a.terms), a.termsFingerprint, a.status, a.requestedBy, a.decidedBy, a.decidedAt, a.note],
  );
}

export async function saveApprovalDecision(q: Queryable, a: Approval): Promise<void> {
  // Guarded on status so two concurrent decisions can't both win.
  const { rows } = await q.query(
    "update approvals set status = $2, decided_by = $3, decided_at = $4, note = $5 where id = $1 and status = 'pending' returning id",
    [a.id, a.status, a.decidedBy, a.decidedAt, a.note],
  );
  if (rows.length !== 1) throw new Error(`Approval ${a.id} was already decided`);
}

export async function listCommitments(q: Queryable, tripId?: string): Promise<Commitment[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from commitments ${tripId ? "where trip_id = $1" : ""} order by due_by nulls last`,
    tripId ? [tripId] : [],
  );
  return rows.map(mapCommitment);
}

function mapCommitment(r: Record<string, unknown>): Commitment {
  return {
    id: String(r.id),
    tripId: r.trip_id ? String(r.trip_id) : null,
    itemId: r.item_id ? String(r.item_id) : null,
    promisor: String(r.promisor),
    promisorPersonId: r.promisor_person_id ? String(r.promisor_person_id) : null,
    promise: String(r.promise),
    conditions: (r.conditions as string | null) ?? null,
    dueBy: iso(r.due_by),
    evidence: r.evidence as EvidenceType,
    evidenceRef: (r.evidence_ref as string | null) ?? null,
    state: r.state as CommitmentState,
    transcriptVerified: Boolean(r.transcript_verified),
    confidence: Number(r.confidence),
    consequential: Boolean(r.consequential),
    reviewStatus: r.review_status as Commitment["reviewStatus"],
    recapSentAt: iso(r.recap_sent_at),
    deliveredToTravelerAt: iso(r.delivered_to_traveler_at),
  };
}

export async function insertCommitment(q: Queryable, workspaceId: string, c: Commitment): Promise<void> {
  await q.query(
    `insert into commitments (id, workspace_id, trip_id, item_id, promisor, promisor_person_id, promise, conditions, due_by, evidence, evidence_ref,
       state, transcript_verified, confidence, consequential, review_status, recap_sent_at, delivered_to_traveler_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      c.id, workspaceId, c.tripId, c.itemId, c.promisor, c.promisorPersonId, c.promise, c.conditions, c.dueBy, c.evidence, c.evidenceRef,
      c.state, c.transcriptVerified, c.confidence, c.consequential, c.reviewStatus, c.recapSentAt, c.deliveredToTravelerAt,
    ],
  );
}

export async function listPeople(q: Queryable): Promise<Person[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from people order by name");
  return rows.map((r) => ({
    id: String(r.id),
    ownerId: String(r.owner_id),
    name: String(r.name),
    roles: r.roles as Person["roles"],
    approach: r.approach as Person["approach"],
    texture: r.texture as string[],
    clientIds: [],
  }));
}

export async function listLedger(q: Queryable, personId?: string): Promise<LedgerEntry[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from ledger_entries ${personId ? "where person_id = $1" : ""} order by at desc`,
    personId ? [personId] : [],
  );
  return rows.map((r) => ({
    id: String(r.id),
    personId: String(r.person_id),
    kind: r.kind as LedgerEntry["kind"],
    at: iso(r.at)!,
    note: String(r.note),
    askType: (r.ask_type as string | null) ?? null,
    roomNights: r.room_nights == null ? null : Number(r.room_nights),
    revenueMinor: r.revenue_minor == null ? null : Number(r.revenue_minor),
  }));
}

export async function getResponsePlan(q: Queryable, tripId: string): Promise<ResponsePlan | null> {
  const { rows } = await q.query<{ plan: ResponsePlan }>("select plan from response_plans where trip_id = $1", [tripId]);
  return rows[0]?.plan ?? null;
}

export async function listPendingPublicationIds(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>("select id from knowledge_items where publication_status = 'awaiting_owner' and owner_id = app_member()");
  return rows.map((r) => r.id);
}

export async function saveAttempt(q: Queryable, workspaceId: string, a: ExecutionAttempt, provider: string): Promise<void> {
  await q.query(
    `insert into execution_attempts (id, workspace_id, item_id, action, idempotency_key, state, provider, provider_ref, attempts, last_error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (workspace_id, idempotency_key) do update
       set state = excluded.state, provider_ref = excluded.provider_ref, attempts = excluded.attempts, last_error = excluded.last_error, updated_at = now()`,
    [a.id, workspaceId, a.itemId, a.action, a.idempotencyKey, a.state, provider, a.providerRef, a.attempts, a.lastError],
  );
}

export async function getAttemptByKey(q: Queryable, key: string): Promise<(ExecutionAttempt & { provider: string }) | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from execution_attempts where idempotency_key = $1", [key]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    idempotencyKey: String(r.idempotency_key),
    action: r.action as ExecutionAttempt["action"],
    itemId: String(r.item_id),
    state: r.state as ExecutionAttempt["state"],
    providerRef: (r.provider_ref as string | null) ?? null,
    attempts: Number(r.attempts),
    lastError: (r.last_error as string | null) ?? null,
    provider: String(r.provider),
  };
}

export async function audit(q: Queryable, workspaceId: string, actor: string, action: string, subject: string, data: unknown = {}): Promise<void> {
  await q.query("insert into audit_events (workspace_id, actor, action, subject, data) values ($1,$2,$3,$4,$5)", [
    workspaceId,
    actor,
    action,
    subject,
    JSON.stringify(data),
  ]);
}
