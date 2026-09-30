/**
 * Trip items. A trip is an overview; every booking, request and commitment
 * keeps its own state, so a trip can hold confirmed flights, a hotel awaiting
 * approval and an unresolved transfer at once. After a disruption one item
 * returns to design while the rest stays booked.
 */
import { assertTransition, type Id, type Money } from "./common";

export type ItemKind = "flight" | "hotel" | "transfer" | "experience" | "dining" | "guide" | "insurance" | "other";

export type ItemState =
  | "design" // being shaped by agents and the expert
  | "proposed" // shown to the client
  | "awaiting_approval" // an executable approval is open
  | "approved" // approval held; not yet sent to the supplier
  | "booking" // request sent to the supplier or rail
  | "outcome_unknown" // request went out, result never came back: reconcile before anything else
  | "confirmed"
  | "failed"
  | "cancel_requested"
  | "canceled"
  | "disrupted"; // supplier- or airline-initiated change; needs a human

export const ITEM_TRANSITIONS: Readonly<Record<ItemState, readonly ItemState[]>> = {
  design: ["proposed", "awaiting_approval", "canceled"],
  proposed: ["design", "awaiting_approval", "canceled"],
  awaiting_approval: ["approved", "design", "canceled"],
  approved: ["booking", "awaiting_approval", "design", "canceled"],
  booking: ["confirmed", "failed", "outcome_unknown"],
  outcome_unknown: ["confirmed", "failed"], // only via reconciliation with the supplier
  confirmed: ["cancel_requested", "disrupted"],
  failed: ["design", "awaiting_approval", "canceled"],
  cancel_requested: ["canceled", "confirmed", "outcome_unknown"],
  canceled: [],
  disrupted: ["design", "confirmed", "cancel_requested"],
};

export function transitionItem(item: TripItem, to: ItemState): TripItem {
  assertTransition(ITEM_TRANSITIONS, item.state, to, `item ${item.id}`);
  return { ...item, state: to };
}

/**
 * Credentials are not one thing: an accreditation number, a program
 * membership, a booking connection and the authority to service a reservation
 * are separate. Every booking carries all of these fields.
 */
export interface BookingCredentials {
  /** Whose authority is being used, e.g. "IATA 12345678" or "Host: Example Travel". */
  bookingEntity: string;
  /** The channel that entity is permitted to book through, e.g. "Duffel", "GDS", "Direct to property". */
  permittedChannel: string;
  /** Program and rate that support the promised perks, e.g. "Four Seasons Preferred Partner" / "BAR flexible". */
  program: string | null;
  rate: string;
  perks: Perk[];
  /** Who can change, cancel or recover the booking, and what they can do. */
  servicingOwner: string;
  servicingActions: ServicingAction[];
  /** Eventual settlement path. */
  commissionRecipient: string;
}

export type ServicingAction = "modify" | "cancel" | "rebook" | "add_services" | "request_upgrade";

export interface Perk {
  name: string;
  basis: "guaranteed" | "availability_dependent";
}

export interface TripItem {
  id: Id;
  tripId: Id;
  kind: ItemKind;
  title: string;
  supplierName: string | null;
  state: ItemState;
  price: Money | null;
  startsAt: string | null;
  endsAt: string | null;
  credentials: BookingCredentials | null;
  /** Supplier's confirmation number once confirmed. */
  confirmationRef: string | null;
}

const REQUIRED_CREDENTIAL_FIELDS = [
  "bookingEntity",
  "permittedChannel",
  "rate",
  "servicingOwner",
  "commissionRecipient",
] as const satisfies readonly (keyof BookingCredentials)[];

/** Returns the credential fields that must be filled before an item can be booked. */
export function missingCredentialFields(item: TripItem): string[] {
  if (!item.credentials) return ["credentials"];
  const c = item.credentials;
  const missing: string[] = REQUIRED_CREDENTIAL_FIELDS.filter((f) => !c[f]?.trim());
  if (c.perks.length > 0 && !c.program) missing.push("program");
  if (c.servicingActions.length === 0) missing.push("servicingActions");
  return missing;
}

/**
 * Traveler-facing perk wording. Never overstate an upgrade or late checkout:
 * availability-dependent perks are described as requested, not promised.
 */
export function describePerksForTraveler(perks: readonly Perk[]): string[] {
  return perks.map((p) =>
    p.basis === "guaranteed" ? p.name : `${p.name} (requested; subject to availability at arrival)`,
  );
}

export type TripStage = "design" | "approvals" | "booking" | "attention" | "booked" | "closed";

/** Trip-level overview derived from item states; the items remain the source of truth. */
export function summarizeTrip(items: readonly TripItem[]): { stage: TripStage; counts: Partial<Record<ItemState, number>> } {
  const counts: Partial<Record<ItemState, number>> = {};
  for (const it of items) counts[it.state] = (counts[it.state] ?? 0) + 1;
  const has = (s: ItemState) => (counts[s] ?? 0) > 0;
  const live = items.filter((i) => i.state !== "canceled");

  let stage: TripStage;
  if (live.length === 0) stage = items.length ? "closed" : "design";
  else if (has("outcome_unknown") || has("disrupted") || has("failed")) stage = "attention";
  else if (has("awaiting_approval")) stage = "approvals";
  else if (has("booking") || has("approved") || has("cancel_requested")) stage = "booking";
  else if (live.every((i) => i.state === "confirmed")) stage = "booked";
  else stage = "design";
  return { stage, counts };
}
