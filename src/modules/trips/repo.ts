/**
 * Persistence for the trips slice. Every function takes a Queryable from
 * withTenant (row-level security already applied) unless its name says System.
 */
import type { Approval } from "@/domain/approvals";
import type { TripItem } from "@/domain/bookings";
import type { ExecutionAttempt } from "@/domain/execution";
import type { ClientAcceptance } from "@/domain/portal";
import type { Queryable } from "@/db/client";
import type { OfferSnapshot } from "@/providers/duffel";

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

// ---------------------------------------------------------------------------
// Trips

export interface TripInput {
  title: string;
  clientId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  scope: "private" | "workspace";
}

export async function insertTrip(q: Queryable, workspaceId: string, id: string, ownerId: string, t: TripInput): Promise<void> {
  await q.query(
    `insert into trips (id, workspace_id, owner_id, client_id, title, starts_on, ends_on, scope) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, workspaceId, ownerId, t.clientId, t.title, t.startsOn, t.endsOn, t.scope],
  );
}

export async function updateTrip(q: Queryable, id: string, t: TripInput): Promise<void> {
  await q.query(`update trips set client_id = $2, title = $3, starts_on = $4, ends_on = $5, scope = $6 where id = $1`, [
    id,
    t.clientId,
    t.title,
    t.startsOn,
    t.endsOn,
    t.scope,
  ]);
}

export async function clientVisible(q: Queryable, clientId: string): Promise<boolean> {
  return (await q.query("select 1 from clients where id = $1", [clientId])).rows.length === 1;
}

export async function listClients(q: Queryable): Promise<{ id: string; name: string }[]> {
  return (await q.query<{ id: string; name: string }>("select id, name from clients order by name")).rows;
}

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: "owner" | "advisor" | "assistant" | "admin";
  timeZone: string;
  active: boolean;
}

export async function listMembers(q: Queryable): Promise<MemberRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select id, name, email, role, time_zone, disabled_at from members order by name");
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    email: String(r.email),
    role: r.role as MemberRow["role"],
    timeZone: String(r.time_zone),
    active: r.disabled_at == null,
  }));
}

export async function getMember(q: Queryable, id: string): Promise<MemberRow | null> {
  return (await listMembers(q)).find((m) => m.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Delegations

export interface DelegationRow {
  memberId: string;
  memberName: string;
  purpose: "backup" | "assistant" | "collaboration";
  expiresAt: string | null;
}

export async function listDelegations(q: Queryable, tripId: string): Promise<DelegationRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select d.member_id, m.name, d.purpose, d.expires_at from trip_delegations d join members m on m.id = d.member_id
      where d.trip_id = $1 order by d.expires_at nulls last`,
    [tripId],
  );
  return rows.map((r) => ({ memberId: String(r.member_id), memberName: String(r.name), purpose: r.purpose as DelegationRow["purpose"], expiresAt: iso(r.expires_at) }));
}

export async function upsertDelegation(q: Queryable, workspaceId: string, tripId: string, memberId: string, purpose: "backup" | "assistant", expiresAt: string): Promise<void> {
  await q.query(
    `insert into trip_delegations (trip_id, workspace_id, member_id, purpose, expires_at) values ($1,$2,$3,$4,$5)
     on conflict (trip_id, member_id) do update set purpose = excluded.purpose, expires_at = excluded.expires_at`,
    [tripId, workspaceId, memberId, purpose, expiresAt],
  );
}

export async function deleteDelegation(q: Queryable, tripId: string, memberId: string): Promise<boolean> {
  return (await q.query("delete from trip_delegations where trip_id = $1 and member_id = $2 returning member_id", [tripId, memberId])).rows.length === 1;
}

// ---------------------------------------------------------------------------
// Items

export interface ItemExtras {
  provider: string | null;
  providerRef: string | null;
  bookingOffer: OfferSnapshot | null;
  bookingRequestEnc: string | null;
  internalNotesEnc: string | null;
  executionRequestedAt: string | null;
  lastExecutionNote: string | null;
}

const EXTRAS_COLUMNS = "id, provider, provider_ref, booking_offer, booking_request_enc, internal_notes_enc, execution_requested_at, last_execution_note";

function mapExtras(r: Record<string, unknown>): ItemExtras {
  return {
    provider: (r.provider as string | null) ?? null,
    providerRef: (r.provider_ref as string | null) ?? null,
    bookingOffer: (r.booking_offer as OfferSnapshot | null) ?? null,
    bookingRequestEnc: (r.booking_request_enc as string | null) ?? null,
    internalNotesEnc: (r.internal_notes_enc as string | null) ?? null,
    executionRequestedAt: iso(r.execution_requested_at),
    lastExecutionNote: (r.last_execution_note as string | null) ?? null,
  };
}

