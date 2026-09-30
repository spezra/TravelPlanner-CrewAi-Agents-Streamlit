import type { MaterialTerms } from "@/domain/approvals";
import type { TripItem } from "@/domain/bookings";
import type { Commitment } from "@/domain/commitments";
import type { Observation } from "@/domain/knowledge";

export const NOW = new Date("2026-10-01T12:00:00Z");
export const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

export function terms(over: Partial<MaterialTerms> = {}): MaterialTerms {
  return {
    price: { amountMinor: 1_250_000, currency: "USD" },
    offerExpiresAt: inHours(24),
    cancellationPolicy: "Free cancellation until 14 days before arrival; then 100%",
    downstreamChanges: ["Airport transfer moves to 15:00"],
    actor: "Booking agent via property reservations",
    ...over,
  };
}

export function item(over: Partial<TripItem> = {}): TripItem {
  return {
    id: "item-hotel",
    tripId: "trip-1",
    kind: "hotel",
    title: "Hotel Esencia, 5 nights",
    supplierName: "Hotel Esencia",
    state: "design",
    price: { amountMinor: 1_250_000, currency: "USD" },
    startsAt: "2027-01-10",
    endsAt: "2027-01-15",
    credentials: {
      bookingEntity: "IATA 00000000",
      permittedChannel: "Direct to property",
      program: "Example Preferred Partner",
      rate: "Best flexible rate",
      perks: [
        { name: "Daily breakfast for two", basis: "guaranteed" },
        { name: "Room upgrade", basis: "availability_dependent" },
      ],
      servicingOwner: "expert-1",
      servicingActions: ["modify", "cancel"],
      commissionRecipient: "expert-1 via host agency",
    },
    confirmationRef: null,
    ...over,
  };
}

export function observation(over: Partial<Observation> = {}): Observation {
  return {
    id: "obs-1",
    supplierId: "sup-1",
    observedAt: "2026-06-01",
    source: "firsthand",
    personallyInspected: true,
    statement: "Ocean-view suites on the second floor are quietest",
    applicability: { program: "Virtuoso", roomCategory: "Suite", season: "summer", relationshipInvolved: false },
    request: null,
    outcome: null,
    bookingRef: null,
    ...over,
  };
}

export function commitment(over: Partial<Commitment> = {}): Commitment {
  return {
    id: "c-1",
    tripId: "trip-1",
    itemId: "item-hotel",
    promisor: "Ana (GM)",
    promisorPersonId: "p-ana",
    promise: "Late checkout until 16:00 on departure day",
    conditions: null,
    dueBy: null,
    evidence: "verbal_statement",
    evidenceRef: null,
    state: "pending",
    transcriptVerified: false,
    confidence: 0.9,
    consequential: false,
    reviewStatus: "auto_filed",
    recapSentAt: null,
    deliveredToTravelerAt: null,
    ...over,
  };
}
