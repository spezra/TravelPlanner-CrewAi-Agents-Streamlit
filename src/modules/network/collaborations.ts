/**
 * Collaborations across workspaces.
 *
 * Flow: the requester finds a specialist through discoverability and sends an
 * anonymized brief; the specialist accepts or declines; both sides agree the
 * same version of the terms (decision authority, compensation, non-solicit,
 * visibility, client-detail expiry); only then can the specialist read the
 * client details the requester shares, until access expires or the work ends.
 * Relationship activations go to the holder for a yes/no every time. Every
 * step lands in the append-only contribution log.
 *
 * Row-level security enforces who can read what (see 040_network.sql); these
 * services enforce who may do what, by side and state.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { audit, getItem as getTripItem, getTrip, listItems } from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { anonymizeBrief, endorsementHolds, transitionCollaboration, type Collaboration, type CollaborationState, type ContributionType } from "@/domain/collaboration";
import {
  acceptVersion,
  assertMay,
  assertValidTerms,
  bothAccepted,
  currentVersion,
  decideActivation,
  recommendationContent,
  specialistNameMayAppear,
  termsFingerprint,
  type CollaborationTerms,
  type Side,
  type TermsFeeLine,
  type TermsVersion,
} from "@/domain/collaborationTerms";
import { DomainError, fingerprint } from "@/domain/common";
import type { DecisionAuthority } from "@/domain/collaboration";
import { getNetworkProfile, membership, myProfile } from "./membership";
import { createRedactor, loadWorkspaceNames } from "./redact";
import { iso, memberRole, str } from "./util";

export interface AnonymizedBrief {
  text: string;
  partySize: number;
  budgetBand: string;
  dates: string;
  /** How many identifying details were removed before the specialist saw it. */
  redactions: number;
}

