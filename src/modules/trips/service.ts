/**
 * Trip management services: trips, delegations, items, approvals, execution
 * requests, manual confirmations and client portal links. One tenant-bound
 * transaction per operation, permission checks here (RLS decides visibility,
 * these decide authority), and an audit event for every consequential step.
 */
import { randomUUID } from "node:crypto";
import { requestApproval as newApproval, type ActionSpec, type Approval, type MaterialTerms } from "@/domain/approvals";
import { missingCredentialFields, transitionItem, type BookingCredentials, type ItemKind, type ItemState, type TripItem } from "@/domain/bookings";
import { DomainError, type Money, type Role } from "@/domain/common";
import {
  canEditItem,
  materialChange,
  PRE_SUPPLIER_STATES,
  requote,
  stateOnApprovalRequest,
  SUPPLIER_HELD_STATES,
  validateApprovalActions,
  withdrawApproval,
} from "@/domain/tripPlanning";
import type { Db, Queryable } from "@/db/client";
import * as coreRepo from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { snapshotOffer, type DuffelClient, type OfferSnapshot, type TravelerDetails } from "@/providers/duffel";
import { decryptFor, encryptFor } from "@/server/crypto";
import { enqueueAsTenant } from "@/server/jobs/queue";
import { recoverInterrupted, reconcileBooking, reconcileCancellation, type TermsConfirmation } from "./execution";
import { ManualAdapter, providerForItem, travelersContext, type ProviderDeps } from "./providers";
import * as repo from "./repo";

// ---------------------------------------------------------------------------
// Authority

async function roleOf(q: Queryable, memberId: string): Promise<Role | null> {
  const { rows } = await q.query<{ role: Role }>("select role from members where id = $1 and disabled_at is null", [memberId]);
  return rows[0]?.role ?? null;
}

async function visibleTrip(q: Queryable, tripId: string) {
  const trip = await coreRepo.getTrip(q, tripId);
  if (!trip) throw new DomainError("not_found", "Trip not found");
  return trip;
}

/** Delegations and client links belong to the expert who owns the trip. */
async function requireTripOwner(q: Queryable, tenant: Tenant, tripId: string) {
  const trip = await visibleTrip(q, tripId);
  if (trip.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the trip owner can do that");
  return trip;
}

/** Trip details can be edited by the owner, or by a workspace owner/admin. */
async function requireTripEditor(q: Queryable, tenant: Tenant, tripId: string) {
  const trip = await visibleTrip(q, tripId);
  const role = await roleOf(q, tenant.memberId);
  if (trip.ownerId !== tenant.memberId && role !== "owner" && role !== "admin") {
    throw new DomainError("forbidden", "Only the trip owner or a workspace owner/admin can edit this trip");
  }
  return trip;
}

async function visibleItem(q: Queryable, itemId: string): Promise<TripItem> {
  const item = await coreRepo.getItem(q, itemId);
  if (!item) throw new DomainError("not_found", "Item not found");
  return item;
}

// ---------------------------------------------------------------------------
// Trips

export interface TripDraft {
  title: string;
  clientId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  scope: "private" | "workspace";
}

function validateTrip(t: TripDraft): void {
  if (!t.title.trim()) throw new DomainError("bad_input", "A trip needs a title");
  if (t.startsOn && t.endsOn && t.endsOn < t.startsOn) throw new DomainError("bad_input", "The trip can't end before it starts");
}

export async function createTrip(db: Db, tenant: Tenant, draft: TripDraft): Promise<string> {
  validateTrip(draft);
  return withTenant(db, tenant, async (q) => {
    const role = await roleOf(q, tenant.memberId);
    if (role === "assistant" || role === null) throw new DomainError("forbidden", "Trips are owned by experts; ask an advisor or owner to create it");
    if (draft.clientId && !(await repo.clientVisible(q, draft.clientId))) throw new DomainError("not_found", "Client not found");
    const id = randomUUID();
    await repo.insertTrip(q, tenant.workspaceId, id, tenant.memberId, { ...draft, title: draft.title.trim() });
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "trip.created", id, { scope: draft.scope });
    return id;
  });
}

