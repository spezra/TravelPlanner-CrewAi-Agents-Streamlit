/**
 * Knowledge items and the publication pipeline, with persistence.
 *
 *   submit   permission first (restricted never, confidential stays in the
 *            workspace, items needing review are held) -> deterministic
 *            redaction -> either the review job (agents on) or the owner
 *   review   LLM redaction review + source check (job) -> a standing rule may
 *            publish if every check is clean; otherwise the owner's queue
 *   approve  the owner confirms (optionally editing the redacted text); the
 *            domain `publish` runs again on exactly what gets published
 *
 * The source body never leaves knowledge_items (owner-only); colleagues and
 * the network read the redacted copy in published_knowledge.
 */
import { randomUUID } from "node:crypto";
import { checkAgainstSource, reviewRedaction } from "@/agents/redactionReviewer";
import type { StructuredLLM } from "@/agents/llm";
import type { Db, Queryable } from "@/db/client";
import { audit } from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { DomainError, fingerprint, type Scope } from "@/domain/common";
import {
  ALWAYS_RESTRICTED,
  publish,
  type Confidentiality,
  type FactualConfidence,
  type KnowledgeCategory,
  type KnowledgeItem,
  type StandingRule,
} from "@/domain/knowledge";
import { checkPublicationPermission, coveredByStandingRule, requestableScopes, routeAfterReview, type ReviewSignals, type TargetScope } from "@/domain/publication";
import { enqueueAsTenant } from "@/server/jobs/queue";
import { createRedactor, deterministicSourceCheck, loadWorkspaceNames, type RedactionFinding } from "./redact";
import { arr, iso, likePattern, str } from "./util";

export const CATEGORIES: readonly KnowledgeCategory[] = [
  "property_guidance",
  "dining",
  "logistics",
  "contact_details",
  "commercial_terms",
  "unpublished_availability",
  "relationship_concession",
];

export const CATEGORY_LABEL: Record<KnowledgeCategory, string> = {
  property_guidance: "Property guidance",
  dining: "Dining",
  logistics: "Logistics",
  contact_details: "Contact details",
  commercial_terms: "Commercial terms (restricted)",
  unpublished_availability: "Unpublished availability (restricted)",
  relationship_concession: "Relationship concession (restricted)",
};

export const REVIEW_JOB = "network.review_publication";

export type PublicationStatus = "draft" | "processing" | "awaiting_owner" | "published" | "declined";

export interface ReviewFlag {
  span: string;
  kind: string;
  reason: string;
}

export interface KnowledgeRow extends KnowledgeItem {
  destination: string | null;
  needsReview: boolean;
  dependsOnPersonId: string | null;
  publicationStatus: PublicationStatus;
  targetScope: TargetScope | null;
  candidateBody: string | null;
  redactionFindings: RedactionFinding[];
  reviewFlags: ReviewFlag[];
  sourceCheck: { deterministic?: { ok: boolean; issues: string[] }; llm?: { consistent: boolean; issues: string[] } | null } | null;
  holdReasons: string[];
  submissionKey: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  updatedAt: string | null;
  published: { scope: TargetScope; held: boolean; withdrawnAt: string | null; publishedAt: string } | null;
}

const ITEM_SELECT = `select ki.*, pk.scope as pk_scope, pk.held as pk_held, pk.withdrawn_at as pk_withdrawn_at, pk.published_at as pk_published_at
  from knowledge_items ki left join published_knowledge pk on pk.item_id = ki.id`;

