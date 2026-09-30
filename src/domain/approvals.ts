/**
 * Executable approvals. Anything that spends money or can't be undone waits
 * for a human. The request carries current price, expiry, cancellation
 * consequences, downstream changes and who will act. One approval can cover a
 * defined set of actions, so an expert never approves the same decision twice
 * as it passes between agents; it renews only when material terms change.
 */
import { DomainError, fingerprint, type Id, type Money } from "./common";

export type ActionKind = "book" | "cancel" | "modify" | "pay" | "payout" | "send_client_commitment";

export interface ActionSpec {
  kind: ActionKind;
  itemId: Id;
}

export interface MaterialTerms {
  price: Money;
  /** When the offered price/availability lapses (ISO timestamp). */
  offerExpiresAt: string;
  cancellationPolicy: string;
  /** What else changes if this goes ahead, e.g. "transfer pickup moves to 14:00". */
  downstreamChanges: string[];
  /** Who or what will perform the actions (an agent, a named staff member, a rail). */
  actor: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "withdrawn";

export interface Approval {
  id: Id;
  tripId: Id;
  actions: ActionSpec[];
  terms: MaterialTerms;
  termsFingerprint: string;
  status: ApprovalStatus;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

/**
 * Only material terms go into the fingerprint. Price is compared separately so
 * that a small decrease need not re-open an approval.
 */
export function termsFingerprint(t: MaterialTerms): string {
  return fingerprint({
    currency: t.price.currency,
    cancellationPolicy: t.cancellationPolicy.trim(),
    downstreamChanges: [...t.downstreamChanges].map((s) => s.trim()).sort(),
  });
}

export function requestApproval(input: {
  id: Id;
  tripId: Id;
  actions: ActionSpec[];
  terms: MaterialTerms;
  requestedBy: string;
}): Approval {
  if (input.actions.length === 0) throw new DomainError("empty_approval", "An approval must cover at least one action");
  return {
    ...input,
    termsFingerprint: termsFingerprint(input.terms),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    note: null,
  };
}

export function decideApproval(
  a: Approval,
  decision: "approved" | "rejected",
  by: string,
  now: Date,
  note: string | null = null,
): Approval {
  if (a.status !== "pending") throw new DomainError("already_decided", `Approval ${a.id} was already ${a.status}`);
  if (decision === "approved" && new Date(a.terms.offerExpiresAt) <= now) {
    throw new DomainError("offer_expired", `Offer on approval ${a.id} expired at ${a.terms.offerExpiresAt}`);
  }
  return { ...a, status: decision, decidedBy: by, decidedAt: now.toISOString(), note };
}

export type CoverageFailure =
  | { code: "not_approved"; detail: string }
  | { code: "action_not_covered"; detail: string }
  | { code: "offer_expired"; detail: string }
  | { code: "price_increased"; detail: string }
  | { code: "terms_changed"; detail: string };

export interface CoverageOptions {
  /** Price increase tolerated without re-approval, in minor units. Default 0. */
  priceToleranceMinor?: number;
}

/**
 * Does this approval authorize `action` under the conditions just re-read from
 * the source? Agents call this immediately before acting.
 */
export function checkCoverage(
  a: Approval,
  action: ActionSpec,
  current: MaterialTerms,
  now: Date,
  opts: CoverageOptions = {},
): { ok: true } | { ok: false; failures: CoverageFailure[] } {
  const failures: CoverageFailure[] = [];
  if (a.status !== "approved") failures.push({ code: "not_approved", detail: `Approval is ${a.status}` });
  if (!a.actions.some((x) => x.kind === action.kind && x.itemId === action.itemId)) {
    failures.push({ code: "action_not_covered", detail: `${action.kind} on ${action.itemId} is not in this approval` });
  }
  const expiry = new Date(current.offerExpiresAt < a.terms.offerExpiresAt ? current.offerExpiresAt : a.terms.offerExpiresAt);
  if (expiry <= now) failures.push({ code: "offer_expired", detail: `Offer expired at ${expiry.toISOString()}` });
  const tolerance = opts.priceToleranceMinor ?? 0;
  if (current.price.amountMinor - a.terms.price.amountMinor > tolerance) {
    failures.push({
      code: "price_increased",
      detail: `Price rose from ${a.terms.price.amountMinor} to ${current.price.amountMinor} ${current.price.currency}`,
    });
  }
  if (termsFingerprint(current) !== a.termsFingerprint) {
    failures.push({ code: "terms_changed", detail: "Currency, cancellation policy or downstream changes differ from what was approved" });
  }
  return failures.length ? { ok: false, failures } : { ok: true };
}
