/**
 * Supplier knowledge. Knowing, permission and current terms are separate.
 * Each observation is judged on whether it is:
 *   1. safe to retain as a qualified observation
 *   2. reliable enough to use in a recommendation
 *   3. verified enough to tell a traveler as a commitment
 * Sharing is permission-first, redaction second.
 */
import { DomainError, type Id, type Scope } from "./common";

export type ObservationSource = "firsthand" | "supplier_claim" | "secondhand" | "written_confirmation";

export interface Applicability {
  /** Booking program the observation happened under, e.g. "Virtuoso". */
  program: string | null;
  roomCategory: string | null;
  season: string | null;
  /** Did a personal relationship make it happen? If so it may not transfer. */
  relationshipInvolved: boolean;
}

export interface Observation {
  id: Id;
  supplierId: Id;
  observedAt: string; // ISO date of the observation itself, not of entry
  source: ObservationSource;
  /** "not personally inspected" is an honest status, not a defect. */
  personallyInspected: boolean;
  statement: string;
  applicability: Applicability;
  /** For request/outcome records such as upgrade asks. */
  request: string | null;
  outcome: "granted" | "denied" | "partial" | null;
  /** For written confirmations: the booking they apply to. */
  bookingRef: string | null;
}

export type TrustTier = "retain" | "recommend" | "commit";

export interface TrustPolicy {
  /** Observations older than this can't back a recommendation. */
  maxAgeDaysForRecommendation: number;
}

export const DEFAULT_TRUST_POLICY: TrustPolicy = { maxAgeDaysForRecommendation: 540 };

const DAY_MS = 86_400_000;

/**
 * The highest tier an observation supports for a given use. Only a written
 * confirmation tied to this booking can become a traveler-facing commitment;
 * an uncertain note about late checkout stays a supplier claim.
 */
export function trustTier(
  obs: Observation,
  now: Date,
  forBookingRef: string | null = null,
  policy: TrustPolicy = DEFAULT_TRUST_POLICY,
): TrustTier {
  if (obs.source === "written_confirmation" && obs.bookingRef !== null && obs.bookingRef === forBookingRef) return "commit";
  const ageDays = (now.getTime() - new Date(obs.observedAt).getTime()) / DAY_MS;
  const fresh = ageDays <= policy.maxAgeDaysForRecommendation;
  const reliableSource = obs.source === "firsthand" || obs.source === "written_confirmation";
  return fresh && reliableSource ? "recommend" : "retain";
}

const TIER_RANK: Record<TrustTier, number> = { retain: 0, recommend: 1, commit: 2 };
export const tierAtLeast = (have: TrustTier, need: TrustTier) => TIER_RANK[have] >= TIER_RANK[need];

/** Provenance line shown with every recommendation. */
export function provenance(obs: Observation): string {
  const who =
    obs.source === "firsthand" ? "Firsthand" : obs.source === "supplier_claim" ? "Supplier claim" : obs.source === "secondhand" ? "Secondhand" : "Written confirmation";
  const inspected = obs.personallyInspected ? "personally inspected" : "not personally inspected";
  return `${who}, ${obs.observedAt.slice(0, 10)}, ${inspected}`;
}

/**
 * "This hotel delivers upgrades" may reflect one advisor, one season, one rate
 * and one accommodating manager. Summaries count failures alongside successes
 * and only pool observations whose applicability matches.
 */
export function requestTrackRecord(
  observations: readonly Observation[],
  request: string,
  match: Partial<Applicability> = {},
): { granted: number; denied: number; partial: number; relationshipDependent: number; total: number } {
  const relevant = observations.filter(
    (o) =>
      o.request === request &&
      o.outcome !== null &&
      (Object.keys(match) as (keyof Applicability)[]).every((k) => o.applicability[k] === match[k]),
  );
  return {
    granted: relevant.filter((o) => o.outcome === "granted").length,
    denied: relevant.filter((o) => o.outcome === "denied").length,
    partial: relevant.filter((o) => o.outcome === "partial").length,
    relationshipDependent: relevant.filter((o) => o.applicability.relationshipInvolved).length,
    total: relevant.length,
  };
}

// ---------------------------------------------------------------------------
// Sharing

/** Three separate fields per item. High confidence never implies permission. */
export type Confidentiality = "shareable" | "confidential" | "restricted";
export type FactualConfidence = "low" | "medium" | "high";

export type KnowledgeCategory =
  | "property_guidance" // room-level notes, atmosphere, who it suits
  | "dining"
  | "logistics"
  | "commercial_terms" // always restricted
  | "unpublished_availability" // always restricted
  | "relationship_concession" // always restricted
  | "contact_details";

