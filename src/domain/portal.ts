/**
 * The client's view of a trip: one itinerary, in traveler-facing language,
 * with open proposals showing price, expiry, cancellation terms and what else
 * changes. Built from an explicit allow-list of fields, so internal notes,
 * booking credentials, commission, supplier contacts and who-acts details can
 * never reach the portal by accident. Perks are never overstated.
 */
import type { ActionKind, Approval } from "./approvals";
import { describePerksForTraveler, type ItemKind, type ItemState, type TripItem } from "./bookings";
import type { Money } from "./common";

export interface PortalItem {
  id: string;
  kind: ItemKind;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
  tone: "ok" | "warn" | "alert" | "";
  /** Only for confirmed bookings: the supplier's reference the traveler may need at check-in. */
  confirmationRef: string | null;
  perks: string[];
  perksAreProposed: boolean;
}

export interface PortalProposal {
  approvalId: string;
  summary: string[];
  price: Money;
  offerExpiresAt: string;
  expired: boolean;
  cancellationPolicy: string;
  alsoChanges: string[];
  clientAcceptance: { acceptedName: string; acceptedAt: string; termsCurrent: boolean } | null;
}

/** The editorial proposal the advisor sent. Text only: no evidence, sources or alternatives considered. */
export interface PortalDocument {
  version: number;
  title: string;
  intro: string;
  sections: { heading: string; body: string }[];
  closing: string;
}

export function portalDocument(p: { version: number; title: string; intro: string; sections: readonly { heading: string; body: string }[]; closing: string } | null): PortalDocument | null {
  if (!p) return null;
  return {
    version: p.version,
    title: p.title,
    intro: p.intro,
    sections: p.sections.filter((s) => s.heading.trim() || s.body.trim()).map((s) => ({ heading: s.heading, body: s.body })),
    closing: p.closing,
  };
}

export interface PortalView {
  tripTitle: string;
  startsOn: string | null;
  endsOn: string | null;
  agencyName: string;
  advisor: { name: string; email: string };
  items: PortalItem[];
  proposals: PortalProposal[];
  document: PortalDocument | null;
}

export interface ClientAcceptance {
  approvalId: string;
  acceptedName: string;
  acceptedAt: string;
  termsFingerprint: string;
  priceMinor: number;
}

/** Items still being shaped internally, or dropped, are not part of the client's itinerary. */
const HIDDEN: readonly ItemState[] = ["design", "canceled"];

const STATUS: Record<Exclude<ItemState, "design" | "canceled">, [string, PortalItem["tone"]]> = {
  proposed: ["Proposed", ""],
  awaiting_approval: ["Awaiting your go-ahead", "warn"],
  approved: ["Being booked", "warn"],
  booking: ["Being booked", "warn"],
  outcome_unknown: ["Being confirmed with the supplier", "warn"],
  confirmed: ["Confirmed", "ok"],
  failed: ["Being arranged by your advisor", "warn"],
  cancel_requested: ["Cancellation in progress", "warn"],
  disrupted: ["Schedule change: your advisor is on it", "alert"],
};

const ACTION_WORDS: Record<ActionKind, string> = {
  book: "Book",
  pay: "Pay for",
  cancel: "Cancel",
  modify: "Change",
  payout: "Settle",
  send_client_commitment: "Confirm to you",
};

export function portalItems(items: readonly TripItem[]): PortalItem[] {
  return items
    .filter((i) => !HIDDEN.includes(i.state))
    .map((i) => {
      const [status, tone] = STATUS[i.state as keyof typeof STATUS];
      return {
        id: i.id,
        kind: i.kind,
        title: i.title,
        startsAt: i.startsAt,
        endsAt: i.endsAt,
        status,
        tone,
        confirmationRef: i.state === "confirmed" ? i.confirmationRef : null,
        perks: describePerksForTraveler(i.credentials?.perks ?? []),
        perksAreProposed: i.state !== "confirmed",
      };
    });
}

export function portalProposals(
  approvals: readonly Approval[],
  items: readonly TripItem[],
  acceptances: readonly ClientAcceptance[],
  now: Date,
): PortalProposal[] {
  const title = (id: string) => items.find((i) => i.id === id)?.title ?? "an item on your trip";
  return approvals
    .filter((a) => a.status === "pending")
    .map((a) => {
      const acc = acceptances.find((x) => x.approvalId === a.id) ?? null;
      // "pay" rides along with "book" for the same item; say it once.
      const summary = a.actions
        .filter((x) => !(x.kind === "pay" && a.actions.some((y) => y.kind === "book" && y.itemId === x.itemId)))
        .map((x) => `${ACTION_WORDS[x.kind]} ${title(x.itemId)}`);
      return {
        approvalId: a.id,
        summary,
        price: a.terms.price,
        offerExpiresAt: a.terms.offerExpiresAt,
        expired: new Date(a.terms.offerExpiresAt) <= now,
        cancellationPolicy: a.terms.cancellationPolicy,
        alsoChanges: a.terms.downstreamChanges,
        clientAcceptance: acc
          ? {
              acceptedName: acc.acceptedName,
              acceptedAt: acc.acceptedAt,
              termsCurrent: acc.termsFingerprint === a.termsFingerprint && acc.priceMinor === a.terms.price.amountMinor,
            }
          : null,
      };
    });
}

export function buildPortalView(input: {
  trip: { title: string; startsOn: string | null; endsOn: string | null };
  agencyName: string;
  advisor: { name: string; email: string };
  items: readonly TripItem[];
  approvals: readonly Approval[];
  acceptances: readonly ClientAcceptance[];
  document?: Parameters<typeof portalDocument>[0];
  now: Date;
}): PortalView {
  return {
    tripTitle: input.trip.title,
    startsOn: input.trip.startsOn,
    endsOn: input.trip.endsOn,
    agencyName: input.agencyName,
    advisor: { name: input.advisor.name, email: input.advisor.email },
    items: portalItems(input.items),
    proposals: portalProposals(input.approvals, input.items, input.acceptances, input.now),
    document: portalDocument(input.document ?? null),
  };
}
