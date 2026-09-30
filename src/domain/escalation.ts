/**
 * Escalation of events that need a human: an outcome-unknown booking, a
 * disruption, an overdue commitment, an unhappy client. Each event goes to
 * whoever is on duty, then, if nobody acknowledges within the plan's deadline,
 * to the next responder in the chain, one step at a time. The system can close
 * operational events when their cause clears, but an unhappy client is closed
 * only by the advisor or the named backup.
 */
import { buildAttentionQueue } from "./attention";
import type { TripItem } from "./bookings";
import type { Commitment } from "./commitments";
import { DomainError, type Id } from "./common";
import { currentResponder, escalationTarget, type ResponsePlan } from "./responsePlan";

export type EscalationKind = "reconcile" | "disruption" | "commitment_overdue" | "unhappy_client";

export interface EscalationState {
  kind: EscalationKind;
  raisedAt: string;
  lastNotifiedAt: string | null;
  tried: readonly Id[];
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface EscalationStep {
  memberId: Id;
  role: "primary" | "backup" | "escalation" | "owner";
  step: number;
}

/**
 * The next person to notify, or null when nothing is due. The first
 * notification goes out immediately to whoever is on duty; each later step
 * waits a full acknowledgement deadline after the previous one. Without a
 * response plan the trip owner is the only responder.
 */
export function nextEscalationStep(plan: ResponsePlan | null, tripOwnerId: Id, e: EscalationState, now: Date): EscalationStep | null {
  if (e.acknowledgedAt || e.resolvedAt) return null;
  if (e.tried.length === 0) {
    if (!plan) return { memberId: tripOwnerId, role: "owner", step: 0 };
    const r = currentResponder(plan, now);
    return { memberId: r.memberId, role: r.role, step: 0 };
  }
  if (!plan) return null;
  const since = new Date(e.lastNotifiedAt ?? e.raisedAt);
  const target = escalationTarget(plan, since, now, e.tried);
  if (!target) return null;
  const role = target === plan.primary.memberId ? "primary" : target === plan.backup?.memberId ? "backup" : "escalation";
  return { memberId: target, role, step: e.tried.length };
}

export interface EscalationCandidate {
  sourceKey: string;
  kind: Exclude<EscalationKind, "unhappy_client">;
  tripId: Id;
  title: string;
  detail: string;
}

/**
 * Events from the attention queue that need a human within the response plan:
 * the same definitions the Today page uses, so the two never disagree.
 */
export function escalationCandidates(items: readonly TripItem[], commitments: readonly Commitment[], now: Date): EscalationCandidate[] {
  const queue = buildAttentionQueue({ now, approvals: [], items, commitments, nudges: [], pendingPublicationIds: [] });
  const out: EscalationCandidate[] = [];
  for (const a of queue) {
    if (!a.tripId) continue;
    if (a.kind === "reconcile" || a.kind === "disruption" || a.kind === "commitment_overdue") {
      out.push({ sourceKey: a.key, kind: a.kind, tripId: a.tripId, title: a.title, detail: `${a.context} Recommended: ${a.recommendedAction}` });
    }
  }
  return out;
}

/** The system may close an event only when its cause has cleared, and never an unhappy client. */
export function systemMayResolve(kind: EscalationKind): boolean {
  return kind !== "unhappy_client";
}

/**
 * Who can close an event by hand. An unhappy client is answered by the
 * advisor or the named backup in the response plan: never the system alone,
 * and not an assistant closing it on their behalf.
 */
export function assertCanResolve(
  kind: EscalationKind,
  actor: { id: Id; role: string },
  trip: { ownerId: Id },
  plan: ResponsePlan | null,
  note: string,
): void {
  if (kind === "unhappy_client") {
    const allowed = actor.id === trip.ownerId || (plan?.backup?.memberId ?? null) === actor.id || plan?.primary.memberId === actor.id;
    if (!allowed) throw new DomainError("forbidden", "An unhappy client is closed by the advisor or the named backup");
    if (note.trim().length < 3) throw new DomainError("note_required", "Say how the client was answered");
    return;
  }
  const onPlan = plan && [plan.primary.memberId, plan.backup?.memberId, ...plan.escalation].includes(actor.id);
  if (actor.id !== trip.ownerId && !onPlan && actor.role !== "owner" && actor.role !== "admin") {
    throw new DomainError("forbidden", "Only the trip owner, the responders on its plan, or a workspace owner/admin can close this");
  }
}

/** Acknowledging stops the escalation; anyone the event could have reached may do it. */
export function assertCanAcknowledge(actor: { id: Id; role: string }, trip: { ownerId: Id }, plan: ResponsePlan | null, tried: readonly Id[]): void {
  const onPlan = plan && [plan.primary.memberId, plan.backup?.memberId, ...plan.escalation].includes(actor.id);
  if (actor.id === trip.ownerId || onPlan || tried.includes(actor.id) || actor.role === "owner" || actor.role === "admin") return;
  throw new DomainError("forbidden", "Only a responder on this trip can acknowledge");
}
