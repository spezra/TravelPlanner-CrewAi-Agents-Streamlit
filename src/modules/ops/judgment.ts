/**
 * Judgment capture. The expert selects, rejects or edits a trip item or a
 * proposal option; the reason, when it is known, is routed to the record it
 * belongs in: the expert's taste model, the client brief, the dated supplier
 * record, or this trip only. When the reason is only in the conversation, an
 * agent classifies it as a job; when it is nowhere, the expert is asked one
 * short question, and only when the answer would materially improve future work.
 */
import { randomUUID } from "node:crypto";
import { classifyDecision } from "@/agents/reasonClassifier";
import type { Db, Queryable } from "@/db/client";
import { withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import { endorsementRate, routeDecision, shouldAskWhy, type CapturedReason, type Decision, type DecisionKind, type LearningTarget, type LearningUpdate, type ReasonCategory } from "@/domain/judgment";
import { decryptFor, encryptFor } from "@/server/crypto";
import { enqueueAsTenant, PermanentJobError } from "@/server/jobs/queue";
import { insertBriefStatement } from "./clients";
import { actor, audit, day, encCtx, iso, str, type OpsDeps } from "./common";

export const CLASSIFY_KIND = "ops.classify_decision";

export const REASON_LABEL: Record<ReasonCategory, string> = {
  expert_taste: "My taste: the place itself",
  client_preference: "Wrong (or right) for this client",
  supplier_condition: "A current condition at the supplier",
  trip_constraint: "Just this trip's constraints",
};

export const TARGET_LABEL: Record<LearningTarget, string> = {
  taste_model: "your taste model",
  client_brief: "the client brief",
  supplier_record: "the supplier record",
  trip: "this trip only",
};

export type DecisionStatus = "recorded" | "classifying" | "awaiting_answer" | "learned" | "unexplained" | "failed";

export interface DecisionInput {
  tripId: string;
  itemId: string | null;
  /** A proposal option, referenced by the proposals feature's id. */
  optionRef: string | null;
  subject: string | null;
  supplierName: string | null;
  kind: DecisionKind;
  before: string | null;
  after: string | null;
  /** The expert's own reason, when they give it with the decision. */
  reason: { category: ReasonCategory; text: string; validUntil: string | null } | null;
  /** Conversation or notes the decision happened in; classified by the agent when no reason is given. */
  conversation: string | null;
}

export interface DecisionRow {
  id: string;
  expertId: string;
  tripId: string;
  itemId: string | null;
  optionRef: string | null;
  clientId: string | null;
  supplierName: string | null;
  kind: DecisionKind;
  subject: string;
  before: string | null;
  after: string | null;
  decidedAt: string;
  reason: CapturedReason | null;
  learning: LearningUpdate | null;
  status: DecisionStatus;
  question: string | null;
  learningTarget: LearningTarget | null;
}

function mapDecision(r: Record<string, unknown>): DecisionRow {
  return {
    id: String(r.id),
    expertId: String(r.expert_id),
    tripId: String(r.trip_id),
    itemId: str(r.item_id),
    optionRef: str(r.option_ref),
    clientId: str(r.client_id),
    supplierName: str(r.supplier_name),
    kind: r.kind as DecisionKind,
    subject: String(r.subject),
    before: str(r.before_text),
    after: str(r.after_text),
    decidedAt: iso(r.decided_at)!,
    reason: (r.reason as CapturedReason | null) ?? null,
    learning: (r.learning as LearningUpdate | null) ?? null,
    status: r.status as DecisionStatus,
    question: str(r.question),
    learningTarget: (r.learning_target as LearningTarget | null) ?? null,
  };
}

const toDomain = (d: DecisionRow, reason: CapturedReason | null): Decision => ({
  id: d.id,
  expertId: d.expertId,
  tripId: d.tripId,
  clientId: d.clientId,
  supplierId: d.supplierName,
  kind: d.kind,
  subject: d.subject,
  before: d.before,
  after: d.after,
  decidedAt: d.decidedAt,
  reason,
});

const VERB: Record<DecisionKind, string> = { select: "choose", reject: "pass on", edit: "change" };
const genericQuestion = (d: DecisionRow) => `Why did you ${VERB[d.kind]} ${d.subject}?`;

async function similarUnexplained(q: Queryable, d: DecisionRow): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `select count(*)::int as n from decisions
      where expert_id = $1 and kind = $2 and id <> $3 and status in ('unexplained', 'awaiting_answer')
        and decided_at > $4::timestamptz - interval '90 days'`,
    [d.expertId, d.kind, d.id, d.decidedAt],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * File a learning where it belongs. Idempotent per decision: each target
 * table is unique on the decision, so a re-run job can't file it twice.
 *
 * A reason the expert stated (in the conversation or by answering) is theirs;
 * one the agent inferred stays marked as the agent's. The taste model is
 * stricter: anything the agent filed there is provisional until the expert
 * endorses it, because it shapes every future draft.
 */
async function applyLearning(q: Queryable, workspaceId: string, d: DecisionRow, learning: LearningUpdate, byExpert: boolean): Promise<void> {
  const inferred = learning.provisional;
  const provisional = inferred || !byExpert;
  switch (learning.target) {
    case "taste_model":
      await q.query(
        `insert into expert_learnings (id, workspace_id, expert_id, decision_id, kind, subject, summary, status, observed_at, reviewed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (decision_id) do nothing`,
        [randomUUID(), workspaceId, d.expertId, d.id, d.kind, d.subject, learning.summary, provisional ? "provisional" : "endorsed", learning.observedAt, provisional ? null : learning.observedAt],
      );
      return;
    case "client_brief":
      await insertBriefStatement(q, workspaceId, {
        id: randomUUID(),
        clientId: learning.recordId,
        // Learned on this trip; the expert promotes it if it should outlast it.
        tripId: d.tripId,
        dimension: "desired_experience",
        text: learning.summary,
        evidence: inferred ? "agent_inferred" : "expert_inferred",
        source: `judgment ${learning.observedAt.slice(0, 10)}`,
        recordedAt: learning.observedAt,
        supersededBy: null,
        recordedBy: d.expertId,
        originDecisionId: d.id,
      });
      return;
    case "supplier_record":
      await q.query(
        `insert into supplier_conditions (id, workspace_id, owner_id, supplier_name, condition, observed_at, valid_until, provisional, decision_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (decision_id) do nothing`,
        [randomUUID(), workspaceId, d.expertId, learning.recordId, learning.summary, learning.observedAt, validDate(learning.validUntil), inferred, d.id],
      );
      return;
    case "trip":
      await q.query("insert into trip_notes (id, workspace_id, trip_id, decision_id, text, created_by) values ($1,$2,$3,$4,$5,$6) on conflict (decision_id) do nothing", [
        randomUUID(),
        workspaceId,
        d.tripId,
        d.id,
        learning.summary,
        d.expertId,
      ]);
  }
}

/** Model-supplied dates are only used when they are actual dates. */
const validDate = (v: string | null): string | null => (v && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null);

async function saveOutcome(
  q: Queryable,
  id: string,
  fromStatuses: DecisionStatus[],
  out: { status: DecisionStatus; reason: CapturedReason | null; learning: LearningUpdate | null; question: string | null; answeredAt?: string | null },
): Promise<boolean> {
  const { rows } = await q.query(
    `update decisions set status = $2, reason = $3, learning = $4, question = $5, learning_target = $6, answered_at = coalesce($7, answered_at)
      where id = $1 and status = any($8::text[]) returning id`,
    [id, out.status, out.reason ? JSON.stringify(out.reason) : null, out.learning ? JSON.stringify(out.learning) : null, out.question, out.learning?.target ?? null, out.answeredAt ?? null, fromStatuses],
  );
  return rows.length === 1;
}

function checkReason(r: NonNullable<DecisionInput["reason"]>): CapturedReason {
  const text = r.text.trim();
  if (text.length < 2) throw new DomainError("bad_reason", "Say why in a few words");
  if (r.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(r.validUntil)) throw new DomainError("bad_date", "Use a date for how long the condition lasts");
  return { category: r.category, text, origin: "asked", validUntil: r.category === "supplier_condition" ? r.validUntil : null };
}

/** Record a decision and route or schedule its lesson. Returns the decision id and what happens next. */
export async function recordDecision(db: Db, tenant: Tenant, input: DecisionInput, now: Date, agentsOn: boolean): Promise<{ id: string; status: DecisionStatus }> {
  const reason = input.reason ? checkReason({ ...input.reason, text: input.reason.text.trim() || REASON_LABEL[input.reason.category] }) : null;
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const trip = (await q.query<{ id: string; client_id: string | null }>("select id, client_id from trips where id = $1", [input.tripId])).rows[0];
    if (!trip) throw new DomainError("not_found", "Trip not found");
    let subject = input.subject?.trim() || null;
    let supplier = input.supplierName?.trim() || null;
    if (input.itemId) {
      const item = (await q.query<{ title: string; supplier_name: string | null }>("select title, supplier_name from trip_items where id = $1 and trip_id = $2", [input.itemId, input.tripId])).rows[0];
      if (!item) throw new DomainError("not_found", "That item isn't on this trip");
      subject ??= item.title;
      supplier ??= item.supplier_name;
    }
    if (!subject) throw new DomainError("bad_subject", "Say what was chosen, passed on or changed");
    if (input.kind === "edit" && !input.after?.trim()) throw new DomainError("bad_edit", "Describe the change");
    const conversation = input.conversation?.trim() || null;

    const id = randomUUID();
    const row: DecisionRow = {
      id,
      expertId: tenant.memberId,
      tripId: input.tripId,
      itemId: input.itemId,
      optionRef: input.optionRef?.trim() || null,
      clientId: trip.client_id,
      supplierName: supplier,
      kind: input.kind,
      subject,
      before: input.before?.trim() || null,
      after: input.after?.trim() || null,
      decidedAt: now.toISOString(),
      reason: null,
      learning: null,
      status: "recorded",
      question: null,
      learningTarget: null,
    };
    const conversationEnc = conversation ? await encryptFor(q, tenant.workspaceId, encCtx("decisions", "conversation", id), conversation) : null;
    await q.query(
      `insert into decisions (id, workspace_id, expert_id, trip_id, kind, subject, decided_at, item_id, option_ref, supplier_name, client_id, before_text, after_text, conversation_enc, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'recorded')`,
      [id, tenant.workspaceId, row.expertId, row.tripId, row.kind, row.subject, row.decidedAt, row.itemId, row.optionRef, row.supplierName, row.clientId, row.before, row.after, conversationEnc],
    );

    let status: DecisionStatus;
    if (reason) {
      const learning = routeDecision(toDomain(row, reason));
      await saveOutcome(q, id, ["recorded"], { status: "learned", reason, learning, question: null });
      if (learning) await applyLearning(q, tenant.workspaceId, row, learning, true);
      status = "learned";
    } else if (conversation && agentsOn) {
      await saveOutcome(q, id, ["recorded"], { status: "classifying", reason: null, learning: null, question: null });
      await enqueueAsTenant(q, { kind: CLASSIFY_KIND, payload: { decisionId: id }, dedupeKey: `${CLASSIFY_KIND}:${id}` });
      status = "classifying";
    } else {
      const ask = shouldAskWhy(toDomain(row, null), { inferredConfidence: null, similarUnexplainedCount: await similarUnexplained(q, row) });
      status = ask ? "awaiting_answer" : "unexplained";
      await saveOutcome(q, id, ["recorded"], { status, reason: null, learning: null, question: ask ? genericQuestion(row) : null });
    }
    await audit(q, tenant, "decision.recorded", id, { tripId: row.tripId, kind: row.kind, status, target: reason ? routeDecision(toDomain(row, reason))?.target : null });
    return { id, status };
  });
}

