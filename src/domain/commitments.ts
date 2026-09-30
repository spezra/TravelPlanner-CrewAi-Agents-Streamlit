/**
 * Every interaction ends as a commitment record. Evidence and state are
 * separate: evidence type records how we know; operational state records what
 * is happening. A supplier can fulfill a verbal promise without ever confirming
 * it in writing, and a written confirmation can still go unfulfilled. A recap
 * email records our understanding, not the supplier's agreement.
 */
import { assertTransition, type Id } from "./common";

export type EvidenceType = "verbal_statement" | "machine_transcript" | "expert_notes" | "written_confirmation";

export type CommitmentState = "pending" | "fulfilled" | "disputed" | "superseded" | "canceled";

export const COMMITMENT_TRANSITIONS: Readonly<Record<CommitmentState, readonly CommitmentState[]>> = {
  pending: ["fulfilled", "disputed", "superseded", "canceled"],
  disputed: ["pending", "fulfilled", "canceled", "superseded"],
  fulfilled: ["disputed"],
  superseded: [],
  canceled: [],
};

export interface Commitment {
  id: Id;
  tripId: Id | null;
  itemId: Id | null;
  /** Who promised: a supplier contact (person id) or "us". */
  promisor: string;
  promisorPersonId: Id | null;
  promise: string;
  conditions: string | null;
  dueBy: string | null;
  evidence: EvidenceType;
  evidenceRef: string | null; // transcript id, email id, note id
  state: CommitmentState;
  /** Machine transcripts stay labeled until names, amounts, dates and speakers are checked. */
  transcriptVerified: boolean;
  /** Agent extraction confidence, 0..1. */
  confidence: number;
  consequential: boolean;
  reviewStatus: "auto_filed" | "needs_review" | "reviewed";
  recapSentAt: string | null;
  deliveredToTravelerAt: string | null;
}

export function transitionCommitment(c: Commitment, to: CommitmentState): Commitment {
  assertTransition(COMMITMENT_TRANSITIONS, c.state, to, `commitment ${c.id}`);
  return { ...c, state: to };
}

/**
 * Consequential or uncertain items go to the expert; the rest file
 * automatically. Approving every fact would spend the scarcest resource on
 * the least valuable work.
 */
export function reviewRouting(c: Pick<Commitment, "consequential" | "confidence" | "evidence" | "transcriptVerified">, threshold = 0.75) {
  const uncertain = c.confidence < threshold || (c.evidence === "machine_transcript" && !c.transcriptVerified);
  return c.consequential || uncertain ? ("needs_review" as const) : ("auto_filed" as const);
}

/** Label shown wherever the commitment is displayed. */
export function evidenceLabel(c: Pick<Commitment, "evidence" | "transcriptVerified">): string {
  switch (c.evidence) {
    case "machine_transcript":
      return c.transcriptVerified ? "Transcript (checked)" : "Machine-transcribed (unchecked)";
    case "verbal_statement":
      return "Verbal statement";
    case "expert_notes":
      return "Expert's notes";
    case "written_confirmation":
      return "Written confirmation";
  }
}

/** A commitment is only followed through when the traveler actually receives it. */
export function openFollowThrough(cs: readonly Commitment[], now: Date) {
  return cs
    .filter((c) => c.state === "pending" || c.state === "disputed")
    .map((c) => ({
      commitment: c,
      overdue: c.dueBy !== null && new Date(c.dueBy) < now,
      needsRecap: c.recapSentAt === null,
    }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.commitment.dueBy ?? "~").localeCompare(b.commitment.dueBy ?? "~"));
}