export interface CollabRow {
  id: string;
  requesterWorkspaceId: string;
  requesterMemberId: string;
  requesterName: string;
  specialistWorkspaceId: string;
  specialistMemberId: string;
  specialistName: string;
  tripId: string | null;
  contribution: ContributionType;
  state: CollaborationState;
  destination: string | null;
  brief: AnonymizedBrief;
  agreedTermsVersion: number | null;
  clientAccessExpiresAt: string | null;
  declineReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapCollab(r: Record<string, unknown>): CollabRow {
  return {
    id: String(r.id),
    requesterWorkspaceId: String(r.workspace_id),
    requesterMemberId: String(r.requester_member_id),
    requesterName: String(r.requester_name),
    specialistWorkspaceId: String(r.specialist_workspace_id),
    specialistMemberId: String(r.specialist_member_id),
    specialistName: String(r.specialist_name),
    tripId: str(r.trip_id),
    contribution: r.contribution as ContributionType,
    state: r.state as CollaborationState,
    destination: str(r.destination),
    brief: r.brief as AnonymizedBrief,
    agreedTermsVersion: r.agreed_terms_version == null ? null : Number(r.agreed_terms_version),
    clientAccessExpiresAt: iso(r.client_access_expires_at),
    declineReason: str(r.decline_reason),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export async function listCollaborations(q: Queryable): Promise<CollabRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from collaborations order by updated_at desc limit 200");
  return rows.map(mapCollab);
}

export async function getCollaboration(q: Queryable, id: string): Promise<CollabRow | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from collaborations where id = $1", [id]);
  return rows[0] ? mapCollab(rows[0]) : null;
}

/** The caller's side, or null for a colleague who can see the trip but isn't a party. */
export function sideOf(c: CollabRow, tenant: Tenant): Side | null {
  if (c.requesterWorkspaceId === tenant.workspaceId && c.requesterMemberId === tenant.memberId) return "requester";
  if (c.specialistWorkspaceId === tenant.workspaceId && c.specialistMemberId === tenant.memberId) return "specialist";
  return null;
}

async function load(q: Queryable, tenant: Tenant, id: string): Promise<{ c: CollabRow; side: Side }> {
  const c = await getCollaboration(q, id);
  if (!c) throw new DomainError("not_found", "Collaboration not found");
  const side = sideOf(c, tenant);
  if (!side) throw new DomainError("forbidden", "Only the requester and the specialist can act on a collaboration");
  return { c, side };
}

/** Compensation and authority are money and reputation decisions: experts only, not assistants. */
async function requireExpert(q: Queryable, tenant: Tenant): Promise<void> {
  const role = await memberRole(q, tenant.memberId);
  if (role !== "owner" && role !== "advisor" && role !== "admin") {
    throw new DomainError("forbidden", "Assistants prepare collaborations; an expert sends requests and agrees terms");
  }
}

async function logEntry(q: Queryable, c: CollabRow, tenant: Tenant, side: Side, kind: string, detail: Record<string, unknown>, now: Date): Promise<void> {
  await q.query(
    "insert into collaboration_log (id, collaboration_id, workspace_id, actor_member_id, actor_side, kind, detail, at) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(), c.id, tenant.workspaceId, tenant.memberId, side, kind, JSON.stringify(detail), now.toISOString()],
  );
}

async function setState(q: Queryable, c: CollabRow, to: CollaborationState, now: Date, extra: { declineReason?: string | null } = {}): Promise<void> {
  const { rows } = await q.query(
    "update collaborations set state = $2, decline_reason = coalesce($4, decline_reason), updated_at = $5 where id = $1 and state = $3 returning id",
    [c.id, to, c.state, extra.declineReason ?? null, now.toISOString()],
  );
  if (!rows.length) throw new DomainError("conflict", "The collaboration changed while you were acting on it; reload and try again");
}

function asDomain(c: CollabRow, terms: CollaborationTerms | null): Collaboration {
  return {
    id: c.id,
    tripId: c.tripId ?? "",
    requesterId: c.requesterMemberId,
    specialistId: c.specialistMemberId,
    contribution: c.contribution,
    state: c.state,
    authority: terms?.authority ?? null,
    fees: (terms?.fees ?? []).map((f) => ({ kind: f.kind, amount: f.amount, commissionShareBps: f.commissionShareBps, bookingItemIds: f.bookingItemIds })),
    nonSolicit: terms?.nonSolicit ?? false,
    clientAccessExpiresAt: terms?.clientAccessExpiresAt ?? c.clientAccessExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Request and response

export interface RequestInput {
  specialistMemberId: string;
  contribution: ContributionType;
  tripId: string | null;
  destination: string | null;
  text: string;
  partySize: number;
  budgetBand: string;
  dates: string;
}

export async function requestCollaboration(db: Db, tenant: Tenant, input: RequestInput, now: Date): Promise<string> {
  if (!input.text.trim()) throw new DomainError("empty_brief", "Describe what you need");
  if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 200) throw new DomainError("bad_party", "Party size must be between 1 and 200");
  return withTenant(db, tenant, async (q) => {
    await requireExpert(q, tenant);
    if ((await membership(q)).status !== "admitted") throw new DomainError("not_member", "Your workspace isn't a network member");
    const profile = await getNetworkProfile(q, input.specialistMemberId);
    if (!profile) throw new DomainError("not_found", "That expert isn't discoverable in the network");
    if (!profile.capabilities.includes(input.contribution)) throw new DomainError("not_offered", `${profile.displayName} doesn't offer that kind of contribution`);
    if (profile.responseCapacity === "unavailable") throw new DomainError("unavailable", `${profile.displayName} isn't taking requests right now`);

    let clientName: string | null = null;
    if (input.tripId) {
      const trip = await getTrip(q, input.tripId);
      if (!trip) throw new DomainError("not_found", "Trip not found");
      clientName = trip.clientName;
    }
    // The client's name first (anonymizeBrief), then every other name and identifier the workspace knows.
    const base = clientName
      ? anonymizeBrief({ clientName, text: input.text, partySize: input.partySize, budgetBand: input.budgetBand, dates: input.dates })
      : { text: input.text, partySize: input.partySize, budgetBand: input.budgetBand, dates: input.dates };
    const redacted = createRedactor(await loadWorkspaceNames(q)).redact(base.text.trim());
    const brief: AnonymizedBrief = {
      text: redacted.text,
      partySize: base.partySize,
      budgetBand: base.budgetBand.trim().slice(0, 80),
      dates: base.dates.trim().slice(0, 80),
      redactions: redacted.findings.length + (clientName && base.text !== input.text ? 1 : 0),
    };
    const requesterName =
      (await myProfile(q))?.displayName ?? (await q.query<{ name: string }>("select name from members where id = $1", [tenant.memberId])).rows[0]?.name ?? "A network member";

    const id = randomUUID();
    await q.query(
      `insert into collaborations (id, workspace_id, requester_member_id, specialist_workspace_id, specialist_member_id, requester_name, specialist_name,
         trip_id, contribution, state, destination, brief, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested',$10,$11,$12,$12)`,
      [id, tenant.workspaceId, tenant.memberId, profile.workspaceId, profile.memberId, requesterName, profile.displayName, input.tripId, input.contribution,
        input.destination?.trim() || null, JSON.stringify(brief), now.toISOString()],
    );
    const c = (await getCollaboration(q, id))!;
    await logEntry(q, c, tenant, "requester", "requested", { contribution: input.contribution, redactions: brief.redactions }, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.requested", id, { specialistWorkspaceId: profile.workspaceId, contribution: input.contribution });
    return id;
  });
}

export async function respondToRequest(db: Db, tenant: Tenant, id: string, decision: "accept" | "decline", reason: string | null, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay(decision === "accept" ? "accept_request" : "decline_request", side, c.state);
    const to = decision === "accept" ? "brief_shared" : "declined";
    transitionCollaboration(asDomain(c, null), to);
    await setState(q, c, to, now, { declineReason: decision === "decline" ? reason?.slice(0, 1000) || "Declined" : null });
    await logEntry(q, c, tenant, side, decision === "accept" ? "accepted" : "declined", reason ? { reason } : {}, now);
    await audit(q, tenant.workspaceId, tenant.memberId, `collaboration.${decision === "accept" ? "accepted" : "declined"}`, id);
  });
}

export async function withdraw(db: Db, tenant: Tenant, id: string, reason: string | null, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay("withdraw", side, c.state);
    transitionCollaboration(asDomain(c, null), "withdrawn");
    await setState(q, c, "withdrawn", now);
    await logEntry(q, c, tenant, side, "withdrawn", reason ? { reason } : {}, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.withdrawn", id);
  });
}