export async function updateTrip(db: Db, tenant: Tenant, tripId: string, draft: TripDraft): Promise<void> {
  validateTrip(draft);
  return withTenant(db, tenant, async (q) => {
    const trip = await requireTripEditor(q, tenant, tripId);
    if (draft.scope !== trip.scope && trip.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the trip owner can change who sees this trip");
    if (draft.clientId && draft.clientId !== trip.clientId && !(await repo.clientVisible(q, draft.clientId))) throw new DomainError("not_found", "Client not found");
    await repo.updateTrip(q, tripId, { ...draft, title: draft.title.trim() });
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "trip.updated", tripId, { scope: draft.scope, clientChanged: draft.clientId !== trip.clientId });
  });
}

// ---------------------------------------------------------------------------
// Delegations: a named backup or assistant with scoped, expiring access.

export const MAX_DELEGATION_DAYS = 366;

export async function grantDelegation(
  db: Db,
  tenant: Tenant,
  input: { tripId: string; memberId: string; purpose: "backup" | "assistant"; expiresAt: string },
  now: Date,
): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    await requireTripOwner(q, tenant, input.tripId);
    if (input.memberId === tenant.memberId) throw new DomainError("bad_input", "You already own this trip");
    const member = await repo.getMember(q, input.memberId);
    if (!member || !member.active) throw new DomainError("not_found", "That person isn't an active member of this workspace");
    const expires = new Date(input.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires <= now) throw new DomainError("bad_input", "Access must expire in the future");
    if (expires.getTime() - now.getTime() > MAX_DELEGATION_DAYS * 86_400_000) throw new DomainError("bad_input", "Delegated access can last at most a year");
    await repo.upsertDelegation(q, tenant.workspaceId, input.tripId, input.memberId, input.purpose, expires.toISOString());
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "trip.delegation_granted", input.tripId, {
      memberId: input.memberId,
      purpose: input.purpose,
      expiresAt: expires.toISOString(),
    });
  });
}

export function revokeDelegation(db: Db, tenant: Tenant, tripId: string, memberId: string): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    await requireTripOwner(q, tenant, tripId);
    if (!(await repo.deleteDelegation(q, tripId, memberId))) throw new DomainError("not_found", "No such delegation");
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "trip.delegation_revoked", tripId, { memberId });
  });
}

// ---------------------------------------------------------------------------
// Items

export interface ItemDraft {
  kind: ItemKind;
  title: string;
  supplierName: string | null;
  price: Money | null;
  startsAt: string | null;
  endsAt: string | null;
  credentials: BookingCredentials | null;
  internalNotes: string | null;
}

const notesContext = (itemId: string) => `trip_item:${itemId}:notes`;

function validateItem(d: ItemDraft): void {
  if (!d.title.trim()) throw new DomainError("bad_input", "An item needs a title");
  if (d.startsAt && d.endsAt && d.endsAt < d.startsAt) throw new DomainError("bad_input", "An item can't end before it starts");
  if (d.price && d.price.amountMinor < 0) throw new DomainError("bad_input", "Price can't be negative");
  if (d.credentials) {
    const names = d.credentials.perks.map((p) => p.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) throw new DomainError("bad_input", "A perk is listed twice");
    // Fails early on channels that can't carry this kind of item (e.g. Duffel for a hotel).
    providerForItem({ kind: d.kind, credentials: d.credentials });
  }
}

async function saveNotes(q: Queryable, tenant: Tenant, itemId: string, notes: string | null): Promise<void> {
  const text = notes?.trim() ? notes.trim() : null;
  await repo.setInternalNotes(q, itemId, text ? await encryptFor(q, tenant.workspaceId, notesContext(itemId), text) : null);
}

export async function readNotes(q: Queryable, tenant: Tenant, itemId: string, sealed: string | null): Promise<string | null> {
  return sealed ? decryptFor(q, tenant.workspaceId, notesContext(itemId), sealed) : null;
}

