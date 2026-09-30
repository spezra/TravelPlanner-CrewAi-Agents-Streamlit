/**
 * Commitments across trips: manual entry, state transitions, review, delivery
 * to the traveler, and the written recap of our understanding. Evidence (how
 * we know) and state (what is happening) stay separate throughout.
 */
import { randomUUID } from "node:crypto";
import { draftRecap as agentDraftRecap } from "@/agents/recapDrafter";
import type { StructuredLLM } from "@/agents/llm";
import type { Db } from "@/db/client";
import { audit, getItem, getTrip, insertCommitment } from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { frameRecap, matchesFilter, recapFallbackDraft, type CommitmentFilter } from "@/domain/callTasks";
import { DomainError } from "@/domain/common";
import { transitionCommitment, type Commitment, type CommitmentState, type EvidenceType } from "@/domain/commitments";
import { encryptFor } from "@/server/crypto";
import { SYSTEM_FOOTER, type Mailer } from "@/server/mail";
import * as calls from "./repo";
import { loadTaskForWork } from "./tasks";

export async function listCommitmentsFiltered(db: Db, tenant: Tenant, filter: CommitmentFilter, now: Date): Promise<calls.CommitmentView[]> {
  const all = await withTenant(db, tenant, (q) => calls.listCommitmentViews(q));
  return all.filter((c) => matchesFilter(c, filter, now));
}

export interface ManualCommitment {
  callTaskId: string | null;
  tripId: string | null;
  itemId: string | null;
  promisor: string;
  promisorPersonId: string | null;
  promise: string;
  conditions: string | null;
  dueBy: string | null;
  evidence: EvidenceType;
  evidenceRef: string | null;
  consequential: boolean;
}

/** The expert enters a commitment themselves (agents not configured, or something the agent missed). */
export async function addManualCommitment(db: Db, tenant: Tenant, input: ManualCommitment, now: Date): Promise<string> {
  const promisor = input.promisor.trim();
  const promise = input.promise.trim();
  if (!promisor || !promise) throw new DomainError("missing_field", "Who promised and what they promised are both required");
  // A datetime-local value has no zone; the form labels it UTC.
  const dueRaw = input.dueBy && /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(input.dueBy) ? `${input.dueBy}Z` : input.dueBy;
  if (dueRaw && Number.isNaN(Date.parse(dueRaw))) throw new DomainError("bad_date", "Due date isn't a valid date");
  return withTenant(db, tenant, async (q) => {
    let tripId = input.tripId;
    if (input.callTaskId) {
      const task = await loadTaskForWork(q, tenant, input.callTaskId, now);
      tripId = task.tripId;
    }
    if (tripId && !(await getTrip(q, tripId))) throw new DomainError("not_found", "Trip not found");
    if (input.itemId) {
      const item = await getItem(q, input.itemId);
      if (!item || item.tripId !== tripId) throw new DomainError("bad_item", "That booking isn't on this trip");
    }
    const c: Commitment = {
      id: randomUUID(),
      tripId,
      itemId: input.itemId,
      promisor,
      promisorPersonId: input.promisorPersonId,
      promise,
      conditions: input.conditions?.trim() || null,
      dueBy: dueRaw ? new Date(dueRaw).toISOString() : null,
      evidence: input.evidence,
      evidenceRef: input.evidenceRef,
      state: "pending",
      transcriptVerified: false,
      confidence: 1,
      consequential: input.consequential,
      // A person entered it, so a person has reviewed it.
      reviewStatus: "reviewed",
      recapSentAt: null,
      deliveredToTravelerAt: null,
    };
    await insertCommitment(q, tenant.workspaceId, c);
    if (input.callTaskId) await q.query("update commitments set call_task_id = $2 where id = $1", [c.id, input.callTaskId]);
    await audit(q, tenant.workspaceId, tenant.memberId, "commitment.entered", c.id, { callTaskId: input.callTaskId, evidence: c.evidence });
    return c.id;
  });
}

export async function changeCommitmentState(db: Db, tenant: Tenant, input: { id: string; to: CommitmentState }): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const [c] = await calls.listCommitmentViews(q, { ids: [input.id] });
    if (!c) throw new DomainError("not_found", "Commitment not found");
    const next = transitionCommitment(c, input.to);
    // Guarded on the state we read, so two people changing it at once can't both win.
    const { rows } = await q.query("update commitments set state = $3 where id = $1 and state = $2 returning id", [c.id, c.state, next.state]);
    if (!rows.length) throw new DomainError("conflict", "Someone else just changed this commitment; reload and try again");
    await audit(q, tenant.workspaceId, tenant.memberId, "commitment.state_changed", c.id, { from: c.state, to: next.state });
  });
}

/** "Confirm checked": a person reviewed it, including any machine-transcribed names, amounts and dates. */
export async function confirmChecked(db: Db, tenant: Tenant, id: string): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const c = (await q.query<{ consequential: boolean }>("select consequential from commitments where id = $1", [id])).rows[0];
    if (!c) throw new DomainError("not_found", "Commitment not found");
    const role = (await q.query<{ role: string }>("select role from members where id = app_member()")).rows[0]?.role;
    // Consequential promises go to the expert: assistants prepare, they don't sign off.
    if (c.consequential && role === "assistant") throw new DomainError("forbidden", "A consequential commitment is checked by the expert, not an assistant");
    const { rows } = await q.query(
      "update commitments set review_status = 'reviewed', transcript_verified = transcript_verified or evidence = 'machine_transcript' where id = $1 returning id",
      [id],
    );
    if (!rows.length) throw new DomainError("not_found", "Commitment not found");
    await audit(q, tenant.workspaceId, tenant.memberId, "commitment.reviewed", id);
  });
}