export async function getItemExtras(q: Queryable, itemId: string): Promise<ItemExtras | null> {
  const { rows } = await q.query<Record<string, unknown>>(`select ${EXTRAS_COLUMNS} from trip_items where id = $1`, [itemId]);
  return rows[0] ? mapExtras(rows[0]) : null;
}

export async function listItemExtras(q: Queryable, tripId: string): Promise<Map<string, ItemExtras>> {
  const { rows } = await q.query<Record<string, unknown>>(`select ${EXTRAS_COLUMNS} from trip_items where trip_id = $1`, [tripId]);
  return new Map(rows.map((r) => [String(r.id), mapExtras(r)]));
}

export async function nextItemPosition(q: Queryable, tripId: string): Promise<number> {
  const { rows } = await q.query<{ n: number | null }>("select max(position) as n from trip_items where trip_id = $1", [tripId]);
  return rows[0]?.n == null ? 0 : Number(rows[0].n) + 1;
}

/** Saves the editable details of an item (not its state). */
export async function saveItemDetails(q: Queryable, it: TripItem): Promise<void> {
  await q.query(
    `update trip_items set kind = $2, title = $3, supplier_name = $4, price_minor = $5, currency = $6, starts_at = $7, ends_at = $8,
            credentials = $9, updated_at = now() where id = $1`,
    [it.id, it.kind, it.title, it.supplierName, it.price?.amountMinor ?? null, it.price?.currency ?? null, it.startsAt, it.endsAt, it.credentials ? JSON.stringify(it.credentials) : null],
  );
}

export async function setInternalNotes(q: Queryable, itemId: string, sealed: string | null): Promise<void> {
  await q.query("update trip_items set internal_notes_enc = $2, updated_at = now() where id = $1", [itemId, sealed]);
}

export async function setBookingOffer(q: Queryable, itemId: string, offer: OfferSnapshot | null): Promise<void> {
  await q.query("update trip_items set booking_offer = $2, updated_at = now() where id = $1", [itemId, offer ? JSON.stringify(offer) : null]);
}

export async function setBookingRequest(q: Queryable, itemId: string, sealed: string | null): Promise<void> {
  await q.query("update trip_items set booking_request_enc = $2, updated_at = now() where id = $1", [itemId, sealed]);
}

export async function setProviderRef(q: Queryable, itemId: string, provider: string, providerRef: string | null): Promise<void> {
  await q.query("update trip_items set provider = $2, provider_ref = $3, updated_at = now() where id = $1", [itemId, provider, providerRef]);
}

export async function setExecutionNote(q: Queryable, itemId: string, note: string | null): Promise<void> {
  await q.query("update trip_items set last_execution_note = $2, updated_at = now() where id = $1", [itemId, note]);
}

/**
 * Marks an item as having execution queued. Returns the marker when this call
 * set it, or null when a request is already outstanding (and not stale).
 */
export async function claimExecutionRequest(q: Queryable, itemId: string, now: Date, staleMinutes = 30): Promise<string | null> {
  const { rows } = await q.query<{ execution_requested_at: unknown }>(
    `update trip_items set execution_requested_at = $2, last_execution_note = null
      where id = $1 and (execution_requested_at is null or execution_requested_at < $3) returning execution_requested_at`,
    [itemId, now.toISOString(), new Date(now.getTime() - staleMinutes * 60_000).toISOString()],
  );
  return rows[0] ? iso(rows[0].execution_requested_at) : null;
}

export async function clearExecutionRequest(q: Queryable, itemId: string): Promise<void> {
  await q.query("update trip_items set execution_requested_at = null where id = $1", [itemId]);
}

// ---------------------------------------------------------------------------
// Approvals

export async function markApprovalWithdrawn(q: Queryable, a: Approval, supersededBy: string | null = null): Promise<void> {
  const { rows } = await q.query(
    "update approvals set status = 'withdrawn', note = $2, superseded_by = $3 where id = $1 and status in ('pending', 'approved') returning id",
    [a.id, a.note, supersededBy],
  );
  if (rows.length !== 1) throw new Error(`Approval ${a.id} changed while being withdrawn`);
}

export async function setApprovalRequester(q: Queryable, approvalId: string, memberId: string): Promise<void> {
  await q.query("update approvals set requested_by_member = $2 where id = $1", [approvalId, memberId]);
}