function mapItem(r: Record<string, unknown>): KnowledgeRow {
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    category: r.category as KnowledgeCategory,
    body: String(r.body),
    sharingPermission: r.sharing_permission as Scope,
    confidentiality: r.confidentiality as Confidentiality,
    confidence: r.confidence as FactualConfidence,
    publishedScope: r.published_scope as Scope,
    sourceObservationIds: arr(r.source_observation_ids),
    destination: str(r.destination),
    needsReview: Boolean(r.needs_review),
    dependsOnPersonId: str(r.depends_on_person_id),
    publicationStatus: r.publication_status as PublicationStatus,
    targetScope: (r.target_scope as TargetScope | null) ?? null,
    candidateBody: str(r.candidate_body),
    redactionFindings: arr<RedactionFinding>(r.redaction_findings),
    reviewFlags: arr<ReviewFlag>(r.review_flags),
    sourceCheck: (r.source_check as KnowledgeRow["sourceCheck"]) ?? null,
    holdReasons: arr(r.hold_reasons),
    submissionKey: str(r.submission_key),
    submittedAt: iso(r.submitted_at),
    decidedAt: iso(r.decided_at),
    declineReason: str(r.decline_reason),
    updatedAt: iso(r.updated_at),
    published: r.pk_scope
      ? { scope: r.pk_scope as TargetScope, held: Boolean(r.pk_held), withdrawnAt: iso(r.pk_withdrawn_at), publishedAt: iso(r.pk_published_at)! }
      : null,
  };
}

/** Items are the owner's alone (RLS); these read only the caller's own. */
export async function listMyItems(q: Queryable): Promise<KnowledgeRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(`${ITEM_SELECT} where ki.owner_id = app_member() order by ki.updated_at desc, ki.id`);
  return rows.map(mapItem);
}

export async function getItem(q: Queryable, id: string): Promise<KnowledgeRow | null> {
  const { rows } = await q.query<Record<string, unknown>>(`${ITEM_SELECT} where ki.id = $1 and ki.owner_id = app_member()`, [id]);
  if (!rows[0]) return null;
  const item = mapItem(rows[0]);
  return item.publicationStatus === "awaiting_owner" && (item.candidateBody === null || item.targetScope === null)
    ? withPendingDefaults(item, createRedactor(await loadWorkspaceNames(q)))
    : item;
}

export async function listAwaitingOwner(q: Queryable): Promise<KnowledgeRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `${ITEM_SELECT} where ki.owner_id = app_member() and ki.publication_status = 'awaiting_owner' order by ki.submitted_at nulls last`,
  );
  const items = rows.map(mapItem);
  if (!items.some((i) => i.candidateBody === null || i.targetScope === null)) return items;
  const redactor = createRedactor(await loadWorkspaceNames(q));
  return items.map((i) => withPendingDefaults(i, redactor));
}

/**
 * Items queued before the pipeline recorded a candidate (imports, older data):
 * show what approval would publish, to the widest scope the owner permits.
 */
function withPendingDefaults(item: KnowledgeRow, redactor: ReturnType<typeof createRedactor>): KnowledgeRow {
  if (item.publicationStatus !== "awaiting_owner") return item;
  const targetScope = item.targetScope ?? requestableScopes(item).at(-1) ?? null;
  if (item.candidateBody !== null) return { ...item, targetScope };
  const r = redactor.redact(item.body);
  return {
    ...item,
    targetScope,
    candidateBody: r.text,
    redactionFindings: r.findings,
    sourceCheck: { deterministic: deterministicSourceCheck(item.body, r.text) },
    holdReasons: item.holdReasons.length ? item.holdReasons : ["Confirm the redacted text still says what your source says"],
  };
}

async function requireItem(q: Queryable, id: string): Promise<KnowledgeRow> {
  const row = await getItem(q, id);
  if (!row) throw new DomainError("not_found", "Knowledge item not found");
  return row;
}

// ---------------------------------------------------------------------------
// Authoring

export interface ItemInput {
  category: KnowledgeCategory;
  destination: string | null;
  body: string;
  sharingPermission: Scope;
  confidentiality: Confidentiality;
  confidence: FactualConfidence;
  sourceObservationIds: string[];
  dependsOnPersonId: string | null;
}

function checkInput(input: ItemInput): void {
  if (!input.body.trim()) throw new DomainError("empty", "Write the knowledge item first");
  if (input.body.length > 8000) throw new DomainError("too_long", "Keep items short: under 8,000 characters");
  // A restricted category is restricted, whatever the form says.
  if (ALWAYS_RESTRICTED.has(input.category) && (input.confidentiality !== "restricted" || input.sharingPermission !== "private")) {
    throw new DomainError("restricted_category", "Commercial terms, unpublished availability and relationship concessions stay private and restricted");
  }
}

