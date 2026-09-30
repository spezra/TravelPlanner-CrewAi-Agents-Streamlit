/**
 * Collaboration terms, sides and the rules around client details. Builds on
 * ./collaboration.ts (states, anonymized brief, endorsements).
 *
 * Terms are versioned. Proposing a version counts as the proposer accepting
 * it; the other side then accepts that exact version (by fingerprint) or
 * proposes another, which supersedes it. Only when both sides have accepted
 * the same version does the specialist receive client details, and only
 * until the agreed expiry.
 */
import { DomainError, fingerprint, type Id, type Money } from "./common";
import type { CollaborationState, ContributionType, DecisionAuthority, FeeKind } from "./collaboration";

export type Side = "requester" | "specialist";

export const CONTRIBUTION_LABEL: Record<ContributionType, string> = {
  answer_question: "Answer a narrow question",
  review_itinerary: "Review an itinerary",
  activate_relationship: "Activate a relationship",
  design_segment: "Design a trip segment",
  operate_segment: "Operate a trip segment",
};

export interface TermsFeeLine {
  kind: FeeKind;
  /** Who receives this fee. */
  payee: Side;
  /** Fixed fee (advisory, design, referral, execution). */
  amount: Money | null;
  /** Share of commission actually received on the listed booking lines. 10000 = 100%. */
  commissionShareBps: number | null;
  bookingItemIds: Id[];
  /** Labels as the requester saw them, so the specialist can read the line without seeing the trip. */
  bookingItemLabels: string[];
}

export interface CollaborationTerms {
  authority: DecisionAuthority;
  fees: TermsFeeLine[];
  nonSolicit: boolean;
  /** When the specialist's access to client details ends. Required: access always expires. */
  clientAccessExpiresAt: string;
  /** Who bears a loss if a payout is later reversed. */
  reversalLossBearer: Side | "shared_pro_rata";
  notes: string | null;
}

export function termsFingerprint(t: CollaborationTerms): string {
  return fingerprint(t);
}

/** Every problem with a proposed set of terms; empty when they can be proposed. */
export function termsProblems(t: CollaborationTerms, now: Date): string[] {
  const problems: string[] = [];
  if (t.fees.length === 0) problems.push("Compensation must be agreed with terms: add at least one fee line");
  const bpsPerItem = new Map<Id, number>();
  t.fees.forEach((f, i) => {
    const n = `Fee line ${i + 1}`;
    if (f.kind === "commission_split") {
      if (f.amount !== null) problems.push(`${n}: a commission split is a share, not a fixed amount`);
      if (f.commissionShareBps === null || !Number.isInteger(f.commissionShareBps) || f.commissionShareBps <= 0 || f.commissionShareBps > 10_000) {
        problems.push(`${n}: commission share must be between 0.01% and 100%`);
      }
      if (f.bookingItemIds.length === 0) problems.push(`${n}: a commission split applies to specific booking lines`);
      for (const id of f.bookingItemIds) bpsPerItem.set(id, (bpsPerItem.get(id) ?? 0) + (f.commissionShareBps ?? 0));
    } else {
      if (f.commissionShareBps !== null) problems.push(`${n}: ${f.kind} fees are fixed amounts`);
      if (!f.amount || !Number.isInteger(f.amount.amountMinor) || f.amount.amountMinor <= 0) problems.push(`${n}: enter a positive amount`);
      else if (!/^[A-Z]{3}$/.test(f.amount.currency)) problems.push(`${n}: currency must be an ISO code`);
    }
  });
  for (const [id, bps] of bpsPerItem) if (bps > 10_000) problems.push(`Commission shares on booking line ${id} add up to more than 100%`);
  const expires = new Date(t.clientAccessExpiresAt);
  if (Number.isNaN(expires.getTime())) problems.push("Client-detail access needs an expiry date");
  else if (expires <= now) problems.push("Client-detail access must expire in the future");
  const a = t.authority;
  if (!a.briefOwner) problems.push("Name who owns the client brief");
  if (!a.finalRecommendationOwner) problems.push("Name who owns the final recommendation");
  if (!a.specialistVisibleToClient && a.attributionRule === "always") {
    problems.push("The specialist is behind the scenes, so their name can't always be attached");
  }
  return problems;
}

export function assertValidTerms(t: CollaborationTerms, now: Date): void {
  const p = termsProblems(t, now);
  if (p.length) throw new DomainError("invalid_terms", p.join("; "));
}

export interface TermsVersion {
  version: number;
  fingerprint: string;
  proposedBySide: Side;
  requesterAcceptedAt: string | null;
  specialistAcceptedAt: string | null;
  supersededAt: string | null;
}

export const bothAccepted = (v: TermsVersion): boolean => v.requesterAcceptedAt !== null && v.specialistAcceptedAt !== null;