export async function approvalMeta(q: Queryable, tripId: string): Promise<Map<string, { requestedByMember: string | null; createdAt: string; supersededBy: string | null }>> {
  const { rows } = await q.query<Record<string, unknown>>("select id, requested_by_member, created_at, superseded_by from approvals where trip_id = $1", [tripId]);
  return new Map(
    rows.map((r) => [
      String(r.id),
      { requestedByMember: r.requested_by_member ? String(r.requested_by_member) : null, createdAt: iso(r.created_at)!, supersededBy: r.superseded_by ? String(r.superseded_by) : null },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Execution attempts

export interface AttemptRow extends ExecutionAttempt {
  provider: string;
  updatedAt: string;
}

function mapAttempt(r: Record<string, unknown>): AttemptRow {
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
    updatedAt: iso(r.updated_at)!,
  };
}

export async function listAttemptsForTrip(q: Queryable, tripId: string): Promise<AttemptRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select a.* from execution_attempts a join trip_items i on i.id = a.item_id where i.trip_id = $1 order by a.updated_at desc`,
    [tripId],
  );
  return rows.map(mapAttempt);
}

export async function latestAttempt(q: Queryable, itemId: string, action?: string): Promise<AttemptRow | null> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from execution_attempts where item_id = $1 ${action ? "and action = $2" : ""} order by updated_at desc limit 1`,
    action ? [itemId, action] : [itemId],
  );
  return rows[0] ? mapAttempt(rows[0]) : null;
}

export async function setAttemptState(q: Queryable, id: string, state: ExecutionAttempt["state"], lastError: string | null): Promise<void> {
  await q.query("update execution_attempts set state = $2, last_error = $3, updated_at = now() where id = $1", [id, state, lastError]);
}

// ---------------------------------------------------------------------------
// Manual confirmations

export interface ManualConfirmation {
  id: string;
  tripId: string;
  itemId: string;
  action: "book" | "cancel";
  attemptKey: string;
  status: "pending" | "confirmed" | "not_found";
  channel: string;
  supplierName: string | null;
  confirmationRef: string | null;
  note: string | null;
  rounds: number;
  recordedBy: string | null;
  recordedAt: string | null;
  createdAt: string;
}

function mapManual(r: Record<string, unknown>): ManualConfirmation {
  return {
    id: String(r.id),
    tripId: String(r.trip_id),
    itemId: String(r.item_id),
    action: r.action as ManualConfirmation["action"],
    attemptKey: String(r.attempt_key),
    status: r.status as ManualConfirmation["status"],
    channel: String(r.channel),
    supplierName: (r.supplier_name as string | null) ?? null,
    confirmationRef: (r.confirmation_ref as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    rounds: Number(r.rounds),
    recordedBy: r.recorded_by ? String(r.recorded_by) : null,
    recordedAt: iso(r.recorded_at),
    createdAt: iso(r.created_at)!,
  };
}

export async function getManualByKey(q: Queryable, key: string): Promise<ManualConfirmation | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from manual_confirmations where attempt_key = $1", [key]);
  return rows[0] ? mapManual(rows[0]) : null;
}

export async function getManual(q: Queryable, id: string): Promise<ManualConfirmation | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from manual_confirmations where id = $1", [id]);
  return rows[0] ? mapManual(rows[0]) : null;
}

export async function listManualForTrip(q: Queryable, tripId: string): Promise<ManualConfirmation[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from manual_confirmations where trip_id = $1 order by created_at desc", [tripId]);
  return rows.map(mapManual);
}

/** Creates the task, or re-opens one the supplier said they had no record of (a new request round). */
export async function openManualTask(
  q: Queryable,
  workspaceId: string,
  t: { id: string; tripId: string; itemId: string; action: "book" | "cancel"; attemptKey: string; channel: string; supplierName: string | null },
): Promise<ManualConfirmation> {
  await q.query(
    `insert into manual_confirmations (id, workspace_id, trip_id, item_id, action, attempt_key, status, channel, supplier_name)
     values ($1,$2,$3,$4,$5,$6,'pending',$7,$8)
     on conflict (workspace_id, attempt_key) do update
       set status = 'pending', rounds = manual_confirmations.rounds + 1, confirmation_ref = null, recorded_by = null, recorded_at = null
       where manual_confirmations.status = 'not_found'`,
    [t.id, workspaceId, t.tripId, t.itemId, t.action, t.attemptKey, t.channel, t.supplierName],
  );
  return (await getManualByKey(q, t.attemptKey))!;
}