export async function startWork(db: Db, tenant: Tenant, id: string, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay("start_work", side, c.state);
    transitionCollaboration(asDomain(c, await agreedTerms(q, c)), "active");
    await setState(q, c, "active", now);
    await logEntry(q, c, tenant, side, "started", {}, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.started", id);
  });
}

/** Completing the work ends the specialist's access to client details. */
export async function complete(db: Db, tenant: Tenant, id: string, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay("complete", side, c.state);
    transitionCollaboration(asDomain(c, await agreedTerms(q, c)), "completed");
    await setState(q, c, "completed", now);
    await logEntry(q, c, tenant, side, "completed", {}, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.completed", id);
  });
}

// ---------------------------------------------------------------------------
// Terms

export interface TermsRow extends TermsVersion {
  id: string;
  proposedBy: string;
  terms: CollaborationTerms;
  createdAt: string;
}

function mapTerms(r: Record<string, unknown>): TermsRow {
  return {
    id: String(r.id),
    version: Number(r.version),
    fingerprint: String(r.fingerprint),
    proposedBySide: r.proposed_by_side as Side,
    proposedBy: String(r.proposed_by),
    terms: r.terms as CollaborationTerms,
    requesterAcceptedAt: iso(r.requester_accepted_at),
    specialistAcceptedAt: iso(r.specialist_accepted_at),
    supersededAt: iso(r.superseded_at),
    createdAt: iso(r.created_at)!,
  };
}

export async function listTerms(q: Queryable, id: string): Promise<TermsRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from collaboration_terms where collaboration_id = $1 order by version", [id]);
  return rows.map(mapTerms);
}

async function agreedTerms(q: Queryable, c: CollabRow): Promise<CollaborationTerms | null> {
  if (c.agreedTermsVersion === null) return null;
  return (await listTerms(q, c.id)).find((t) => t.version === c.agreedTermsVersion)?.terms ?? null;
}

export interface TermsInput {
  finalRecommendationOwner: Side;
  delegatedDecisions: string[];
  changesRequiringSpecialistReview: string[];
  deliveryOwners: { service: string; owner: Side }[];
  attributionRule: DecisionAuthority["attributionRule"];
  specialistVisibleToClient: boolean;
  fees: Omit<TermsFeeLine, "bookingItemLabels">[];
  nonSolicit: boolean;
  clientAccessExpiresAt: string;
  reversalLossBearer: CollaborationTerms["reversalLossBearer"];
  notes: string | null;
}

