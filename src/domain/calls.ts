/**
 * Calls. Relationships decide who communicates: calls that spend relationship
 * capital go to the relationship holder; routine confirmations can be
 * automated, disclosed as automated. The expert chooses how to disclose; the
 * system decides whether consent is required.
 *
 * The jurisdiction table below is illustrative configuration, not legal
 * advice. Confirm every rule with counsel before relying on it.
 */
import type { Id } from "./common";

export type ConsentRule = "one_party" | "all_party";

/** Workspace-configurable. Unknown jurisdictions fall back to all_party. */
export type ConsentTable = Readonly<Record<string, ConsentRule>>;

export const EXAMPLE_CONSENT_TABLE: ConsentTable = {
  "US-CA": "all_party",
  "US-FL": "all_party",
  "US-WA": "all_party",
  "US-NY": "one_party",
  "US-TX": "one_party",
};

export interface CallParty {
  name: string;
  /** e.g. "US-CA", "FR". null when unknown. */
  jurisdiction: string | null;
  consentLoggedAt: string | null;
}

export type CaptureMode = "recorded" | "notes";

/**
 * Where all parties must consent, capture starts only after consent is logged.
 * When a jurisdiction is unclear, a call is transferred or someone joins, the
 * stricter rule applies. Live AI transcription counts as capture even with no
 * file saved, so notes mode processes no audio at all.
 */
export function captureDecision(
  parties: readonly CallParty[],
  table: ConsentTable,
): { rule: ConsentRule; mode: CaptureMode; missingConsent: string[]; reason: string } {
  const rules = parties.map((p) => (p.jurisdiction ? table[p.jurisdiction] : undefined) ?? "all_party");
  const unknown = parties.filter((p) => !p.jurisdiction || !table[p.jurisdiction]).map((p) => p.name);
  const rule: ConsentRule = rules.includes("all_party") ? "all_party" : "one_party";
  if (rule === "one_party") return { rule, mode: "recorded", missingConsent: [], reason: "All parties are in one-party-consent jurisdictions" };
  const missingConsent = parties.filter((p) => !p.consentLoggedAt).map((p) => p.name);
  const why = unknown.length ? `Stricter rule applied: jurisdiction unclear for ${unknown.join(", ")}` : "An all-party-consent jurisdiction is involved";
  return missingConsent.length
    ? { rule, mode: "notes", missingConsent, reason: `${why}; consent not yet logged` }
    : { rule, mode: "recorded", missingConsent, reason: `${why}; consent logged for every party` };
}

/** Someone joined or the call was transferred: re-evaluate, and never upgrade mode mid-call without consent. */
export function onPartiesChanged(current: CaptureMode, parties: readonly CallParty[], table: ConsentTable): CaptureMode {
  const next = captureDecision(parties, table).mode;
  return current === "notes" ? "notes" : next;
}

export type CallRoute = "relationship_holder" | "delegate" | "automated";

export interface CallTask {
  id: Id;
  tripId: Id | null;
  personId: Id | null;
  purpose: string;
  /** Does this ask spend relationship capital (an appeal, a favor), or is it routine? */
  spendsRelationshipCapital: boolean;
  ask: string;
  leverage: string | null;
  fallback: string | null;
  doneWhen: string;
}

/**
 * The AI never impersonates a person. Automation is only for routine
 * confirmations, always disclosed.
 */
export function routeCall(
  task: Pick<CallTask, "spendsRelationshipCapital">,
  opts: { holderId: Id; authorizedDelegateIds: readonly Id[]; automationPermitted: boolean },
): { route: CallRoute; assignee: Id | null; disclosure: string | null } {
  if (task.spendsRelationshipCapital) return { route: "relationship_holder", assignee: opts.holderId, disclosure: null };
  if (opts.automationPermitted) {
    return { route: "automated", assignee: null, disclosure: "This is an automated call from the agency's booking system." };
  }
  return { route: "delegate", assignee: opts.authorizedDelegateIds[0] ?? opts.holderId, disclosure: null };
}