export async function addItem(db: Db, tenant: Tenant, tripId: string, draft: ItemDraft): Promise<string> {
  validateItem(draft);
  return withTenant(db, tenant, async (q) => {
    await visibleTrip(q, tripId);
    const id = randomUUID();
    const item: TripItem = {
      id,
      tripId,
      kind: draft.kind,
      title: draft.title.trim(),
      supplierName: draft.supplierName?.trim() || null,
      state: "design",
      price: draft.price,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      credentials: draft.credentials,
      confirmationRef: null,
    };
    await coreRepo.insertItem(q, tenant.workspaceId, item, await repo.nextItemPosition(q, tripId));
    await saveNotes(q, tenant, id, draft.internalNotes);
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "item.created", id, { tripId, kind: item.kind });
    return id;
  });
}

/** Lapse every open approval that would act on this item, and bring the item back to design. */
async function lapseApprovals(q: Queryable, tenant: Tenant, item: TripItem, reason: string): Promise<TripItem> {
  const open = [...(await coreRepo.listApprovals(q, { tripId: item.tripId, status: "pending" })), ...(await coreRepo.listApprovals(q, { tripId: item.tripId, status: "approved" }))];
  for (const a of open) {
    if (!a.actions.some((x) => x.itemId === item.id && (x.kind === "book" || x.kind === "pay"))) continue;
    await repo.markApprovalWithdrawn(q, withdrawApproval(a, reason));
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "approval.withdrawn", a.id, { reason });
    // Other items on the same approval lose their authorization too.
    for (const x of a.actions) {
      if (x.itemId === item.id) continue;
      const other = await coreRepo.getItem(q, x.itemId);
      if (other && (other.state === "awaiting_approval" || other.state === "approved")) await coreRepo.updateItemState(q, transitionItem(other, "design"));
    }
  }
  if (item.state === "awaiting_approval" || item.state === "approved") {
    const next = transitionItem(item, "design");
    await coreRepo.updateItemState(q, next);
    return next;
  }
  return item;
}

export async function updateItem(db: Db, tenant: Tenant, itemId: string, draft: ItemDraft): Promise<{ lapsedApproval: boolean }> {
  validateItem(draft);
  return withTenant(db, tenant, async (q) => {
    const item = await visibleItem(q, itemId);
    if (!canEditItem(item.state)) throw new DomainError("not_editable", `A ${item.state.replace(/_/g, " ")} item is changed through the supplier, not edited here`);
    const next: TripItem = {
      ...item,
      kind: draft.kind,
      title: draft.title.trim(),
      supplierName: draft.supplierName?.trim() || null,
      price: draft.price,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      credentials: draft.credentials,
    };
    const material = materialChange(item, next);
    let lapsed = false;
    if (material && (item.state === "awaiting_approval" || item.state === "approved")) {
      await lapseApprovals(q, tenant, item, "Item details changed after the approval was requested");
      lapsed = true;
    }
    await repo.saveItemDetails(q, next);
    await saveNotes(q, tenant, itemId, draft.internalNotes);
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "item.updated", itemId, { material, lapsedApproval: lapsed });
    return { lapsedApproval: lapsed };
  });
}

/** The transitions people make by hand. Supplier-facing transitions happen only in execution. */
export type ManualMove = "propose" | "to_design" | "cancel" | "accept_change";

const MOVE_TARGET: Record<ManualMove, ItemState> = { propose: "proposed", to_design: "design", cancel: "canceled", accept_change: "confirmed" };