/**
 * Either side proposes a version; proposing counts as accepting it. It
 * supersedes any version still under negotiation, while an agreed version
 * stays in force until both sides accept its replacement.
 */
export async function proposeTerms(db: Db, tenant: Tenant, id: string, input: TermsInput, now: Date): Promise<number> {
  return withTenant(db, tenant, async (q) => {
    await requireExpert(q, tenant);
    const { c, side } = await load(q, tenant, id);
    assertMay("propose_terms", side, c.state);
    const versions = await listTerms(q, id);

    // Booking lines belong to the requester's trip. The specialist can only reference lines already on the table.
    const labels = new Map<string, string>();
    if (side === "requester") {
      if (c.tripId) for (const it of await listItems(q, c.tripId)) labels.set(it.id, it.title);
    } else {
      for (const v of versions) for (const f of v.terms.fees) f.bookingItemIds.forEach((bid, i) => labels.set(bid, f.bookingItemLabels[i] ?? "Booking line"));
    }
    const fees: TermsFeeLine[] = input.fees.map((f) => {
      for (const bid of f.bookingItemIds) if (!labels.has(bid)) throw new DomainError("unknown_item", "A fee line refers to a booking line that isn't part of this collaboration");
      return { ...f, bookingItemLabels: f.bookingItemIds.map((bid) => labels.get(bid)!) };
    });
    const member = (s: Side) => (s === "requester" ? c.requesterMemberId : c.specialistMemberId);
    const terms: CollaborationTerms = {
      authority: {
        briefOwner: c.requesterMemberId,
        finalRecommendationOwner: member(input.finalRecommendationOwner),
        delegatedDecisions: input.delegatedDecisions,
        changesRequiringSpecialistReview: input.changesRequiringSpecialistReview,
        deliveryOwners: Object.fromEntries(input.deliveryOwners.map((d) => [d.service, member(d.owner)])),
        attributionRule: input.attributionRule,
        specialistVisibleToClient: input.specialistVisibleToClient,
      },
      fees,
      nonSolicit: input.nonSolicit,
      clientAccessExpiresAt: new Date(input.clientAccessExpiresAt).toISOString(),
      reversalLossBearer: input.reversalLossBearer,
      notes: input.notes?.trim() || null,
    };
    assertValidTerms(terms, now);
    const fp = termsFingerprint(terms);
    const version = versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    await q.query(
      "update collaboration_terms set superseded_at = $2 where collaboration_id = $1 and superseded_at is null and version is distinct from $3",
      [id, now.toISOString(), c.agreedTermsVersion],
    );
    const accepted = side === "requester" ? ["requester_accepted_at", "requester_accepted_by"] : ["specialist_accepted_at", "specialist_accepted_by"];
    await q.query(
      `insert into collaboration_terms (id, collaboration_id, workspace_id, version, proposed_by, proposed_by_side, terms, fingerprint, ${accepted[0]}, ${accepted[1]}, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$5,$9)`,
      [randomUUID(), id, tenant.workspaceId, version, tenant.memberId, side, JSON.stringify(terms), fp, now.toISOString()],
    );
    await q.query("update collaborations set updated_at = $2 where id = $1", [id, now.toISOString()]);
    await logEntry(q, c, tenant, side, c.agreedTermsVersion ? "amendment_proposed" : "terms_proposed", { version, fingerprint: fp }, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.terms_proposed", id, { version, fingerprint: fp });
    return version;
  });
}

/**
 * Accept exactly the version (and content) the caller saw. When both sides
 * have accepted the same version it becomes the agreed terms, and client-
 * detail access opens until the agreed expiry.
 */
export async function acceptTerms(db: Db, tenant: Tenant, id: string, version: number, seenFingerprint: string, now: Date): Promise<{ agreed: boolean }> {
  return withTenant(db, tenant, async (q) => {
    await requireExpert(q, tenant);
    const { c, side } = await load(q, tenant, id);
    assertMay("accept_terms", side, c.state);
    const versions = await listTerms(q, id);
    const v = versions.find((t) => t.version === version);
    if (!v) throw new DomainError("not_found", `Terms v${version} not found`);
    const accepted = acceptVersion(v, currentVersion(versions), side, seenFingerprint, now);
    const col = side === "requester" ? "requester" : "specialist";
    const { rows } = await q.query(
      `update collaboration_terms set ${col}_accepted_at = $2, ${col}_accepted_by = $3 where id = $1 and ${col}_accepted_at is null and superseded_at is null returning id`,
      [v.id, now.toISOString(), tenant.memberId],
    );
    if (!rows.length) throw new DomainError("conflict", "These terms changed while you were accepting them; reload and review");
    if (!bothAccepted(accepted)) {
      await logEntry(q, c, tenant, side, "terms_accepted", { version, fingerprint: v.fingerprint }, now);
      await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.terms_accepted", id, { version });
      return { agreed: false };
    }
    let to = c.state;
    if (c.state === "brief_shared") {
      to = transitionCollaboration(asDomain(c, v.terms), "terms_agreed").state;
    }
    if (c.agreedTermsVersion !== null) {
      await q.query("update collaboration_terms set superseded_at = $3 where collaboration_id = $1 and version = $2", [id, c.agreedTermsVersion, now.toISOString()]);
    }
    const { rows: updated } = await q.query(
      `update collaborations set state = $2, agreed_terms_version = $3, client_access_expires_at = $4, access_expiry_logged_at = null, updated_at = $5
        where id = $1 and state = $6 returning id`,
      [id, to, version, v.terms.clientAccessExpiresAt, now.toISOString(), c.state],
    );
    if (!updated.length) throw new DomainError("conflict", "The collaboration changed while you were accepting; reload and review");
    await logEntry(q, c, tenant, side, c.agreedTermsVersion ? "amendment_agreed" : "terms_agreed", { version, fingerprint: v.fingerprint }, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.terms_agreed", id, { version, fingerprint: v.fingerprint });
    return { agreed: true };
  });
}

// ---------------------------------------------------------------------------
// Client details shared with the specialist

export type ShareKind = "client" | "trip_item" | "brief_statement" | "note";

export interface ShareRow {
  id: string;
  kind: ShareKind;
  sourceId: string | null;
  label: string;
  content: Record<string, unknown>;
  contentFingerprint: string;
  sharedAt: string;
  refreshedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

function mapShare(r: Record<string, unknown>): ShareRow {
  return {
    id: String(r.id),
    kind: r.kind as ShareKind,
    sourceId: str(r.source_id),
    label: String(r.label),
    content: r.content as Record<string, unknown>,
    contentFingerprint: String(r.content_fingerprint),
    sharedAt: iso(r.shared_at)!,
    refreshedAt: iso(r.refreshed_at),
    expiresAt: iso(r.expires_at),
    revokedAt: iso(r.revoked_at),
  };
}

/** RLS decides: the requester sees everything they shared; the specialist only after terms and until expiry. */
export async function listShares(q: Queryable, id: string): Promise<ShareRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from collaboration_shares where collaboration_id = $1 order by shared_at, label", [id]);
  return rows.map(mapShare);
}

/** Snapshot of the requester's own record, built from what the requester can see. */
async function shareContent(q: Queryable, c: CollabRow, kind: ShareKind, sourceId: string | null, text: string | null): Promise<{ label: string; content: Record<string, unknown> }> {
  if (kind === "note") {
    if (!text?.trim()) throw new DomainError("empty", "Write the note to share");
    return { label: "Note", content: { text: text.trim().slice(0, 4000) } };
  }
  if (!c.tripId || !sourceId) throw new DomainError("no_trip", "Link this collaboration to a trip to share its details");
  const trip = await getTrip(q, c.tripId);
  if (!trip) throw new DomainError("not_found", "Trip not found");
  if (kind === "client") {
    if (!trip.clientId || trip.clientId !== sourceId) throw new DomainError("not_found", "That client isn't on this trip");
    return { label: "Client", content: { name: trip.clientName } };
  }
  if (kind === "trip_item") {
    const item = await getTripItem(q, sourceId);
    if (!item || item.tripId !== c.tripId) throw new DomainError("not_found", "That item isn't on this trip");
    return { label: item.title, content: recommendationContent(item) };
  }
  const { rows } = await q.query<{ dimension: string; text: string; evidence: string; client_id: string; trip_id: string | null }>(
    "select dimension, text, evidence, client_id, trip_id from brief_statements where id = $1 and superseded_by is null",
    [sourceId],
  );
  const s = rows[0];
  if (!s || s.client_id !== trip.clientId || (s.trip_id !== null && s.trip_id !== trip.id)) throw new DomainError("not_found", "That brief statement isn't about this trip's client");
  return { label: s.dimension.replace(/_/g, " "), content: { dimension: s.dimension, text: s.text, evidence: s.evidence } };
}

export async function addShare(
  db: Db,
  tenant: Tenant,
  id: string,
  input: { kind: ShareKind; sourceId: string | null; text?: string | null },
  now: Date,
): Promise<string> {
  return withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay("share", side, c.state);
    const { label, content } = await shareContent(q, c, input.kind, input.sourceId, input.text ?? null);
    const shareId = randomUUID();
    const fp = fingerprint(content);
    const sourceId = input.kind === "note" ? null : input.sourceId;
    const { rows } = sourceId
      ? await q.query<{ id: string }>(
          `insert into collaboration_shares (id, collaboration_id, workspace_id, kind, source_id, label, content, content_fingerprint, shared_by, shared_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (collaboration_id, kind, source_id) where source_id is not null
             do update set label = excluded.label, content = excluded.content, content_fingerprint = excluded.content_fingerprint,
               revoked_at = null, refreshed_at = excluded.shared_at
           returning id`,
          [shareId, id, tenant.workspaceId, input.kind, sourceId, label, JSON.stringify(content), fp, tenant.memberId, now.toISOString()],
        )
      : await q.query<{ id: string }>(
          `insert into collaboration_shares (id, collaboration_id, workspace_id, kind, source_id, label, content, content_fingerprint, shared_by, shared_at)
           values ($1,$2,$3,$4,null,$5,$6,$7,$8,$9) returning id`,
          [shareId, id, tenant.workspaceId, input.kind, label, JSON.stringify(content), fp, tenant.memberId, now.toISOString()],
        );
    const out = rows[0]!.id;
    await logEntry(q, c, tenant, side, "shared", { shareId: out, kind: input.kind, label }, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.shared", id, { shareId: out, kind: input.kind });
    return out;
  });
}

/**
 * Re-snapshots a shared record from its source. If the recommendation
 * changed materially, the fingerprint changes and the specialist's
 * endorsement of it lapses until they review it again.
 */
export async function refreshShare(db: Db, tenant: Tenant, id: string, shareId: string, now: Date): Promise<{ changed: boolean }> {
  return withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay("share", side, c.state);
    const share = (await listShares(q, id)).find((s) => s.id === shareId);
    if (!share || share.kind === "note") throw new DomainError("not_found", "Share not found");
    const { label, content } = await shareContent(q, c, share.kind, share.sourceId, null);
    const fp = fingerprint(content);
    await q.query("update collaboration_shares set label = $2, content = $3, content_fingerprint = $4, refreshed_at = $5 where id = $1", [
      shareId, label, JSON.stringify(content), fp, now.toISOString(),
    ]);
    const changed = fp !== share.contentFingerprint;
    await logEntry(q, c, tenant, side, "share_refreshed", { shareId, changed }, now);
    return { changed };
  });
}