/** The version the parties are currently negotiating: the newest one not superseded. */
export function currentVersion<V extends TermsVersion>(versions: readonly V[]): V | null {
  const live = versions.filter((v) => v.supersededAt === null);
  return live.length ? live.reduce((a, b) => (b.version > a.version ? b : a)) : null;
}

/**
 * One side accepts one exact version. Accepting a superseded version, or a
 * version whose content differs from what they saw, is refused.
 */
export function acceptVersion<V extends TermsVersion>(v: V, latest: V | null, side: Side, seenFingerprint: string, at: Date): V {
  if (v.supersededAt !== null || (latest && latest.version !== v.version)) {
    throw new DomainError("superseded", `Terms v${v.version} were replaced by a newer proposal; review the latest version`);
  }
  if (v.fingerprint !== seenFingerprint) throw new DomainError("terms_changed", "These terms changed since you opened them; review them again");
  const already = side === "requester" ? v.requesterAcceptedAt : v.specialistAcceptedAt;
  if (already) throw new DomainError("already_accepted", `You already accepted terms v${v.version}`);
  return side === "requester" ? { ...v, requesterAcceptedAt: at.toISOString() } : { ...v, specialistAcceptedAt: at.toISOString() };
}

// ---------------------------------------------------------------------------
// Who may do what, by side and state.

export type CollabAction = "accept_request" | "decline_request" | "propose_terms" | "accept_terms" | "start_work" | "complete" | "withdraw" | "share" | "endorse" | "request_activation" | "log_note";

const ALLOWED: Record<CollabAction, { sides: Side[]; states: CollaborationState[] }> = {
  accept_request: { sides: ["specialist"], states: ["requested"] },
  decline_request: { sides: ["specialist"], states: ["requested", "brief_shared"] },
  propose_terms: { sides: ["requester", "specialist"], states: ["brief_shared", "terms_agreed", "active"] },
  accept_terms: { sides: ["requester", "specialist"], states: ["brief_shared", "terms_agreed", "active"] },
  start_work: { sides: ["specialist"], states: ["terms_agreed"] },
  complete: { sides: ["requester"], states: ["active"] },
  withdraw: { sides: ["requester", "specialist"], states: ["requested", "brief_shared", "terms_agreed", "active"] },
  share: { sides: ["requester"], states: ["requested", "brief_shared", "terms_agreed", "active"] },
  endorse: { sides: ["specialist"], states: ["terms_agreed", "active"] },
  request_activation: { sides: ["requester"], states: ["brief_shared", "terms_agreed", "active"] },
  log_note: { sides: ["requester", "specialist"], states: ["requested", "brief_shared", "terms_agreed", "active", "completed", "declined", "withdrawn"] },
};

export function assertMay(action: CollabAction, side: Side, state: CollaborationState): void {
  const rule = ALLOWED[action];
  if (!rule.sides.includes(side)) throw new DomainError("forbidden", `Only the ${rule.sides.join(" or ")} can do that`);
  if (!rule.states.includes(state)) throw new DomainError("invalid_state", `Not possible while the collaboration is ${state.replace("_", " ")}`);
}

export const mayDo = (action: CollabAction, side: Side, state: CollaborationState): boolean => {
  try {
    assertMay(action, side, state);
    return true;
  } catch {
    return false;
  }
};

/**
 * Relationship activation: the holder decides every time. There is no
 * standing yes; a previous yes says nothing about this ask.
 */
export function decideActivation(
  req: { holderMemberId: Id; decision: "pending" | "yes" | "no" },
  deciderId: Id,
  decision: "yes" | "no",
): "yes" | "no" {
  if (deciderId !== req.holderMemberId) throw new DomainError("not_holder", "Only the relationship holder can answer an activation request");
  if (req.decision !== "pending") throw new DomainError("already_decided", "This activation request was already answered");
  return decision;
}

/** When the specialist's name may be attached to the result shown to the client. */
export function specialistNameMayAppear(authority: Pick<DecisionAuthority, "attributionRule" | "specialistVisibleToClient">, endorsementHolds: boolean): boolean {
  if (!authority.specialistVisibleToClient) return false;
  if (authority.attributionRule === "always") return true;
  if (authority.attributionRule === "with_endorsement") return endorsementHolds;
  return false;
}

/**
 * The material content of a recommendation, as the specialist reviews it.
 * An endorsement is fingerprinted over exactly this, so a material change
 * (different property, dates, price, program or perks) lapses it; edits to
 * internal state or position don't.
 */
export function recommendationContent(item: {
  kind: string;
  title: string;
  supplierName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  price: Money | null;
  credentials: { program: string | null; rate: string | null; perks: { name: string; basis: string }[] } | null;
}) {
  return {
    kind: item.kind,
    title: item.title,
    supplier: item.supplierName,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    price: item.price,
    program: item.credentials?.program ?? null,
    rate: item.credentials?.rate ?? null,
    perks: (item.credentials?.perks ?? []).map((p) => `${p.name} (${p.basis.replace("_", " ")})`),
  };
}