export function moveItem(db: Db, tenant: Tenant, itemId: string, move: ManualMove): Promise<TripItem> {
  return withTenant(db, tenant, async (q) => {
    let item = await visibleItem(q, itemId);
    if (move === "cancel" && !PRE_SUPPLIER_STATES.includes(item.state)) {
      throw new DomainError("needs_supplier", "This booking is held with a supplier: request approval to cancel it instead");
    }
    if (move === "accept_change" && item.state !== "disrupted") throw new DomainError("invalid_transition", "Only a disrupted item can have its change accepted");
    if (move === "to_design" && item.state === "confirmed") throw new DomainError("invalid_transition", "A confirmed booking can't go back to design");
    if (move === "cancel" || (move === "to_design" && (item.state === "awaiting_approval" || item.state === "approved"))) {
      const lapsed = await lapseApprovals(q, tenant, item, move === "cancel" ? "Item canceled" : "Item returned to design");
      item = lapsed;
    }
    const next = item.state === MOVE_TARGET[move] ? item : transitionItem(item, MOVE_TARGET[move]);
    await coreRepo.updateItemState(q, next);
    await repo.setExecutionNote(q, itemId, null);
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, `item.${move}`, itemId, { from: item.state, to: next.state });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Duffel offers and travelers

async function lapseIfMaterial(q: Queryable, tenant: Tenant, before: TripItem, after: TripItem, reason: string): Promise<void> {
  if (materialChange(before, after) && (before.state === "awaiting_approval" || before.state === "approved")) await lapseApprovals(q, tenant, before, reason);
}

/** Select a Duffel offer for a flight: re-read it from Duffel and store a snapshot of its terms. */
export async function selectDuffelOffer(db: Db, tenant: Tenant, itemId: string, offerId: string, client: DuffelClient): Promise<OfferSnapshot> {
  const item = await withTenant(db, tenant, (q) => visibleItem(q, itemId));
  if (!canEditItem(item.state)) throw new DomainError("not_editable", "This flight is already with the airline");
  if (providerForItem(item) !== "duffel") throw new DomainError("bad_input", "This item's permitted channel isn't Duffel");
  const snap = snapshotOffer(await client.getOffer(offerId));
  return withTenant(db, tenant, async (q) => {
    const current = await visibleItem(q, itemId);
    const extras = await repo.getItemExtras(q, itemId);
    const route = snap.slices.map((s) => `${s.origin} → ${s.destination}`).join(", ");
    const next: TripItem = {
      ...current,
      supplierName: snap.owner,
      price: snap.price,
      startsAt: snap.slices[0]?.departingAt ? new Date(snap.slices[0].departingAt).toISOString() : current.startsAt,
      endsAt: snap.slices.at(-1)?.arrivingAt ? new Date(snap.slices.at(-1)!.arrivingAt).toISOString() : current.endsAt,
      title: current.title || route,
    };
    await lapseIfMaterial(q, tenant, current, next, "A different flight offer was selected");
    await repo.saveItemDetails(q, next);
    await repo.setBookingOffer(q, itemId, snap);
    // Travelers were entered against the previous offer's passenger count; keep them only if it still matches.
    if (extras?.bookingOffer && extras.bookingOffer.passengerIds.length !== snap.passengerIds.length) await repo.setBookingRequest(q, itemId, null);
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "item.offer_selected", itemId, { provider: "duffel", offerId: snap.offerId, price: snap.price });
    return snap;
  });
}

const NAME_RE = /^[\p{L}][\p{L}' .-]{0,59}$/u;

export function saveTravelers(db: Db, tenant: Tenant, itemId: string, travelers: TravelerDetails[]): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const item = await visibleItem(q, itemId);
    if (!canEditItem(item.state)) throw new DomainError("not_editable", "This flight is already with the airline");
    const extras = await repo.getItemExtras(q, itemId);
    if (!extras?.bookingOffer) throw new DomainError("no_offer", "Select an offer before adding travelers");
    if (travelers.length !== extras.bookingOffer.passengerIds.length) {
      throw new DomainError("bad_input", `This offer is for ${extras.bookingOffer.passengerIds.length} travelers`);
    }
    for (const t of travelers) {
      if (!NAME_RE.test(t.given_name) || !NAME_RE.test(t.family_name)) throw new DomainError("bad_input", "Names must be as on the passport, letters only");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.born_on)) throw new DomainError("bad_input", "Date of birth must be a date");
      if (!/^\+[1-9]\d{6,14}$/.test(t.phone_number)) throw new DomainError("bad_input", "Phone numbers must be in international format, e.g. +15555550123");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.email)) throw new DomainError("bad_input", "A traveler email is invalid");
    }
    await repo.setBookingRequest(q, itemId, await encryptFor(q, tenant.workspaceId, travelersContext(itemId), JSON.stringify(travelers)));
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "item.travelers_saved", itemId, { count: travelers.length });
  });
}