export async function revokeShare(db: Db, tenant: Tenant, id: string, shareId: string, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    if (side !== "requester") throw new DomainError("forbidden", "Only the requester can revoke what they shared");
    const { rows } = await q.query("update collaboration_shares set revoked_at = $3 where id = $1 and collaboration_id = $2 and revoked_at is null returning id", [
      shareId, id, now.toISOString(),
    ]);
    if (!rows.length) throw new DomainError("not_found", "Share not found or already revoked");
    await logEntry(q, c, tenant, side, "share_revoked", { shareId }, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.share_revoked", id, { shareId });
  });
}

// ---------------------------------------------------------------------------
// Endorsements

export async function endorse(db: Db, tenant: Tenant, id: string, shareId: string, note: string | null, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay("endorse", side, c.state);
    // Visible only while access is open, so an endorsement always reflects content the specialist could read.
    const share = (await listShares(q, id)).find((s) => s.id === shareId);
    if (!share) throw new DomainError("no_access", "You can only endorse a recommendation you can currently see");
    if (share.kind !== "trip_item") throw new DomainError("not_a_recommendation", "Endorsements apply to recommendations (shared trip items)");
    await q.query("update collaboration_endorsements set withdrawn_at = $3 where share_id = $1 and specialist_member_id = $2 and withdrawn_at is null", [
      shareId, tenant.memberId, now.toISOString(),
    ]);
    await q.query(
      `insert into collaboration_endorsements (id, collaboration_id, share_id, workspace_id, specialist_member_id, reviewed_fingerprint, note, endorsed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), id, shareId, tenant.workspaceId, tenant.memberId, share.contentFingerprint, note?.slice(0, 2000) || null, now.toISOString()],
    );
    await logEntry(q, c, tenant, side, "endorsed", { shareId, label: share.label, fingerprint: share.contentFingerprint }, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.endorsed", id, { shareId });
  });
}

export interface EndorsementStatus {
  id: string;
  shareId: string;
  label: string | null;
  note: string | null;
  endorsedAt: string;
  /** null when the caller can no longer see what was endorsed (access ended). */
  holds: boolean | null;
  nameMayAppear: boolean;
}

/**
 * For the requester, "current" is the live trip item, so an edit to the
 * recommendation lapses the endorsement even before the share is refreshed.
 * For the specialist, it's the shared snapshot while they can still see it.
 */
export async function endorsementStatuses(q: Queryable, c: CollabRow, side: Side | null): Promise<EndorsementStatus[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    "select * from collaboration_endorsements where collaboration_id = $1 and withdrawn_at is null order by endorsed_at",
    [c.id],
  );
  const shares = new Map((await listShares(q, c.id)).map((s) => [s.id, s]));
  const authority = (await agreedTerms(q, c))?.authority ?? null;
  const out: EndorsementStatus[] = [];
  for (const r of rows) {
    const share = shares.get(String(r.share_id));
    let current: string | null = share?.contentFingerprint ?? null;
    if (side !== "specialist" && share?.kind === "trip_item" && share.sourceId) {
      const live = await getTripItem(q, share.sourceId);
      current = live ? fingerprint(recommendationContent(live)) : null;
    }
    const holds =
      current === null ? null : endorsementHolds({ specialistId: String(r.specialist_member_id), recommendationId: String(r.share_id), reviewedFingerprint: String(r.reviewed_fingerprint) }, current);
    out.push({
      id: String(r.id),
      shareId: String(r.share_id),
      label: share?.label ?? null,
      note: str(r.note),
      endorsedAt: iso(r.endorsed_at)!,
      holds,
      nameMayAppear: authority ? specialistNameMayAppear(authority, holds === true) : false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relationship activation

export interface ActivationRow {
  id: string;
  relationshipHint: string;
  ask: string;
  decision: "pending" | "yes" | "no";
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  holderMemberId: string;
}

export async function listActivations(q: Queryable, id: string): Promise<ActivationRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from relationship_activations where collaboration_id = $1 order by created_at", [id]);
  return rows.map((r) => ({
    id: String(r.id),
    relationshipHint: String(r.relationship_hint),
    ask: String(r.ask),
    decision: r.decision as ActivationRow["decision"],
    decisionNote: str(r.decision_note),
    decidedAt: iso(r.decided_at),
    createdAt: iso(r.created_at)!,
    holderMemberId: String(r.holder_member_id),
  }));
}

/** Each ask is new: a previous yes says nothing about this one. */
export async function requestActivation(db: Db, tenant: Tenant, id: string, input: { relationshipHint: string; ask: string }, now: Date): Promise<string> {
  if (!input.relationshipHint.trim() || !input.ask.trim()) throw new DomainError("empty", "Say whose relationship and what you're asking for");
  return withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay("request_activation", side, c.state);
    // Before terms open client access, the ask is anonymized like the brief.
    const accessOpen = (c.state === "terms_agreed" || c.state === "active") && c.clientAccessExpiresAt !== null && new Date(c.clientAccessExpiresAt) > now;
    const redactor = accessOpen ? null : createRedactor(await loadWorkspaceNames(q));
    const clean = (t: string) => (redactor ? redactor.redact(t.trim()).text : t.trim()).slice(0, 2000);
    const activationId = randomUUID();
    await q.query(
      `insert into relationship_activations (id, collaboration_id, workspace_id, requested_by, holder_workspace_id, holder_member_id, relationship_hint, ask, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [activationId, id, tenant.workspaceId, tenant.memberId, c.specialistWorkspaceId, c.specialistMemberId, clean(input.relationshipHint), clean(input.ask), now.toISOString()],
    );
    await logEntry(q, c, tenant, side, "activation_requested", { activationId }, now);
    await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.activation_requested", id, { activationId });
    return activationId;
  });
}

