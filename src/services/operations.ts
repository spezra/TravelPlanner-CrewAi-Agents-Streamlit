/**
 * Application services: domain rules + persistence, one tenant-bound
 * transaction per operation, an audit event for every consequential step.
 */
import { randomUUID } from "node:crypto";
import { evaluateAction, type GateFailure } from "@/domain/actionGate";
import { decideApproval, type ActionSpec, type MaterialTerms } from "@/domain/approvals";
import { buildAttentionQueue, type AttentionItem } from "@/domain/attention";
import { missingCredentialFields, transitionItem, type TripItem } from "@/domain/bookings";
import { DomainError } from "@/domain/common";
import { reviewRouting, type Commitment } from "@/domain/commitments";
import { nudges as personNudges } from "@/domain/crm";
import { execute, idempotencyKey, reconcile, type ExecutionAttempt, type ProviderAdapter } from "@/domain/execution";
import type { TrustTier } from "@/domain/knowledge";
import type { Db, Queryable } from "@/db/client";
import * as repo from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";

export function attentionQueue(db: Db, tenant: Tenant, now: Date): Promise<AttentionItem[]> {
  return withTenant(db, tenant, async (q) => {
    const [approvals, items, commitments, people, ledger, pendingPublicationIds] = await Promise.all([
      repo.listApprovals(q, { status: "pending" }),
      repo.listItems(q),
      repo.listCommitments(q),
      repo.listPeople(q),
      repo.listLedger(q),
      repo.listPendingPublicationIds(q),
    ]);
    const mine = people.filter((p) => p.ownerId === tenant.memberId);
    const nudges = mine.flatMap((p) => personNudges(p, ledger.filter((e) => e.personId === p.id), now));
    return buildAttentionQueue({ now, approvals, items, commitments, nudges, pendingPublicationIds });
  });
}

export function decide(db: Db, tenant: Tenant, approvalId: string, decision: "approved" | "rejected", now: Date, note: string | null = null) {
  return withTenant(db, tenant, async (q) => {
    const a = await repo.getApproval(q, approvalId);
    if (!a) throw new DomainError("not_found", `Approval ${approvalId} not found`);
    const trip = await repo.getTrip(q, a.tripId);
    // Money decisions belong to the expert who owns the trip (or a delegate RLS already admitted with trip access
    // AND an owner/admin role). Assistants prepare; they don't approve spend.
    const { rows } = await q.query<{ role: string }>("select role from members where id = $1", [tenant.memberId]);
    const role = rows[0]?.role;
    if (trip?.ownerId !== tenant.memberId && role !== "owner") {
      throw new DomainError("forbidden", "Only the trip owner or a workspace owner can decide money approvals");
    }
    const decided = decideApproval(a, decision, tenant.memberId, now, note);
    await repo.saveApprovalDecision(q, decided);
    for (const action of decided.actions) {
      const item = await repo.getItem(q, action.itemId);
      if (!item) continue;
      const to = decision === "approved" ? "approved" : "design";
      if (item.state === "awaiting_approval") await repo.updateItemState(q, transitionItem(item, to));
    }
    await repo.audit(q, tenant.workspaceId, tenant.memberId, `approval.${decision}`, approvalId, { terms: decided.terms, note });
    return decided;
  });
}

export type BookResult =
  | { status: "blocked"; failures: GateFailure[] }
  | { status: "done"; item: TripItem; attempt: ExecutionAttempt };

/**
 * Book an approved item. Re-reads current terms from the source, checks the
 * action gate, then executes with an idempotency key derived from the approved
 * terms. Outcome-unknown results park the item for reconciliation.
 */