/**
 * Job body: classify the reason from the conversation, then route it or ask.
 * Runs as the expert. Idempotent: the outcome is saved only while the
 * decision is still 'classifying', in the same transaction as the learning.
 */
export async function runDecisionClassification(db: Db, deps: OpsDeps, tenant: Tenant | null, decisionId: string): Promise<void> {
  if (!tenant) throw new PermanentJobError("Classification needs the expert who recorded the decision");
  const loaded = await withTenant(db, tenant, async (q) => {
    const r = (await q.query<Record<string, unknown>>("select * from decisions where id = $1", [decisionId])).rows[0];
    if (!r || r.status !== "classifying") return null;
    const d = mapDecision(r);
    const conversation = r.conversation_enc ? await decryptFor(q, tenant.workspaceId, encCtx("decisions", "conversation", decisionId), String(r.conversation_enc)) : null;
    return { d, conversation, similar: await similarUnexplained(q, d) };
  });
  if (!loaded) return;
  const { d, conversation, similar } = loaded;

  const fallback = async (error: string | null) =>
    withTenant(db, tenant, async (q) => {
      // Without a classification, fall back to the deterministic rule for whether to ask.
      const ask = shouldAskWhy(toDomain(d, null), { inferredConfidence: null, similarUnexplainedCount: similar });
      const saved = await saveOutcome(q, d.id, ["classifying"], { status: ask ? "awaiting_answer" : error ? "failed" : "unexplained", reason: null, learning: null, question: ask ? genericQuestion(d) : null });
      if (saved) await audit(q, tenant, "decision.classification_failed", d.id, { error }, "agent:judgment");
    });
  if (!conversation || !deps.agentsConfigured()) return fallback(conversation ? "agents not configured" : "conversation purged");

  const r = await classifyDecision(deps.llm(), toDomain(d, null), conversation, { similarUnexplainedCount: similar });
  if ("error" in r) return fallback(r.error);

  await withTenant(db, tenant, async (q) => {
    const reason = r.decision.reason;
    if (r.ask) {
      // Hold the agent's best guess on the decision; nothing is filed until the expert answers.
      const saved = await saveOutcome(q, d.id, ["classifying"], { status: "awaiting_answer", reason, learning: null, question: r.ask });
      if (saved) await audit(q, tenant, "decision.question_asked", d.id, {}, "agent:judgment");
      return;
    }
    const saved = await saveOutcome(q, d.id, ["classifying"], { status: r.learning ? "learned" : "unexplained", reason, learning: r.learning, question: null });
    if (!saved) return;
    if (r.learning) await applyLearning(q, tenant.workspaceId, d, r.learning, false);
    await audit(q, tenant, "decision.classified", d.id, { target: r.learning?.target ?? null, provisional: r.learning?.provisional ?? null }, "agent:judgment");
  });
}