/** The relationship holder, and only the holder, answers yes or no. */
export async function decideActivationRequest(db: Db, tenant: Tenant, activationId: string, decision: "yes" | "no", note: string | null, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>("select * from relationship_activations where id = $1", [activationId]);
    const r = rows[0];
    if (!r) throw new DomainError("not_found", "Activation request not found");
    decideActivation({ holderMemberId: String(r.holder_member_id), decision: r.decision as ActivationRow["decision"] }, tenant.memberId, decision);
    if (String(r.holder_workspace_id) !== tenant.workspaceId) throw new DomainError("not_holder", "Only the relationship holder can answer an activation request");
    const { rows: done } = await q.query(
      "update relationship_activations set decision = $2, decision_note = $3, decided_at = $4 where id = $1 and decision = 'pending' returning id",
      [activationId, decision, note?.slice(0, 2000) || null, now.toISOString()],
    );
    if (!done.length) throw new DomainError("already_decided", "This activation request was already answered");
    const c = (await getCollaboration(q, String(r.collaboration_id)))!;
    await logEntry(q, c, tenant, "specialist", "activation_decided", { activationId, decision }, now);
    await audit(q, tenant.workspaceId, tenant.memberId, `collaboration.activation_${decision}`, c.id, { activationId });
  });
}

