/**
 * Expert judgment capture. Separate taste from circumstance: an expert may
 * reject a hotel because they dislike its atmosphere, because it's wrong for
 * this client, because the right rooms are gone, because of construction this
 * month, or because another option fits the itinerary better. Each reason
 * updates a different record.
 */
import type { Id } from "./common";

export type DecisionKind = "select" | "reject" | "edit";

export type ReasonCategory =
  | "expert_taste" // -> the expert's taste model
  | "client_preference" // -> the client brief
  | "supplier_condition" // -> the supplier record, dated
  | "trip_constraint"; // -> this trip only

export type LearningTarget = "taste_model" | "client_brief" | "supplier_record" | "trip";

export const ROUTE: Record<ReasonCategory, LearningTarget> = {
  expert_taste: "taste_model",
  client_preference: "client_brief",
  supplier_condition: "supplier_record",
  trip_constraint: "trip",
};

export interface Decision {
  id: Id;
  expertId: Id;
  tripId: Id;
  clientId: Id | null;
  supplierId: Id | null;
  kind: DecisionKind;
  subject: string; // what was chosen/rejected/edited, e.g. "Hotel Esencia"
  /** Before/after for edits. */
  before: string | null;
  after: string | null;
  decidedAt: string;
  reason: CapturedReason | null;
}

export interface CapturedReason {
  category: ReasonCategory;
  text: string;
  /** Where the reason came from: already in the conversation, or asked for. */
  origin: "conversation" | "asked" | "inferred";
  /** Supplier conditions are dated; they expire. */
  validUntil: string | null;
}

export interface LearningUpdate {
  target: LearningTarget;
  decisionId: Id;
  /** The record the update applies to: expert, client, supplier or trip id. */
  recordId: Id;
  summary: string;
  observedAt: string;
  validUntil: string | null;
  /** Inferred reasons are held as provisional until the expert endorses them. */
  provisional: boolean;
}

export function routeDecision(d: Decision): LearningUpdate | null {
  if (!d.reason) return null;
  const target = ROUTE[d.reason.category];
  const recordId =
    target === "taste_model" ? d.expertId : target === "client_brief" ? d.clientId : target === "supplier_record" ? d.supplierId : d.tripId;
  // A client or supplier reason with no record to attach to is kept on the trip.
  const resolvedTarget: LearningTarget = recordId ? target : "trip";
  const verb = d.kind === "select" ? "Selected" : d.kind === "reject" ? "Rejected" : "Edited";
  return {
    target: resolvedTarget,
    decisionId: d.id,
    recordId: recordId ?? d.tripId,
    summary: `${verb} ${d.subject}: ${d.reason.text}`,
    observedAt: d.decidedAt,
    validUntil: d.reason.category === "supplier_condition" ? d.reason.validUntil : null,
    provisional: d.reason.origin === "inferred",
  };
}

/**
 * The reason is captured when it is already in the conversation; the agent
 * asks a short question only when the answer would materially improve future
 * work. Selections the expert makes routinely don't warrant a question; a
 * rejection or edit of a supplier-level choice with an unknown reason does.
 */
export function shouldAskWhy(
  d: Decision,
  opts: { inferredConfidence: number | null; similarUnexplainedCount: number },
): boolean {
  if (d.reason && d.reason.origin !== "inferred") return false;
  if (d.kind === "select") return false;
  if (opts.inferredConfidence !== null && opts.inferredConfidence >= 0.8) return false;
  // Supplier-level choices, or a pattern of unexplained changes, are worth one short question.
  return d.supplierId !== null || opts.similarUnexplainedCount >= 2;
}

/**
 * The test is not whether drafts resemble past work but whether the expert
 * endorses the recommendation for a new client and situation.
 */
export function endorsementRate(outcomes: readonly { endorsed: boolean; editedMaterially: boolean }[]): {
  endorsedUnchanged: number;
  endorsedWithEdits: number;
  rejected: number;
  rate: number;
} {
  const endorsedUnchanged = outcomes.filter((o) => o.endorsed && !o.editedMaterially).length;
  const endorsedWithEdits = outcomes.filter((o) => o.endorsed && o.editedMaterially).length;
  const rejected = outcomes.filter((o) => !o.endorsed).length;
  return { endorsedUnchanged, endorsedWithEdits, rejected, rate: outcomes.length ? endorsedUnchanged / outcomes.length : 0 };
}