/** The expert's one-tap answer: a category, optionally a few words, and for supplier conditions how long it lasts. */
export async function answerDecision(
  db: Db,
  tenant: Tenant,
  decisionId: string,
  answer: { category: ReasonCategory; text: string | null; validUntil: string | null },
  now: Date,
): Promise<LearningTarget | null> {
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const r = (await q.query<Record<string, unknown>>("select * from decisions where id = $1", [decisionId])).rows[0];
    if (!r) throw new DomainError("not_found", "Decision not found");
    const d = mapDecision(r);
    if (d.expertId !== tenant.memberId) throw new DomainError("forbidden", "Only the expert who made the decision can say why");
    if (!["awaiting_answer", "unexplained", "failed"].includes(d.status)) throw new DomainError("already_answered", "This decision already has its reason");
    const reason = checkReason({ category: answer.category, text: answer.text?.trim() || REASON_LABEL[answer.category], validUntil: answer.validUntil });
    const learning = routeDecision(toDomain(d, reason));
    const saved = await saveOutcome(q, d.id, ["awaiting_answer", "unexplained", "failed"], { status: "learned", reason, learning, question: null, answeredAt: now.toISOString() });
    if (!saved) throw new DomainError("already_answered", "This decision already has its reason");
    if (learning) await applyLearning(q, tenant.workspaceId, d, learning, true);
    await audit(q, tenant, "decision.answered", d.id, { target: learning?.target ?? null });
    return learning?.target ?? null;
  });
}