export async function readTravelers(q: Queryable, tenant: Tenant, itemId: string, sealed: string | null): Promise<TravelerDetails[] | null> {
  return sealed ? (JSON.parse(await decryptFor(q, tenant.workspaceId, travelersContext(itemId), sealed)) as TravelerDetails[]) : null;
}

// ---------------------------------------------------------------------------
// Approvals

/**
 * An approval covering a Duffel booking uses the offer's own terms (price,
 * expiry, fare conditions) and covers only that flight, so the pre-booking
 * re-read compares like with like.
 */
function alignWithOffer(actions: ActionSpec[], terms: MaterialTerms, items: TripItem[], offers: Map<string, OfferSnapshot | null>): MaterialTerms {
  const duffelBooks = actions.filter((a) => a.kind === "book" && (() => {
    const it = items.find((i) => i.id === a.itemId);
    return it ? providerForItem(it) === "duffel" : false;
  })());
  if (duffelBooks.length === 0) return terms;
  const itemId = duffelBooks[0]!.itemId;
  if (actions.some((a) => a.itemId !== itemId)) throw new DomainError("bad_input", "Approve a Duffel flight on its own; its terms come from the airline's offer");
  const offer = offers.get(itemId);
  if (!offer) throw new DomainError("no_offer", "Select a Duffel offer before requesting approval");
  return { ...terms, price: offer.price, offerExpiresAt: offer.expiresAt, cancellationPolicy: offer.cancellationPolicy };
}

export function requestItemApproval(
  db: Db,
  tenant: Tenant,
  input: { tripId: string; actions: ActionSpec[]; terms: MaterialTerms },
  now: Date,
): Promise<Approval> {
  return withTenant(db, tenant, async (q) => {
    await visibleTrip(q, input.tripId);
    const items = await coreRepo.listItems(q, input.tripId);
    validateApprovalActions(input.actions, items);
    for (const a of input.actions) {
      if (a.kind !== "book") continue;
      const missing = missingCredentialFields(items.find((i) => i.id === a.itemId)!);
      if (missing.length) throw new DomainError("incomplete_credentials", `Fill the booking credentials first (${missing.join(", ")})`);
    }
    const offers = new Map<string, OfferSnapshot | null>();
    for (const a of input.actions) offers.set(a.itemId, (await repo.getItemExtras(q, a.itemId))?.bookingOffer ?? null);
    const terms = alignWithOffer(input.actions, input.terms, items, offers);
    if (new Date(terms.offerExpiresAt) <= now) throw new DomainError("offer_expired", "The offer has already expired; re-quote first");
    if (terms.price.amountMinor < 0) throw new DomainError("bad_input", "Price can't be negative");
    if (!terms.cancellationPolicy.trim() || !terms.actor.trim()) throw new DomainError("bad_input", "Cancellation terms and who will act are required");

    // A new request for the same action replaces any open one: one decision per action, never two.
    const open = [...(await coreRepo.listApprovals(q, { tripId: input.tripId, status: "pending" })), ...(await coreRepo.listApprovals(q, { tripId: input.tripId, status: "approved" }))];
    const approval = newApproval({ id: randomUUID(), tripId: input.tripId, actions: input.actions, terms, requestedBy: tenant.memberId });
    await coreRepo.insertApproval(q, tenant.workspaceId, approval);
    await repo.setApprovalRequester(q, approval.id, tenant.memberId);
    for (const old of open) {
      if (!old.actions.some((x) => input.actions.some((y) => y.kind === x.kind && y.itemId === x.itemId))) continue;
      await repo.markApprovalWithdrawn(q, withdrawApproval(old, `Superseded by ${approval.id}`), approval.id);
      await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "approval.withdrawn", old.id, { supersededBy: approval.id });
    }
    for (const a of input.actions) {
      const item = await coreRepo.getItem(q, a.itemId);
      const to = item ? stateOnApprovalRequest(item, a) : null;
      if (item && to) await coreRepo.updateItemState(q, transitionItem(item, to));
    }
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "approval.requested", approval.id, { tripId: input.tripId, actions: approval.actions, terms });
    return approval;
  });
}