// ---------------------------------------------------------------------------
// Contribution log

export const LOG_KINDS = ["note", "amendment", "dispute"] as const;

export async function addLogEntry(db: Db, tenant: Tenant, id: string, kind: (typeof LOG_KINDS)[number], text: string, now: Date): Promise<void> {
  if (!text.trim()) throw new DomainError("empty", "Write the entry first");
  await withTenant(db, tenant, async (q) => {
    const { c, side } = await load(q, tenant, id);
    assertMay("log_note", side, c.state);
    await logEntry(q, c, tenant, side, kind, { text: text.trim().slice(0, 4000) }, now);
    if (kind === "dispute") await audit(q, tenant.workspaceId, tenant.memberId, "collaboration.dispute_logged", id);
  });
}

export interface LogRow {
  id: string;
  actorSide: Side | "system";
  actorMemberId: string | null;
  kind: string;
  detail: Record<string, unknown>;
  at: string;
}

export async function listLog(q: Queryable, id: string): Promise<LogRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from collaboration_log where collaboration_id = $1 order by seq", [id]);
  return rows.map((r) => ({
    id: String(r.id),
    actorSide: r.actor_side as LogRow["actorSide"],
    actorMemberId: str(r.actor_member_id),
    kind: String(r.kind),
    detail: (r.detail ?? {}) as Record<string, unknown>,
    at: iso(r.at)!,
  }));
}

/** Platform job: record, once, that client-detail access expired (RLS already stopped it). */
export async function logExpiredAccess(q: Queryable, now: Date): Promise<number> {
  const { rows } = await q.query<{ id: string; workspace_id: string }>(
    `update collaborations set access_expiry_logged_at = $1
      where state in ('terms_agreed', 'active') and client_access_expires_at <= $1 and access_expiry_logged_at is null
      returning id, workspace_id`,
    [now.toISOString()],
  );
  for (const r of rows) {
    await q.query(
      "insert into collaboration_log (id, collaboration_id, workspace_id, actor_member_id, actor_side, kind, detail, at) values ($1,$2,$3,null,'system','access_expired','{}',$4)",
      [randomUUID(), r.id, r.workspace_id, now.toISOString()],
    );
    await audit(q, r.workspace_id, "system", "collaboration.access_expired", r.id);
  }
  return rows.length;
}