/** Categories that stay restricted even with every identifier removed. */
export const ALWAYS_RESTRICTED: ReadonlySet<KnowledgeCategory> = new Set([
  "commercial_terms",
  "unpublished_availability",
  "relationship_concession",
]);

export interface KnowledgeItem {
  id: Id;
  ownerId: Id;
  category: KnowledgeCategory;
  body: string;
  /** Highest scope the owner has permitted. */
  sharingPermission: Scope;
  confidentiality: Confidentiality;
  confidence: FactualConfidence;
  /** Current published scope; starts private. */
  publishedScope: Scope;
  sourceObservationIds: Id[];
}

export interface StandingRule {
  ownerId: Id;
  category: KnowledgeCategory;
  scope: Exclude<Scope, "private">;
}

export type PublicationStep = "permission" | "extract" | "redact" | "source_check" | "publish";

export interface PublicationContext {
  targetScope: Exclude<Scope, "private">;
  /** Owner approved this specific item for this scope. */
  ownerApproved: boolean;
  standingRules: readonly StandingRule[];
  /** Redactor output: text with identifying/restricted info removed, plus what it found. */
  redact: (text: string) => { text: string; findings: string[] };
  /** Checks the redacted item still says what the source says. */
  sourceCheck: (redacted: string, item: KnowledgeItem) => boolean;
}

export type PublicationResult =
  | { ok: true; item: KnowledgeItem; redactedBody: string; findings: string[] }
  | { ok: false; failedAt: PublicationStep; reason: string };

const SCOPE_RANK: Record<Scope, number> = { private: 0, workspace: 1, network: 2 };

/**
 * The publication pipeline: check permission, extract, redact, check against
 * source, publish only to an authorized scope. Detectors plus an LLM pass help
 * redaction but neither guarantees completeness, so owner approval (or a
 * standing rule the owner set) is required regardless of redaction output.
 */
export function publish(item: KnowledgeItem, ctx: PublicationContext): PublicationResult {
  if (ALWAYS_RESTRICTED.has(item.category) || item.confidentiality === "restricted") {
    return { ok: false, failedAt: "permission", reason: `${item.category} stays restricted even when redacted` };
  }
  if (SCOPE_RANK[item.sharingPermission] < SCOPE_RANK[ctx.targetScope]) {
    return { ok: false, failedAt: "permission", reason: `Owner permits sharing up to ${item.sharingPermission} only` };
  }
  if (item.confidentiality === "confidential" && ctx.targetScope === "network") {
    return { ok: false, failedAt: "permission", reason: "Confidential items do not leave the workspace" };
  }
  const coveredByRule = ctx.standingRules.some(
    (r) => r.ownerId === item.ownerId && r.category === item.category && SCOPE_RANK[r.scope] >= SCOPE_RANK[ctx.targetScope],
  );
  if (!ctx.ownerApproved && !coveredByRule) {
    return { ok: false, failedAt: "permission", reason: "Needs owner approval or a standing rule for this category" };
  }
  const extracted = item.body.trim();
  if (!extracted) return { ok: false, failedAt: "extract", reason: "Nothing to publish" };
  const { text, findings } = ctx.redact(extracted);
  if (!text.trim()) return { ok: false, failedAt: "redact", reason: "Nothing left after redaction" };
  if (!ctx.sourceCheck(text, item)) return { ok: false, failedAt: "source_check", reason: "Redacted item no longer matches its source" };
  return { ok: true, item: { ...item, publishedScope: ctx.targetScope, body: text }, redactedBody: text, findings };
}

/**
 * Levels of what flows across the network. Discoverability is automatic within
 * the expert's settings; relationship activation is decided by the holder
 * every time.
 */
export type NetworkLevel = "discoverability" | "reusable_knowledge" | "relationship_activation" | "execution";

export function whoDecides(level: NetworkLevel): "automatic" | "owner_or_standing_rule" | "relationship_holder_each_time" | "expert_accepts" {
  switch (level) {
    case "discoverability":
      return "automatic";
    case "reusable_knowledge":
      return "owner_or_standing_rule";
    case "relationship_activation":
      return "relationship_holder_each_time";
    case "execution":
      return "expert_accepts";
  }
}

export function assertScope(s: string): Scope {
  if (s === "private" || s === "workspace" || s === "network") return s;
  throw new DomainError("bad_scope", `Unknown scope ${s}`);
}