/** Replace an expired or changed approval with fresh terms over the same actions. */
export function requoteItemApproval(db: Db, tenant: Tenant, approvalId: string, terms: MaterialTerms, now: Date): Promise<Approval> {
  return withTenant(db, tenant, async (q) => {
    const old = await coreRepo.getApproval(q, approvalId);
    if (!old) throw new DomainError("not_found", "Approval not found");
    const items = await coreRepo.listItems(q, old.tripId);
    const offers = new Map<string, OfferSnapshot | null>();
    for (const a of old.actions) offers.set(a.itemId, (await repo.getItemExtras(q, a.itemId))?.bookingOffer ?? null);
    const aligned = alignWithOffer(old.actions, terms, items, offers);
    const { withdrawn, fresh } = requote(old, { id: randomUUID(), terms: aligned, requestedBy: tenant.memberId, now });
    await coreRepo.insertApproval(q, tenant.workspaceId, fresh);
    await repo.setApprovalRequester(q, fresh.id, tenant.memberId);
    await repo.markApprovalWithdrawn(q, withdrawn, fresh.id);
    for (const a of fresh.actions) {
      const item = await coreRepo.getItem(q, a.itemId);
      // An approval that had already been given lapses with the old terms.
      if (item?.state === "approved" && a.kind === "book") await coreRepo.updateItemState(q, transitionItem(item, "awaiting_approval"));
    }
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "approval.requoted", fresh.id, { replaces: old.id, terms: fresh.terms });
    return fresh;
  });
}

/** The requester, the trip owner or a workspace owner can withdraw a request. */
export function withdrawItemApproval(db: Db, tenant: Tenant, approvalId: string): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const a = await coreRepo.getApproval(q, approvalId);
    if (!a) throw new DomainError("not_found", "Approval not found");
    const trip = await visibleTrip(q, a.tripId);
    const role = await roleOf(q, tenant.memberId);
    if (a.requestedBy !== tenant.memberId && trip.ownerId !== tenant.memberId && role !== "owner") {
      throw new DomainError("forbidden", "Only the requester or the trip owner can withdraw this");
    }
    await repo.markApprovalWithdrawn(q, withdrawApproval(a, "Withdrawn"));
    for (const x of a.actions) {
      const item = await coreRepo.getItem(q, x.itemId);
      if (item && x.kind === "book" && (item.state === "awaiting_approval" || item.state === "approved")) await coreRepo.updateItemState(q, transitionItem(item, "design"));
    }
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "approval.withdrawn", approvalId, {});
  });
}

// ---------------------------------------------------------------------------
// Execution requests (the work itself runs in jobs)

export interface ExecutionRequestInput {
  itemId: string;
  /** Required for rails with no API: the person re-checked the terms with the supplier just now. */
  termsRechecked: boolean;
}

async function queueExecution(
  q: Queryable,
  tenant: Tenant,
  kind: "trips.book" | "trips.cancel" | "trips.reconcile",
  item: TripItem,
  termsConfirmation: TermsConfirmation | null,
  now: Date,
): Promise<void> {
  // The claim on the item row is the de-duplication: one outstanding request per item.
  const marker = await repo.claimExecutionRequest(q, item.id, now);
  if (!marker) throw new DomainError("already_queued", "This item already has work queued; wait for it to finish");
  await enqueueAsTenant(q, { kind, payload: { itemId: item.id, termsConfirmation }, maxAttempts: 5 });
}