export async function bookItem(
  db: Db,
  tenant: Tenant,
  input: { itemId: string; adapter: ProviderAdapter; readCurrentTerms: (item: TripItem) => Promise<MaterialTerms>; evidenceTier: TrustTier; now: Date },
): Promise<BookResult> {
  const action: ActionSpec = { kind: "book", itemId: input.itemId };

  // Phase 0: re-read current conditions from the source, outside any transaction.
  const snapshot = await withTenant(db, tenant, (q) => repo.getItem(q, input.itemId));
  if (!snapshot) throw new DomainError("not_found", `Item ${input.itemId} not found`);
  const currentTerms = await input.readCurrentTerms(snapshot);

  // Phase 1: gate and claim the item, committed before any external call so a crash can't lose the fact we sent it.
  const prepared = await withTenant(db, tenant, async (q) => {
    const item = await repo.getItem(q, input.itemId);
    if (!item) throw new DomainError("not_found", `Item ${input.itemId} not found`);
    const approvals = await repo.listApprovals(q, { tripId: item.tripId, status: "approved" });
    const approval = approvals.find((a) => a.actions.some((x) => x.kind === "book" && x.itemId === item.id)) ?? null;
    const gate = evaluateAction({ action, evidenceTier: input.evidenceTier, requiredTier: "recommend", approval, currentTerms, now: input.now });
    const missing = missingCredentialFields(item);
    const failures: GateFailure[] = gate.allowed ? [] : [...gate.failures];
    if (missing.length) failures.push({ test: "evidence", detail: `Booking credentials incomplete: ${missing.join(", ")}` });
    if (item.state !== "approved") failures.push({ test: "permission", detail: `Item is ${item.state}, not approved` });
    if (failures.length) return { kind: "blocked" as const, failures };

    const key = idempotencyKey({ workspaceId: tenant.workspaceId, itemId: item.id, action: "book", termsFingerprint: approval!.termsFingerprint });
    const existing = await repo.getAttemptByKey(q, key);
    const attempt: ExecutionAttempt = existing ?? {
      id: randomUUID(),
      idempotencyKey: key,
      action: "book",
      itemId: item.id,
      state: "prepared",
      providerRef: null,
      attempts: 0,
      lastError: null,
    };
    await repo.updateItemState(q, transitionItem(item, "booking"));
    await repo.saveAttempt(q, tenant.workspaceId, attempt, input.adapter.name);
    await repo.audit(q, tenant.workspaceId, "agent:booking", "booking.sent", item.id, { key, approvalId: approval!.id });
    return { kind: "claimed" as const, item: { ...item, state: "booking" as const }, attempt, terms: currentTerms };
  });
  if (prepared.kind === "blocked") return { status: "blocked", failures: prepared.failures };

  // Phase 2: the external call, outside any transaction.
  const result = await execute(prepared.attempt, input.adapter, { itemId: prepared.item.id, terms: prepared.terms });

  // Phase 3: record the outcome.
  return withTenant(db, tenant, async (q) => {
    await repo.saveAttempt(q, tenant.workspaceId, result, input.adapter.name);
    const to = result.state === "succeeded" ? "confirmed" : result.state === "outcome_unknown" ? "outcome_unknown" : "failed";
    const item = { ...transitionItem(prepared.item, to), confirmationRef: result.providerRef };
    await repo.updateItemState(q, item);
    await repo.audit(q, tenant.workspaceId, "agent:booking", `booking.${to}`, item.id, { key: result.idempotencyKey, error: result.lastError });
    return { status: "done", item, attempt: result };
  });
}

/** Resolve an outcome-unknown booking by asking the provider under the same key. */
export async function reconcileItem(db: Db, tenant: Tenant, itemId: string, adapter: ProviderAdapter): Promise<TripItem> {
  const attempt = await withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<{ idempotency_key: string }>(
      "select idempotency_key from execution_attempts where item_id = $1 and state = 'outcome_unknown' order by updated_at desc limit 1",
      [itemId],
    );
    if (!rows[0]) throw new DomainError("nothing_to_reconcile", `No outcome-unknown attempt for item ${itemId}`);
    return repo.getAttemptByKey(q, rows[0].idempotency_key);
  });
  const resolved = await reconcile(attempt!, adapter);
  return withTenant(db, tenant, async (q) => {
    await repo.saveAttempt(q, tenant.workspaceId, resolved, adapter.name);
    const item = (await repo.getItem(q, itemId))!;
    let next = item;
    if (resolved.state === "succeeded") next = { ...transitionItem(item, "confirmed"), confirmationRef: resolved.providerRef };
    else if (resolved.state === "retryable_error") next = transitionItem(item, "failed");
    if (next !== item) await repo.updateItemState(q, next);
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "booking.reconciled", itemId, { result: resolved.state });
    return next;
  });
}

/** File commitments extracted from a call or debrief, routing uncertain/consequential ones to the expert. */
export function fileCommitments(db: Db, tenant: Tenant, drafts: Omit<Commitment, "id" | "reviewStatus" | "state">[]): Promise<Commitment[]> {
  return withTenant(db, tenant, async (q: Queryable) => {
    const filed: Commitment[] = [];
    for (const d of drafts) {
      const c: Commitment = { ...d, id: randomUUID(), state: "pending", reviewStatus: reviewRouting(d) };
      await repo.insertCommitment(q, tenant.workspaceId, c);
      filed.push(c);
    }
    await repo.audit(q, tenant.workspaceId, "agent:commitments", "commitments.filed", String(filed.length), {
      needsReview: filed.filter((c) => c.reviewStatus === "needs_review").map((c) => c.id),
    });
    return filed;
  });
}