export async function listTripDecisions(db: Db, tenant: Tenant, tripId: string): Promise<DecisionRow[]> {
  return withTenant(db, tenant, async (q) =>
    (await q.query<Record<string, unknown>>("select * from decisions where trip_id = $1 order by decided_at desc", [tripId])).rows.map(mapDecision),
  );
}

export async function listOpenQuestions(db: Db, tenant: Tenant): Promise<(DecisionRow & { tripTitle: string })[]> {
  return withTenant(db, tenant, async (q) =>
    (
      await q.query<Record<string, unknown>>(
        `select d.*, t.title as trip_title from decisions d join trips t on t.id = d.trip_id
          where d.expert_id = app_member() and d.status = 'awaiting_answer' order by d.decided_at desc limit 50`,
      )
    ).rows.map((r) => ({ ...mapDecision(r), tripTitle: String(r.trip_title) })),
  );
}

// ---------------------------------------------------------------------------
// Taste model and endorsement

export interface Learning {
  id: string;
  decisionId: string | null;
  kind: DecisionKind;
  subject: string;
  summary: string;
  status: "provisional" | "endorsed" | "retracted";
  observedAt: string;
  reviewedAt: string | null;
}

export interface TasteModel {
  provisional: Learning[];
  endorsed: Learning[];
  retracted: Learning[];
  supplierConditions: { id: string; supplierName: string; condition: string; observedAt: string; validUntil: string | null; provisional: boolean; current: boolean }[];
  endorsement: ReturnType<typeof endorsementRate> & { total: number };
  recentOutcomes: { id: string; draftRef: string; outcome: string; note: string | null; recordedAt: string; tripId: string | null }[];
}