export function requestBooking(db: Db, tenant: Tenant, input: ExecutionRequestInput, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const item = await visibleItem(q, input.itemId);
    if (item.state !== "approved") throw new DomainError("not_approved", `Only approved items can be booked (this one is ${item.state.replace(/_/g, " ")})`);
    const provider = providerForItem(item);
    const extras = await repo.getItemExtras(q, item.id);
    if (provider === "duffel" && (!extras?.bookingOffer || !extras.bookingRequestEnc)) throw new DomainError("no_offer", "Select an offer and add travelers first");
    if (provider === "manual" && !input.termsRechecked) {
      throw new DomainError("terms_not_rechecked", "Confirm you re-checked price, availability and cancellation terms with the supplier");
    }
    const confirmation = provider === "manual" ? { by: tenant.memberId, at: now.toISOString() } : null;
    await queueExecution(q, tenant, "trips.book", item, confirmation, now);
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "booking.requested", item.id, { provider, termsRechecked: Boolean(confirmation) });
  });
}

export function requestCancellation(db: Db, tenant: Tenant, input: ExecutionRequestInput, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const item = await visibleItem(q, input.itemId);
    if (!SUPPLIER_HELD_STATES.includes(item.state)) throw new DomainError("invalid_transition", "Only a booking held with a supplier is cancelled this way");
    const extras = await repo.getItemExtras(q, item.id);
    const provider = extras?.provider ?? providerForItem(item);
    if (provider === "manual" && !input.termsRechecked) throw new DomainError("terms_not_rechecked", "Confirm you re-checked the cancellation terms with the supplier");
    const confirmation = provider === "manual" ? { by: tenant.memberId, at: now.toISOString() } : null;
    await queueExecution(q, tenant, "trips.cancel", item, confirmation, now);
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "cancellation.requested", item.id, { provider });
  });
}

export function requestReconcile(db: Db, tenant: Tenant, itemId: string, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const item = await visibleItem(q, itemId);
    if (!["outcome_unknown", "booking", "cancel_requested"].includes(item.state)) throw new DomainError("nothing_to_reconcile", "Nothing is waiting on the supplier for this item");
    await queueExecution(q, tenant, "trips.reconcile", item, null, now);
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "booking.reconcile_requested", itemId, {});
  });
}

// ---------------------------------------------------------------------------
// Manual confirmations

/**
 * Record what a supplier with no API said. A confirmation number confirms the
 * booking (or cancellation); "no reservation" fails it. Either way the item
 * is resolved through reconciliation against the same idempotency key, so
 * the record and the item can't disagree.
 */
export async function recordManualOutcome(
  db: Db,
  tenant: Tenant,
  input: { taskId: string; outcome: "confirmed" | "not_found"; confirmationRef: string | null; note: string | null },
  deps: ProviderDeps,
  now: Date,
): Promise<TripItem> {
  const ref = input.confirmationRef?.trim() || null;
  if (input.outcome === "confirmed" && !ref) throw new DomainError("bad_input", "Enter the supplier's confirmation number");
  const task = await withTenant(db, tenant, async (q) => {
    const t = await repo.getManual(q, input.taskId);
    if (!t) throw new DomainError("not_found", "Confirmation task not found");
    const ok = await repo.resolveManualTask(q, t.id, { status: input.outcome, confirmationRef: ref, note: input.note?.trim() || null, recordedBy: tenant.memberId, now });
    if (!ok) throw new DomainError("already_recorded", "This confirmation was already recorded");
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, `manual_confirmation.${input.outcome}`, t.itemId, { taskId: t.id, action: t.action, confirmationRef: ref });
    return t;
  });
  const manualDeps: ProviderDeps = { ...deps, override: (p, it) => (p === "manual" ? new ManualAdapter(db, tenant, it) : (deps.override?.(p, it) ?? null)) };
  const item = await withTenant(db, tenant, (q) => visibleItem(q, task.itemId));
  if (task.action === "book") {
    if (item.state === "booking") await recoverInterrupted(db, tenant, item, manualDeps, now, true);
    else if (item.state === "outcome_unknown") await reconcileBooking(db, tenant, item, manualDeps);
  } else if (item.state === "cancel_requested") {
    await reconcileCancellation(db, tenant, item, manualDeps, now, true);
  }
  return withTenant(db, tenant, (q) => visibleItem(q, task.itemId));
}