/** Follow-through ends when the traveler actually receives what was promised. */
export async function markDelivered(db: Db, tenant: Tenant, id: string, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const [c] = await calls.listCommitmentViews(q, { ids: [id] });
    if (!c) throw new DomainError("not_found", "Commitment not found");
    if (c.deliveredToTravelerAt) throw new DomainError("already_delivered", "Already marked delivered");
    const next = c.state === "fulfilled" ? c : transitionCommitment(c, "fulfilled");
    const { rows } = await q.query(
      "update commitments set state = $3, delivered_to_traveler_at = $4 where id = $1 and state = $2 and delivered_to_traveler_at is null returning id",
      [c.id, c.state, next.state, now.toISOString()],
    );
    if (!rows.length) throw new DomainError("conflict", "Someone else just changed this commitment; reload and try again");
    await audit(q, tenant.workspaceId, tenant.memberId, "commitment.delivered", c.id, { from: c.state });
  });
}

export interface RecapContext {
  commitments: calls.CommitmentView[];
  callTaskId: string | null;
  supplierName: string | null;
  agencyName: string;
  onBehalfOf: string;
}

async function recapContext(db: Db, tenant: Tenant, ids: string[]): Promise<RecapContext> {
  if (ids.length === 0) throw new DomainError("nothing_selected", "Choose at least one commitment for the recap");
  return withTenant(db, tenant, async (q) => {
    const commitments = await calls.listCommitmentViews(q, { ids });
    if (commitments.length !== new Set(ids).size) throw new DomainError("not_found", "Some of those commitments aren't visible to you");
    const taskIds = [...new Set(commitments.map((c) => c.callTaskId))];
    const callTaskId = taskIds.length === 1 ? taskIds[0]! : null;
    const task = callTaskId ? await calls.getCallTask(q, callTaskId) : null;
    const promisors = [...new Set(commitments.filter((c) => !/^(us|we)\b/i.test(c.promisor)).map((c) => c.promisor))];
    const workspace = (await q.query<{ name: string }>("select name from workspaces")).rows[0]?.name ?? "The agency";
    const me = (await q.query<{ name: string }>("select name from members where id = $1", [tenant.memberId])).rows[0]?.name ?? "your advisor";
    return {
      commitments,
      callTaskId,
      supplierName: task?.personName ?? (promisors.length === 1 ? promisors[0]! : null),
      agencyName: workspace,
      onBehalfOf: task?.ownerName ?? me,
    };
  });
}

export interface RecapDraft {
  ids: string[];
  subject: string;
  body: string;
  /** The fixed header shown above the editable body; always sent. */
  header: string;
  drafted: "agent" | "template";
  agentError: string | null;
  context: RecapContext;
}

/** The agent drafts; without a model, a plain template. Either way the expert edits before sending. */
export async function prepareRecap(db: Db, tenant: Tenant, llm: StructuredLLM | null, ids: string[]): Promise<RecapDraft> {
  const ctx = await recapContext(db, tenant, ids);
  const header = frameRecap("", { agencyName: ctx.agencyName, expertName: ctx.onBehalfOf }).trim();
  let agentError: string | null = null;
  if (llm) {
    const drafted = await agentDraftRecap(llm, { supplierName: ctx.supplierName, language: null, commitments: ctx.commitments }).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!("error" in drafted)) return { ids, ...drafted, header, drafted: "agent", agentError: null, context: ctx };
    agentError = drafted.error;
  }
  return { ids, ...recapFallbackDraft(ctx.commitments, ctx.supplierName), header, drafted: "template", agentError, context: ctx };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Send the edited recap. It is labeled as coming from the agency's system and
 * as a record of our understanding, whatever the edited body says. The send
 * happens inside the transaction, so a failed send records nothing.
 */
export async function sendRecap(
  db: Db,
  tenant: Tenant,
  mail: Mailer,
  input: { ids: string[]; to: string; subject: string; body: string },
  now: Date,
): Promise<string> {
  const to = input.to.trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw new DomainError("bad_email", "Enter the supplier's email address");
  const subject = input.subject.trim().replace(/[\r\n]+/g, " ");
  if (!subject || !input.body.trim()) throw new DomainError("missing_field", "Subject and body are required");
  const ctx = await recapContext(db, tenant, input.ids);
  return withTenant(db, tenant, async (q) => {
    const role = await calls.memberRole(q, tenant.memberId);
    const task = ctx.callTaskId ? await calls.getCallTask(q, ctx.callTaskId) : null;
    const isHolderOrAssignee = task ? [task.ownerId, task.assigneeId].includes(tenant.memberId) : false;
    // Relationships decide who communicates: assistants prepare recaps; the holder, the call's assignee or an advisor sends.
    if (role === "assistant" && !isHolderOrAssignee) {
      throw new DomainError("forbidden", "Assistants prepare recaps; the relationship holder or the call's assignee sends them");
    }
    const text = `${frameRecap(input.body, { agencyName: ctx.agencyName, expertName: ctx.onBehalfOf })}${SYSTEM_FOOTER}`;
    const id = randomUUID();
    await q.query(
      `insert into call_recaps (id, workspace_id, call_task_id, commitment_ids, to_email, subject, body_enc, sent_by, sent_at)
       values ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9)`,
      [id, tenant.workspaceId, ctx.callTaskId, input.ids, to, subject, await encryptFor(q, tenant.workspaceId, `call_recap:${id}`, text), tenant.memberId, now.toISOString()],
    );
    await q.query("update commitments set recap_sent_at = $2 where id = any($1::uuid[])", [input.ids, now.toISOString()]);
    await audit(q, tenant.workspaceId, tenant.memberId, "commitment.recap_sent", id, { commitments: input.ids.length, callTaskId: ctx.callTaskId });
    await mail.send({ to, subject, text });
    return id;
  });
}