export async function tasteModel(db: Db, tenant: Tenant, now: Date): Promise<TasteModel> {
  return withTenant(db, tenant, async (q) => {
    const learnings = (await q.query<Record<string, unknown>>("select * from expert_learnings where expert_id = app_member() order by observed_at desc")).rows.map(
      (r): Learning => ({
        id: String(r.id),
        decisionId: str(r.decision_id),
        kind: r.kind as DecisionKind,
        subject: String(r.subject),
        summary: String(r.summary),
        status: r.status as Learning["status"],
        observedAt: iso(r.observed_at)!,
        reviewedAt: iso(r.reviewed_at),
      }),
    );
    const today = now.toISOString().slice(0, 10);
    const conditions = (await q.query<Record<string, unknown>>("select * from supplier_conditions where owner_id = app_member() order by observed_at desc limit 100")).rows.map((r) => {
      const validUntil = day(r.valid_until);
      return {
        id: String(r.id),
        supplierName: String(r.supplier_name),
        condition: String(r.condition),
        observedAt: iso(r.observed_at)!,
        validUntil,
        provisional: Boolean(r.provisional),
        current: validUntil === null || validUntil >= today,
      };
    });
    const outcomes = (await q.query<Record<string, unknown>>("select * from draft_outcomes where expert_id = app_member() order by recorded_at desc")).rows;
    const rate = endorsementRate(outcomes.map((o) => ({ endorsed: o.outcome !== "rejected", editedMaterially: o.outcome === "endorsed_with_edits" })));
    return {
      provisional: learnings.filter((l) => l.status === "provisional"),
      endorsed: learnings.filter((l) => l.status === "endorsed"),
      retracted: learnings.filter((l) => l.status === "retracted"),
      supplierConditions: conditions,
      endorsement: { ...rate, total: outcomes.length },
      recentOutcomes: outcomes.slice(0, 20).map((o) => ({
        id: String(o.id),
        draftRef: String(o.draft_ref),
        outcome: String(o.outcome),
        note: str(o.note),
        recordedAt: iso(o.recorded_at)!,
        tripId: str(o.trip_id),
      })),
    };
  });
}

/** Endorse a provisional learning, or retract one. Only the expert's own model is reachable (RLS). */
export async function reviewLearning(db: Db, tenant: Tenant, learningId: string, verdict: "endorse" | "retract", now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const { rows } = await q.query(
      verdict === "endorse"
        ? "update expert_learnings set status = 'endorsed', reviewed_at = $2 where id = $1 and status = 'provisional' returning id"
        : "update expert_learnings set status = 'retracted', reviewed_at = $2 where id = $1 and status <> 'retracted' returning id",
      [learningId, now.toISOString()],
    );
    if (!rows.length) throw new DomainError("not_found", verdict === "endorse" ? "No provisional learning to endorse" : "No learning to retract");
    await audit(q, tenant, `taste.${verdict === "endorse" ? "endorsed" : "retracted"}`, learningId);
  });
}

export type DraftOutcome = "endorsed_unchanged" | "endorsed_with_edits" | "rejected";

/** Record whether the expert endorsed an agent draft. Other features call this when a draft is sent, edited or discarded. */
export async function recordDraftOutcome(db: Db, tenant: Tenant, input: { draftRef: string; tripId: string | null; outcome: DraftOutcome; note: string | null }, now: Date): Promise<string> {
  const ref = input.draftRef.trim();
  if (!ref) throw new DomainError("bad_ref", "Say which draft this was");
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    if (input.tripId && !(await q.query("select 1 from trips where id = $1", [input.tripId])).rows.length) throw new DomainError("not_found", "Trip not found");
    const id = randomUUID();
    await q.query("insert into draft_outcomes (id, workspace_id, expert_id, trip_id, draft_ref, outcome, note, recorded_at) values ($1,$2,$3,$4,$5,$6,$7,$8)", [
      id,
      tenant.workspaceId,
      tenant.memberId,
      input.tripId,
      ref,
      input.outcome,
      input.note?.trim() || null,
      now.toISOString(),
    ]);
    await audit(q, tenant, "draft.outcome_recorded", id, { outcome: input.outcome });
    return id;
  });
}