export async function resolveManualTask(
  q: Queryable,
  id: string,
  r: { status: "confirmed" | "not_found"; confirmationRef: string | null; note: string | null; recordedBy: string; now: Date },
): Promise<boolean> {
  const { rows } = await q.query(
    `update manual_confirmations set status = $2, confirmation_ref = $3, note = $4, recorded_by = $5, recorded_at = $6
      where id = $1 and status = 'pending' returning id`,
    [id, r.status, r.confirmationRef, r.note, r.recordedBy, r.now.toISOString()],
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Portal links and client acceptances

export interface PortalLinkRow {
  id: string;
  tripId: string;
  createdBy: string;
  label: string | null;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

function mapLink(r: Record<string, unknown>): PortalLinkRow {
  return {
    id: String(r.id),
    tripId: String(r.trip_id),
    createdBy: String(r.created_by),
    label: (r.label as string | null) ?? null,
    expiresAt: iso(r.expires_at)!,
    revokedAt: iso(r.revoked_at),
    lastUsedAt: iso(r.last_used_at),
    createdAt: iso(r.created_at)!,
  };
}

export async function insertPortalLink(
  q: Queryable,
  workspaceId: string,
  l: { id: string; tripId: string; tokenHash: string; createdBy: string; label: string | null; expiresAt: string },
): Promise<void> {
  await q.query(
    `insert into trip_portal_links (id, workspace_id, trip_id, token_hash, created_by, label, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`,
    [l.id, workspaceId, l.tripId, l.tokenHash, l.createdBy, l.label, l.expiresAt],
  );
}

export async function listPortalLinks(q: Queryable, tripId: string): Promise<PortalLinkRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from trip_portal_links where trip_id = $1 order by created_at desc", [tripId]);
  return rows.map(mapLink);
}

export async function revokePortalLink(q: Queryable, tripId: string, linkId: string, now: Date): Promise<boolean> {
  const { rows } = await q.query("update trip_portal_links set revoked_at = $3 where id = $1 and trip_id = $2 and revoked_at is null returning id", [
    linkId,
    tripId,
    now.toISOString(),
  ]);
  return rows.length === 1;
}

/** Platform lookup by token hash (runs as app_system; the token is the only credential the client has). */
export async function findPortalLinkSystem(q: Queryable, tokenHash: string): Promise<(PortalLinkRow & { workspaceId: string }) | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from trip_portal_links where token_hash = $1", [tokenHash]);
  return rows[0] ? { ...mapLink(rows[0]), workspaceId: String(rows[0].workspace_id) } : null;
}

export async function touchPortalLinkSystem(q: Queryable, id: string, now: Date): Promise<void> {
  await q.query("update trip_portal_links set last_used_at = $2 where id = $1", [id, now.toISOString()]);
}

export async function listAcceptances(q: Queryable, tripId: string): Promise<ClientAcceptance[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    "select approval_id, accepted_name, accepted_at, terms_fingerprint, price_minor from approval_client_acceptances where trip_id = $1",
    [tripId],
  );
  return rows.map((r) => ({
    approvalId: String(r.approval_id),
    acceptedName: String(r.accepted_name),
    acceptedAt: iso(r.accepted_at)!,
    termsFingerprint: String(r.terms_fingerprint),
    priceMinor: Number(r.price_minor),
  }));
}

export async function insertAcceptance(
  q: Queryable,
  workspaceId: string,
  a: { id: string; approvalId: string; tripId: string; portalLinkId: string | null; acceptedName: string; termsFingerprint: string; priceMinor: number; currency: string; now: Date },
): Promise<boolean> {
  const { rows } = await q.query(
    `insert into approval_client_acceptances (id, workspace_id, approval_id, trip_id, portal_link_id, accepted_name, terms_fingerprint, price_minor, currency, accepted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (approval_id) do nothing returning id`,
    [a.id, workspaceId, a.approvalId, a.tripId, a.portalLinkId, a.acceptedName, a.termsFingerprint, a.priceMinor, a.currency, a.now.toISOString()],
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Activity

export interface ActivityRow {
  at: string;
  actor: string;
  action: string;
  subject: string;
  data: Record<string, unknown>;
}

export async function tripActivity(q: Queryable, tripId: string, limit = 40): Promise<ActivityRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select at, actor, action, subject, data from audit_events
      where subject = $1::text
         or subject in (select id::text from trip_items where trip_id = $1::text::uuid)
         or subject in (select id::text from approvals where trip_id = $1::text::uuid)
      order by at desc, id desc limit $2`,
    [tripId, limit],
  );
  return rows.map((r) => ({ at: iso(r.at)!, actor: String(r.actor), action: String(r.action), subject: String(r.subject), data: (r.data ?? {}) as Record<string, unknown> }));
}
