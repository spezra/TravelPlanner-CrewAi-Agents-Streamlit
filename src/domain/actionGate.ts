/**
 * Acting is a separate test from knowing. Every consequential action needs all
 * three: enough evidence to act correctly, permission from the right person,
 * and current transaction conditions that still match what was approved.
 * An agent can know exactly which hotel the client wants and still lack
 * permission to book it, or hold approval for a rate that has since expired.
 */
import { checkCoverage, type ActionSpec, type Approval, type CoverageFailure, type MaterialTerms } from "./approvals";
import { tierAtLeast, type TrustTier } from "./knowledge";

export interface GateInput {
  action: ActionSpec;
  /** Trust tier of the evidence the action relies on. */
  evidenceTier: TrustTier;
  /** Tier this action requires (booking: recommend; telling a traveler something is promised: commit). */
  requiredTier: TrustTier;
  approval: Approval | null;
  /** Conditions re-read from the source just now; null means the agent did not re-read. */
  currentTerms: MaterialTerms | null;
  now: Date;
  priceToleranceMinor?: number;
}

export type GateFailure =
  | { test: "evidence"; detail: string }
  | { test: "permission"; detail: string }
  | { test: "conditions"; detail: string; code?: CoverageFailure["code"] };

export function evaluateAction(input: GateInput): { allowed: true } | { allowed: false; failures: GateFailure[] } {
  const failures: GateFailure[] = [];
  if (!tierAtLeast(input.evidenceTier, input.requiredTier)) {
    failures.push({ test: "evidence", detail: `Evidence is '${input.evidenceTier}', action needs '${input.requiredTier}'` });
  }
  if (!input.approval) {
    failures.push({ test: "permission", detail: "No approval covers this action" });
  }
  if (!input.currentTerms) {
    failures.push({ test: "conditions", detail: "Current conditions were not re-read from the source before acting" });
  }
  if (input.approval && input.currentTerms) {
    const cov = checkCoverage(input.approval, input.action, input.currentTerms, input.now, {
      priceToleranceMinor: input.priceToleranceMinor,
    });
    if (!cov.ok) {
      for (const f of cov.failures) {
        if (f.code === "not_approved" || f.code === "action_not_covered") failures.push({ test: "permission", detail: f.detail });
        else failures.push({ test: "conditions", detail: f.detail, code: f.code });
      }
    }
  }
  return failures.length ? { allowed: false, failures } : { allowed: true };
}
