/**
 * Protect human attention. Bring experts only consequential decisions, with
 * context and a recommended action. This builds the expert's queue from the
 * rest of the domain.
 */
import type { Approval } from "./approvals";
import type { TripItem } from "./bookings";
import type { Commitment } from "./commitments";
import { formatMoney, type Id } from "./common";
import type { Nudge } from "./crm";

export type AttentionKind =
  | "approval"
  | "reconcile"
  | "disruption"
  | "commitment_review"
  | "commitment_overdue"
  | "relationship_nudge"
  | "publication"
  | "unhappy_client"
  | "inbox"
  | "payout"
  | "collaboration"
  | "introduction"
  | "decision_question"
  | "learning"
  | "extraction";

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  tripId: Id | null;
  title: string;
  context: string;
  recommendedAction: string;
  /** Lower = sooner. Minutes until it matters; 0 = now. */
  urgencyMinutes: number;
  /** Where the decision is made, when it isn't on the Today page itself. */
  href?: string;
}

export interface AttentionInput {
  now: Date;
  approvals: readonly Approval[];
  items: readonly TripItem[];
  commitments: readonly Commitment[];
  nudges: readonly Nudge[];
  pendingPublicationIds: readonly Id[];
  /** Already-shaped items from other areas (inbox, money, network, ...). */
  extra?: readonly AttentionItem[];
  /** Approvals the client has accepted on the portal: surfaced ahead of the rest. */
  clientAcceptedApprovalIds?: ReadonlySet<Id>;
}

export function buildAttentionQueue(input: AttentionInput): AttentionItem[] {
  const { now } = input;
  const minsUntil = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 60_000));
  const out: AttentionItem[] = [];

  for (const a of input.approvals) {
    if (a.status !== "pending") continue;
    const expired = new Date(a.terms.offerExpiresAt) <= now;
    const clientAccepted = input.clientAcceptedApprovalIds?.has(a.id) ?? false;
    out.push({
      key: `approval:${a.id}`,
      kind: "approval",
      tripId: a.tripId,
      title: `${expired ? "Expired" : "Approve"}: ${a.actions.map((x) => x.kind).join(", ")} (${formatMoney(a.terms.price)})`,
      context: `${clientAccepted ? "The client has accepted this on the portal. " : ""}Cancellation: ${a.terms.cancellationPolicy}. ${a.terms.downstreamChanges.length ? `Also changes: ${a.terms.downstreamChanges.join("; ")}. ` : ""}Actor: ${a.terms.actor}.`,
      recommendedAction: expired ? "Re-quote before approving; the offer lapsed" : "Approve or reject before the offer expires",
      urgencyMinutes: expired || clientAccepted ? 0 : minsUntil(a.terms.offerExpiresAt),
    });
  }

  for (const it of input.items) {
    if (it.state === "outcome_unknown") {
      out.push({
        key: `reconcile:${it.id}`,
        kind: "reconcile",
        tripId: it.tripId,
        title: `Outcome unknown: ${it.title}`,
        context: "A request went out and no result came back. Do not retry until reconciled; a blind retry can double-book.",
        recommendedAction: "Confirm with the supplier whether the reservation exists",
        urgencyMinutes: 0,
      });
    } else if (it.state === "disrupted") {
      out.push({
        key: `disruption:${it.id}`,
        kind: "disruption",
        tripId: it.tripId,
        title: `Disrupted: ${it.title}`,
        context: "Supplier- or airline-initiated change. Check whole-trip consequences.",
        recommendedAction: "Review the knock-on effects and choose: accept, rebook or cancel",
        urgencyMinutes: 0,
      });
    }
  }

  for (const c of input.commitments) {
    if (c.reviewStatus === "needs_review") {
      out.push({
        key: `commitment_review:${c.id}`,
        kind: "commitment_review",
        tripId: c.tripId,
        title: `Check commitment: ${c.promisor} — ${c.promise}`,
        context: `Evidence: ${c.evidence.replace(/_/g, " ")}${c.evidence === "machine_transcript" && !c.transcriptVerified ? " (unchecked)" : ""}. Confidence ${Math.round(c.confidence * 100)}%.`,
        recommendedAction: "Confirm or correct, then the agent files it and sends the recap",
        urgencyMinutes: c.dueBy ? minsUntil(c.dueBy) : 24 * 60,
      });
    } else if ((c.state === "pending" || c.state === "disputed") && c.dueBy && new Date(c.dueBy) < now) {
      out.push({
        key: `commitment_overdue:${c.id}`,
        kind: "commitment_overdue",
        tripId: c.tripId,
        title: `Overdue: ${c.promisor} — ${c.promise}`,
        context: `Was due ${c.dueBy.slice(0, 10)}.`,
        recommendedAction: "Chase the supplier or line up the fallback",
        urgencyMinutes: 0,
      });
    }
  }

  for (const n of input.nudges) {
    out.push({
      key: `nudge:${n.personId}:${n.kind}`,
      kind: "relationship_nudge",
      tripId: null,
      title: n.message,
      context: "Drafted by the agent; you send it under your own name.",
      recommendedAction: n.kind === "recognition_overdue" ? "Send a note or review before the next ask" : "Reach out",
      urgencyMinutes: 7 * 24 * 60,
    });
  }

  for (const id of input.pendingPublicationIds) {
    out.push({
      key: `publication:${id}`,
      kind: "publication",
      tripId: null,
      title: "Knowledge item ready to share",
      context: "Redacted and source-checked. Nothing leaves your private store without your approval.",
      recommendedAction: "Approve, edit or keep private",
      urgencyMinutes: 14 * 24 * 60,
      href: `/knowledge/${id}`,
    });
  }

  out.push(...(input.extra ?? []));

  return out.sort((a, b) => a.urgencyMinutes - b.urgencyMinutes || a.key.localeCompare(b.key));
}