export async function createItem(db: Db, tenant: Tenant, input: ItemInput, now: Date): Promise<string> {
  checkInput(input);
  const id = randomUUID();
  await withTenant(db, tenant, async (q) => {
    await q.query(
      `insert into knowledge_items (id, workspace_id, owner_id, category, body, sharing_permission, confidentiality, confidence, destination,
         source_observation_ids, depends_on_person_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [
        id, tenant.workspaceId, tenant.memberId, input.category, input.body.trim(), input.sharingPermission, input.confidentiality, input.confidence,
        input.destination, JSON.stringify(input.sourceObservationIds), input.dependsOnPersonId, now.toISOString(),
      ],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.created", id, { category: input.category });
  });
  return id;
}

/**
 * Editing the source voids any submission in flight and withdraws a published
 * copy: what was approved is no longer what the source says.
 */
export async function updateItem(db: Db, tenant: Tenant, id: string, input: ItemInput, now: Date): Promise<void> {
  checkInput(input);
  await withTenant(db, tenant, async (q) => {
    const row = await requireItem(q, id);
    const withdrew = await withdrawPublished(q, id, now);
    await q.query(
      `update knowledge_items set category = $2, body = $3, sharing_permission = $4, confidentiality = $5, confidence = $6, destination = $7,
         source_observation_ids = $8, depends_on_person_id = $9, updated_at = $10,
         publication_status = 'draft', published_scope = 'private', target_scope = null, candidate_body = null, redaction_findings = '[]',
         review_flags = '[]', source_check = null, hold_reasons = '[]', submission_key = null
       where id = $1`,
      [id, input.category, input.body.trim(), input.sharingPermission, input.confidentiality, input.confidence, input.destination,
        JSON.stringify(input.sourceObservationIds), input.dependsOnPersonId, now.toISOString()],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.updated", id, { previousStatus: row.publicationStatus, withdrewPublished: withdrew });
  });
}

export async function deleteItem(db: Db, tenant: Tenant, id: string): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    await requireItem(q, id);
    await q.query("delete from knowledge_items where id = $1", [id]);
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.deleted", id);
  });
}

/** The owner confirms the item still holds after whatever it depended on changed. */
export async function markReviewed(db: Db, tenant: Tenant, id: string, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    await requireItem(q, id);
    await q.query("update knowledge_items set needs_review = false, updated_at = $2 where id = $1", [id, now.toISOString()]);
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.reviewed", id);
  });
}

// ---------------------------------------------------------------------------
// Standing rules

export async function listStandingRules(q: Queryable): Promise<(StandingRule & { id: string; createdAt: string })[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from knowledge_standing_rules where owner_id = app_member() order by category");
  return rows.map((r) => ({ id: String(r.id), ownerId: String(r.owner_id), category: r.category as KnowledgeCategory, scope: r.scope as TargetScope, createdAt: iso(r.created_at)! }));
}

/** `scope: null` removes the rule. Restricted categories can never have one. */
export async function setStandingRule(db: Db, tenant: Tenant, category: KnowledgeCategory, scope: TargetScope | null, now: Date): Promise<void> {
  if (ALWAYS_RESTRICTED.has(category)) throw new DomainError("restricted_category", "Restricted categories never publish, so they can't have a standing rule");
  if (category === "contact_details" && scope === "network") throw new DomainError("no_contact_on_network", "Contact details never go to the network");
  await withTenant(db, tenant, async (q) => {
    if (scope === null) {
      await q.query("delete from knowledge_standing_rules where owner_id = app_member() and category = $1", [category]);
    } else {
      await q.query(
        `insert into knowledge_standing_rules (id, workspace_id, owner_id, category, scope, created_at) values ($1,$2,$3,$4,$5,$6)
         on conflict (owner_id, category) do update set scope = excluded.scope, created_at = excluded.created_at`,
        [randomUUID(), tenant.workspaceId, tenant.memberId, category, scope, now.toISOString()],
      );
    }
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.standing_rule", category, { scope });
  });
}

// ---------------------------------------------------------------------------
// Pipeline

export type SubmitResult =
  | { status: "blocked"; reason: string }
  | { status: "processing" }
  | { status: "awaiting_owner"; reasons: string[] }
  | { status: "published" };

async function blocked(q: Queryable, tenant: Tenant, id: string, target: TargetScope, reason: string): Promise<SubmitResult> {
  await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.publication_blocked", id, { target, reason });
  return { status: "blocked", reason };
}

/**
 * Submits an item for publication to `target`. With agents available the
 * review runs as a job (REVIEW_JOB); without them the owner confirms the
 * source check, so the item goes straight to their queue.
 */
export async function submitForPublication(db: Db, tenant: Tenant, id: string, target: TargetScope, opts: { agents: boolean; now: Date }): Promise<SubmitResult> {
  return withTenant(db, tenant, async (q) => {
    const row = await requireItem(q, id);
    if (row.publicationStatus === "processing") throw new DomainError("in_review", "This item is already being reviewed");
    const perm = checkPublicationPermission(row, target, { needsReview: row.needsReview });
    if (!perm.ok) return blocked(q, tenant, id, target, perm.reason);

    const redacted = createRedactor(await loadWorkspaceNames(q)).redact(row.body);
    const det = deterministicSourceCheck(row.body, redacted.text);
    const key = fingerprint({ id, body: row.body, target, at: opts.now.toISOString() });
    const common = [id, target, redacted.text, JSON.stringify(redacted.findings), JSON.stringify({ deterministic: det }), key, opts.now.toISOString()];
    const setCommon = `target_scope = $2, candidate_body = $3, redaction_findings = $4, review_flags = '[]', source_check = $5, submission_key = $6,
      submitted_at = $7, decided_at = null, decline_reason = null`;

    if (opts.agents) {
      await q.query(`update knowledge_items set publication_status = 'processing', hold_reasons = '[]', ${setCommon} where id = $1`, common);
      await enqueueAsTenant(q, { kind: REVIEW_JOB, payload: { itemId: id, submissionKey: key }, dedupeKey: `${REVIEW_JOB}:${key}` });
      await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.submitted", id, { target, findings: redacted.findings.length, review: "agents" });
      return { status: "processing" };
    }
    const route = routeAfterReview(coveredByStandingRule(row, target, await listStandingRules(q)), {
      agentsAvailable: false,
      llmReview: null,
      deterministicSource: det,
      llmSource: null,
    });
    const reasons = route.route === "owner_review" ? route.reasons : [];
    await q.query(`update knowledge_items set publication_status = 'awaiting_owner', hold_reasons = $8, ${setCommon} where id = $1`, [...common, JSON.stringify(reasons)]);
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.submitted", id, { target, findings: redacted.findings.length, review: "owner" });
    return { status: "awaiting_owner", reasons };
  });
}

/**
 * The review job. Idempotent: it acts only while the item is still
 * 'processing' under the same submission key, so a retry or a resubmission
 * in between can't publish something stale. Model calls run outside any
 * transaction.
 */
export async function completePublicationReview(
  db: Db,
  tenant: Tenant,
  id: string,
  submissionKey: string,
  llm: StructuredLLM | null,
  now: Date,
): Promise<"stale" | SubmitResult> {
  const current = (q: Queryable) =>
    getItem(q, id).then((r) => (r && r.publicationStatus === "processing" && r.submissionKey === submissionKey && r.candidateBody && r.targetScope ? r : null));
  const pre = await withTenant(db, tenant, current);
  if (!pre) return "stale";

  let llmReview: ReviewSignals["llmReview"] = null;
  let llmSource: ReviewSignals["llmSource"] = null;
  let flags: ReviewFlag[] = [];
  let spans: string[] = [];
  const unavailable: string[] = [];
  if (llm) {
    const review = await reviewRedaction(llm, { text: pre.candidateBody!, category: pre.category });
    if ("error" in review) unavailable.push(`Redaction review failed (${review.error})`);
    else {
      llmReview = { findings: review.findings.length, restricted: review.restricted };
      flags = review.findings;
      spans = review.spans;
    }
  }
  const final = createRedactor().redact(pre.candidateBody!, spans);
  if (llm) {
    const check = await checkAgainstSource(llm, { source: pre.body, redacted: final.text });
    if ("error" in check) unavailable.push(`Source check failed (${check.error})`);
    else llmSource = check;
  }
  const det = deterministicSourceCheck(pre.body, final.text);

  return withTenant(db, tenant, async (q) => {
    const row = await current(q);
    if (!row) return "stale" as const;
    const target = row.targetScope!;
    const perm = checkPublicationPermission(row, target, { needsReview: row.needsReview });
    if (!perm.ok) {
      await q.query("update knowledge_items set publication_status = 'draft', hold_reasons = $2 where id = $1", [id, JSON.stringify([perm.reason])]);
      return blocked(q, tenant, id, target, perm.reason);
    }
    const rules = await listStandingRules(q);
    const signals: ReviewSignals = { agentsAvailable: llm !== null && unavailable.length === 0, llmReview, deterministicSource: det, llmSource };
    const route = routeAfterReview(coveredByStandingRule(row, target, rules), signals);
    const findings = [...row.redactionFindings, ...final.findings];
    await q.query(
      `update knowledge_items set candidate_body = $2, redaction_findings = $3, review_flags = $4, source_check = $5 where id = $1`,
      [id, final.text, JSON.stringify(findings), JSON.stringify(flags), JSON.stringify({ deterministic: det, llm: llmSource })],
    );
    if (route.route === "auto_publish") {
      const r = await publishItem(q, tenant, { ...row, candidateBody: final.text }, final.text, { ownerApproved: false, rules, via: "standing_rule" }, now);
      if (r.ok) return { status: "published" as const };
      const reasons = [r.reason];
      await q.query("update knowledge_items set publication_status = 'awaiting_owner', hold_reasons = $2 where id = $1", [id, JSON.stringify(reasons)]);
      return { status: "awaiting_owner" as const, reasons };
    }
    const reasons = [...unavailable, ...route.reasons];
    await q.query("update knowledge_items set publication_status = 'awaiting_owner', hold_reasons = $2 where id = $1", [id, JSON.stringify(reasons)]);
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.awaiting_owner", id, { target, reasons: reasons.length });
    return { status: "awaiting_owner" as const, reasons };
  });
}

/**
 * Runs the domain pipeline on exactly the text that will be published and
 * writes the published copy. The redactor runs again (it is idempotent on
 * its own output) so an owner's edit can't reintroduce a detectable
 * identifier, and the deterministic source check holds edits to the source.
 */
async function publishItem(
  q: Queryable,
  tenant: Tenant,
  row: KnowledgeRow,
  text: string,
  opts: { ownerApproved: boolean; rules: readonly StandingRule[]; via: "owner" | "standing_rule" },
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const target = row.targetScope!;
  const redactor = createRedactor(await loadWorkspaceNames(q));
  const result = publish(
    { ...row, body: text },
    {
      targetScope: target,
      ownerApproved: opts.ownerApproved,
      standingRules: opts.rules,
      redact: (t) => {
        const r = redactor.redact(t);
        return { text: r.text, findings: r.findings.map((f) => f.kind) };
      },
      sourceCheck: (redacted) => deterministicSourceCheck(row.body, redacted).ok,
    },
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  await q.query(
    `insert into published_knowledge (id, workspace_id, item_id, owner_id, category, destination, scope, body, confidence, source_fingerprint, held, published_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11)
     on conflict (item_id) do update set category = excluded.category, destination = excluded.destination, scope = excluded.scope, body = excluded.body,
       confidence = excluded.confidence, source_fingerprint = excluded.source_fingerprint, held = false, published_at = excluded.published_at, withdrawn_at = null`,
    [randomUUID(), tenant.workspaceId, row.id, row.ownerId, row.category, row.destination, target, result.redactedBody, row.confidence, fingerprint(row.body), now.toISOString()],
  );
  await q.query(
    `update knowledge_items set publication_status = 'published', published_scope = $2, target_scope = $2, candidate_body = $3, decided_at = $4, hold_reasons = '[]'
      where id = $1`,
    [row.id, target, result.redactedBody, now.toISOString()],
  );
  await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.published", row.id, { scope: target, via: opts.via, findings: result.findings.length });
  return { ok: true };
}

/** The owner approves an item in their queue, optionally editing the redacted text first. */
export async function approvePublication(db: Db, tenant: Tenant, id: string, editedText: string | null, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const row = await requireItem(q, id);
    if (row.publicationStatus !== "awaiting_owner" || !row.targetScope) throw new DomainError("not_awaiting", "This item isn't waiting for your approval");
    const perm = checkPublicationPermission(row, row.targetScope, { needsReview: row.needsReview });
    if (!perm.ok) throw new DomainError("publication_blocked", perm.reason);
    const text = editedText?.trim() || row.candidateBody || "";
    const r = await publishItem(q, tenant, row, text, { ownerApproved: true, rules: [], via: "owner" }, now);
    if (!r.ok) {
      const detail = deterministicSourceCheck(row.body, createRedactor(await loadWorkspaceNames(q)).redact(text).text);
      throw new DomainError("publication_failed", detail.ok ? r.reason : `${r.reason}: ${detail.issues.join("; ")}`);
    }
  });
}

export async function declinePublication(db: Db, tenant: Tenant, id: string, reason: string | null, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const row = await requireItem(q, id);
    if (row.publicationStatus !== "awaiting_owner" && row.publicationStatus !== "processing") {
      throw new DomainError("not_awaiting", "This item isn't waiting for a decision");
    }
    await q.query(
      `update knowledge_items set publication_status = 'declined', decline_reason = $2, decided_at = $3, candidate_body = null, submission_key = null where id = $1`,
      [id, reason, now.toISOString()],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.declined", id, {});
  });
}

async function withdrawPublished(q: Queryable, id: string, now: Date): Promise<boolean> {
  const { rows } = await q.query("update published_knowledge set withdrawn_at = $2 where item_id = $1 and withdrawn_at is null returning id", [id, now.toISOString()]);
  return rows.length > 0;
}

export async function withdrawPublication(db: Db, tenant: Tenant, id: string, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    await requireItem(q, id);
    const withdrew = await withdrawPublished(q, id, now);
    if (!withdrew) throw new DomainError("not_published", "This item isn't published");
    await q.query("update knowledge_items set publication_status = 'draft', published_scope = 'private', updated_at = $2 where id = $1", [id, now.toISOString()]);
    await audit(q, tenant.workspaceId, tenant.memberId, "knowledge.withdrawn", id);
  });
}

// ---------------------------------------------------------------------------
// Reading published knowledge

export interface PublishedKnowledge {
  id: string;
  workspaceId: string;
  itemId: string;
  category: KnowledgeCategory;
  destination: string | null;
  scope: TargetScope;
  body: string;
  confidence: FactualConfidence;
  publishedAt: string;
  author: string | null;
}

function mapPublished(r: Record<string, unknown>): PublishedKnowledge {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    itemId: String(r.item_id),
    category: r.category as KnowledgeCategory,
    destination: str(r.destination),
    scope: r.scope as TargetScope,
    body: String(r.body),
    confidence: r.confidence as FactualConfidence,
    publishedAt: iso(r.published_at)!,
    author: str(r.author),
  };
}

/** Knowledge colleagues published inside this workspace (any scope). */
export async function listWorkspaceKnowledge(q: Queryable): Promise<PublishedKnowledge[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select pk.*, m.name as author from published_knowledge pk join members m on m.id = pk.owner_id
      where pk.workspace_id = app_workspace() and pk.withdrawn_at is null and not pk.held order by pk.published_at desc limit 200`,
  );
  return rows.map(mapPublished);
}

/**
 * Knowledge other network members deliberately published. RLS returns rows
 * only when both workspaces are admitted; authors appear by their
 * discoverability display name, if they have one.
 */
export async function listNetworkKnowledge(q: Queryable, filter: { destination?: string | null; text?: string | null } = {}): Promise<PublishedKnowledge[]> {
  const params: unknown[] = [];
  const where = ["pk.workspace_id <> app_workspace()", "pk.scope = 'network'", "pk.withdrawn_at is null", "not pk.held"];
  if (filter.destination?.trim()) where.push(`pk.destination ilike $${params.push(likePattern(filter.destination))}`);
  if (filter.text?.trim()) where.push(`pk.body ilike $${params.push(likePattern(filter.text))}`);
  const { rows } = await q.query<Record<string, unknown>>(
    `select pk.*, np.display_name as author from published_knowledge pk left join network_profiles np on np.member_id = pk.owner_id
      where ${where.join(" and ")} order by pk.published_at desc limit 100`,
    params,
  );
  return rows.map(mapPublished);
}
