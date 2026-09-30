/**
 * Collaboration between experts. A full trip partnership is never the minimum
 * unit. The specialist sees an anonymized brief; terms are agreed; only then
 * do they receive the client details the work needs, and that access expires
 * afterwards. Compensation says who gets paid; authority says who decides.
 */
import { assertTransition, DomainError, type Id, type Money } from "./common";

export type ContributionType = "answer_question" | "review_itinerary" | "activate_relationship" | "design_segment" | "operate_segment";

export type CollaborationState = "requested" | "brief_shared" | "terms_agreed" | "active" | "completed" | "declined" | "withdrawn";

export const COLLAB_TRANSITIONS: Readonly<Record<CollaborationState, readonly CollaborationState[]>> = {
  requested: ["brief_shared", "declined", "withdrawn"],
  brief_shared: ["terms_agreed", "declined", "withdrawn"],
  terms_agreed: ["active", "withdrawn"],
  active: ["completed", "withdrawn"],
  completed: [],
  declined: [],
  withdrawn: [],
};

export type FeeKind = "commission_split" | "advisory" | "design" | "referral" | "execution";

export interface FeeLine {
  kind: FeeKind;
  /** Fixed amount, or a share of commission on specific booking lines. */
  amount: Money | null;
  commissionShareBps: number | null; // basis points, 10000 = 100%
  bookingItemIds: Id[];
}

export interface DecisionAuthority {
  briefOwner: Id;
  finalRecommendationOwner: Id;
  delegatedDecisions: string[];
  changesRequiringSpecialistReview: string[];
  /** Per item: who owns delivery and recovery. */
  deliveryOwners: Record<Id, Id>;
  /** When the specialist's name may be attached to the result. */
  attributionRule: "never" | "with_endorsement" | "always";
  specialistVisibleToClient: boolean;
}

export interface Collaboration {
  id: Id;
  tripId: Id;
  requesterId: Id;
  specialistId: Id;
  contribution: ContributionType;
  state: CollaborationState;
  authority: DecisionAuthority | null;
  fees: FeeLine[];
  nonSolicit: boolean;
  clientAccessExpiresAt: string | null;
}

export function transitionCollaboration(c: Collaboration, to: CollaborationState): Collaboration {
  assertTransition(COLLAB_TRANSITIONS, c.state, to, `collaboration ${c.id}`);
  if (to === "terms_agreed" && !c.authority) throw new DomainError("no_authority", "Decision authority must be agreed with terms");
  if (to === "terms_agreed" && c.fees.length === 0) throw new DomainError("no_fees", "Compensation must be agreed with terms");
  return { ...c, state: to };
}

/** Client details are visible to the specialist only while terms are agreed and access hasn't expired. */
export function specialistMaySeeClientDetails(c: Collaboration, now: Date): boolean {
  if (c.state !== "terms_agreed" && c.state !== "active") return false;
  return c.clientAccessExpiresAt === null || new Date(c.clientAccessExpiresAt) > now;
}

/** Anonymized brief: what the specialist sees before terms. */
export function anonymizeBrief(brief: { clientName: string; text: string; partySize: number; budgetBand: string; dates: string }) {
  const escaped = brief.clientName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    text: brief.text.replace(new RegExp(escaped, "gi"), "[client]"),
    partySize: brief.partySize,
    budgetBand: brief.budgetBand,
    dates: brief.dates,
  };
}

export interface Endorsement {
  specialistId: Id;
  recommendationId: Id;
  /** Fingerprint of the recommendation as reviewed. */
  reviewedFingerprint: string;
}

/** If a recommendation changes materially, the endorsement lapses until they review it again. */
export function endorsementHolds(e: Endorsement, currentFingerprint: string): boolean {
  return e.reviewedFingerprint === currentFingerprint;
}
