/**
 * Client and trip brief. "Likes luxury hotels" is far less useful than
 * "prefers intimate properties, dislikes visibly formal service". Enduring
 * preferences stay separate from one trip's needs, so a couple's honeymoon and
 * their later multigenerational trip don't inherit the same assumptions.
 */
import type { Id } from "./common";

export type BriefDimension = "desired_experience" | "practical_constraints" | "party_dynamics" | "outcomes";

export interface BriefStatement {
  id: Id;
  clientId: Id;
  /** null = enduring preference; set = applies to this trip only. */
  tripId: Id | null;
  dimension: BriefDimension;
  text: string;
  /** What the client said vs. what the expert inferred. */
  evidence: "client_said" | "expert_inferred" | "agent_inferred";
  source: string; // e.g. "call 2026-09-12", "email", "post-trip debrief"
  recordedAt: string;
  /** Replaced by a newer statement; kept for history. */
  supersededBy: Id | null;
}

/**
 * The brief an agent works from on a given trip: enduring statements plus this
 * trip's own, never another trip's. Agent inferences are included but kept
 * distinguishable, and superseded statements are dropped.
 */
export function briefForTrip(statements: readonly BriefStatement[], clientId: Id, tripId: Id) {
  const live = statements.filter((s) => s.clientId === clientId && s.supersededBy === null && (s.tripId === null || s.tripId === tripId));
  const byDim = (dim: BriefDimension) => live.filter((s) => s.dimension === dim);
  return {
    enduring: live.filter((s) => s.tripId === null),
    thisTrip: live.filter((s) => s.tripId === tripId),
    byDimension: {
      desired_experience: byDim("desired_experience"),
      practical_constraints: byDim("practical_constraints"),
      party_dynamics: byDim("party_dynamics"),
      outcomes: byDim("outcomes"),
    } satisfies Record<BriefDimension, BriefStatement[]>,
    unconfirmedInferences: live.filter((s) => s.evidence === "agent_inferred"),
  };
}

/**
 * Promote a trip-specific statement to an enduring preference. Only the
 * expert does this, since it changes assumptions for every future trip.
 */
export function promoteToEnduring(s: BriefStatement, newId: Id, now: Date): { promoted: BriefStatement; original: BriefStatement } {
  const promoted: BriefStatement = { ...s, id: newId, tripId: null, recordedAt: now.toISOString(), supersededBy: null };
  return { promoted, original: { ...s, supersededBy: newId } };
}
