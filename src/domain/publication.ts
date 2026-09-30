/**
 * Routing around the publication pipeline in ./knowledge.ts. `publish` decides
 * whether one item may go to one scope; these rules decide what happens before
 * and after it: what holds an item back, when a standing rule may publish
 * without the owner looking, and when the owner has to confirm.
 *
 * Detectors plus an LLM pass help redaction, but neither guarantees
 * completeness, so automation only ever narrows what reaches the owner; it
 * never widens what may be published.
 */
import { publish, type KnowledgeItem, type StandingRule } from "./knowledge";
import type { Scope } from "./common";

export type TargetScope = Exclude<Scope, "private">;

const SCOPE_RANK: Record<Scope, number> = { private: 0, workspace: 1, network: 2 };

export interface HoldState {
  /** Set when something the item depended on changed (e.g. the person moved properties). */
  needsReview: boolean;
}

/**
 * Permission comes first. Restricted categories and confidential items are
 * refused here, before anything is redacted; an item that needs review is
 * held back until its owner has looked at it again.
 */
export function checkPublicationPermission(item: KnowledgeItem, target: TargetScope, hold: HoldState): { ok: true } | { ok: false; reason: string } {
  if (hold.needsReview) {
    return { ok: false, reason: "Held back: something this item depends on changed. Review it before it is shared." };
  }
  if (target === "network" && item.category === "contact_details") {
    return { ok: false, reason: "The network carries discoverability and guidance, never contact details" };
  }
  // Ask the pipeline itself with approval assumed, so the permission rules live in one place.
  const r = publish(item, {
    targetScope: target,
    ownerApproved: true,
    standingRules: [],
    redact: (text) => ({ text, findings: [] }),
    sourceCheck: () => true,
  });
  if (!r.ok && r.failedAt === "permission") return { ok: false, reason: r.reason };
  return { ok: true };
}

export function coveredByStandingRule(item: KnowledgeItem, target: TargetScope, rules: readonly StandingRule[]): boolean {
  return rules.some((r) => r.ownerId === item.ownerId && r.category === item.category && SCOPE_RANK[r.scope] >= SCOPE_RANK[target]);
}

/** Which scopes an owner may request for an item, given its sharing permission. */
export function requestableScopes(item: Pick<KnowledgeItem, "sharingPermission" | "confidentiality" | "category">): TargetScope[] {
  const out: TargetScope[] = [];
  if (SCOPE_RANK[item.sharingPermission] >= 1) out.push("workspace");
  if (SCOPE_RANK[item.sharingPermission] >= 2 && item.confidentiality === "shareable" && item.category !== "contact_details") out.push("network");
  return out;
}

export interface ReviewSignals {
  /** Were the review agents available for this submission? */
  agentsAvailable: boolean;
  /** LLM redaction review: remaining identifying content it found, and whether any of it is restricted. Null if not run. */
  llmReview: { findings: number; restricted: boolean } | null;
  /** Deterministic source check: the redacted item adds nothing and drops no qualifier. */
  deterministicSource: { ok: boolean; issues: string[] };
  /** LLM source check: the redacted item neither contradicts nor overstates its source. Null if not run. */
  llmSource: { consistent: boolean; issues: string[] } | null;
}

export type ReviewRoute = { route: "auto_publish" } | { route: "owner_review"; reasons: string[] };

/**
 * After redaction and the source check: a standing rule publishes without
 * per-item approval only when every automated check ran and came back clean.
 * Anything else, including agents being off, goes to the owner, who confirms
 * the source check themselves.
 */
export function routeAfterReview(coveredByRule: boolean, s: ReviewSignals): ReviewRoute {
  const reasons: string[] = [];
  if (!coveredByRule) reasons.push("No standing rule covers this category and scope: needs your approval");
  if (!s.deterministicSource.ok) reasons.push(...s.deterministicSource.issues.map((i) => `Source check: ${i}`));
  if (!s.agentsAvailable || s.llmReview === null || s.llmSource === null) {
    reasons.push("Automated review unavailable: confirm the redacted text still says what your source says");
  } else {
    if (s.llmReview.restricted) reasons.push("Review found content that may be restricted (commercial terms, unpublished availability or a concession)");
    if (s.llmReview.findings > 0) reasons.push(`Review found ${s.llmReview.findings} more identifying detail(s); they were removed, please check`);
    if (!s.llmSource.consistent) reasons.push(...(s.llmSource.issues.length ? s.llmSource.issues : ["Redacted text may not match the source"]).map((i) => `Source check: ${i}`));
  }
  return reasons.length === 0 ? { route: "auto_publish" } : { route: "owner_review", reasons };
}
