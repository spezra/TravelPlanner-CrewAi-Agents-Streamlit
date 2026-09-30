/**
 * Split terms per booking line: commission shares in basis points plus fixed
 * advisory/design/referral/execution fees, entered by people (never
 * suggested by a model) and agreed by the trip owner or a workspace owner once
 * both sides' host agreements permit sharing.
 *
 * Collaborations live in the network slice. importCollaborationFeeLines() is
 * the join: it takes that slice's fee lines (FeeLine from
 * src/domain/collaboration.ts plus the payee) and snapshots them here, keyed by
 * item, with money_splits.collaboration_ref = the collaboration id.
 */
import type { Db } from "@/db/client";
import { withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import { assertSplitAgreeable, splitFromFeeLines, type CollaborationFeeLineInput, type FeeKind, type LossBearer, type SplitTerms } from "@/domain/money";
import { requireRole, WRITERS } from "./deps";
import * as repo from "./repo";

export interface SplitInput {
  itemId: string;
  collaborationRef: string | null;
  reversalLossBearer: LossBearer;
  hostRulesOurs: SplitTerms["hostRulesOurs"];
  hostRulesTheirs: SplitTerms["hostRulesTheirs"];
  /** Shares for payees other than the workspace; the workspace keeps the remainder. */
  shares: { recipientId: string; bps: number }[];
  fees: { recipientId: string; kind: FeeKind; amountMinor: number; currency: string }[];
}

export function saveSplitTerms(db: Db, tenant: Tenant, input: SplitInput) {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "edit split terms");
    const { rows: items } = await q.query<{ trip_id: string; currency: string | null }>("select trip_id, currency from trip_items where id = $1", [input.itemId]);
    const item = items[0];
    if (!item) throw new DomainError("not_found", "Booking line not found");
    const existing = await repo.getSplitByItem(q, input.itemId);
    if (existing?.status === "agreed") throw new DomainError("split_locked", "These terms were agreed; reopen them before changing anything");

    const ws = await repo.ensureWorkspaceRecipient(q, tenant.workspaceId);
    const shares = new Map<string, number>();
    for (const s of input.shares) {
      if (s.recipientId === ws) continue;
      if (!Number.isInteger(s.bps) || s.bps < 0 || s.bps > 10_000) throw new DomainError("bad_split", "Shares must be between 0% and 100%");
      if (s.bps > 0) shares.set(s.recipientId, (shares.get(s.recipientId) ?? 0) + s.bps);
    }
    const outside = [...shares.values()].reduce((a, b) => a + b, 0);
    if (outside > 10_000) throw new DomainError("bad_split", "Shares to others exceed 100%");
    shares.set(ws, 10_000 - outside);
    const recipients = new Set((await repo.listRecipients(q)).map((r) => r.id));
    for (const id of [...shares.keys(), ...input.fees.map((f) => f.recipientId)]) {
      if (!recipients.has(id)) throw new DomainError("not_found", "Unknown payee");
    }
    for (const f of input.fees) {
      if (!Number.isSafeInteger(f.amountMinor) || f.amountMinor <= 0) throw new DomainError("bad_fee", "Fees must be positive amounts");
    }

    let splitId = existing?.id;
    if (splitId) {
      await q.query(
        "update money_splits set collaboration_ref = $2, reversal_loss_bearer = $3, host_rules_ours = $4, host_rules_theirs = $5 where id = $1",
        [splitId, input.collaborationRef, input.reversalLossBearer, input.hostRulesOurs, input.hostRulesTheirs],
      );
      await q.query("delete from money_split_shares where split_id = $1", [splitId]);
      await q.query("delete from money_split_fees where split_id = $1", [splitId]);
    } else {
      const { rows } = await q.query<{ id: string }>(
        `insert into money_splits (workspace_id, trip_id, item_id, collaboration_ref, reversal_loss_bearer, host_rules_ours, host_rules_theirs, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [tenant.workspaceId, item.trip_id, input.itemId, input.collaborationRef, input.reversalLossBearer, input.hostRulesOurs, input.hostRulesTheirs, tenant.memberId],
      );
      splitId = rows[0]!.id;
    }
    for (const [recipientId, bps] of shares) {
      await q.query("insert into money_split_shares (split_id, workspace_id, recipient_id, bps) values ($1,$2,$3,$4)", [splitId, tenant.workspaceId, recipientId, bps]);
    }
    for (const f of input.fees) {
      await q.query("insert into money_split_fees (split_id, workspace_id, recipient_id, kind, amount_minor, currency) values ($1,$2,$3,$4,$5,$6)", [
        splitId,
        tenant.workspaceId,
        f.recipientId,
        f.kind,
        f.amountMinor,
        f.currency.toUpperCase(),
      ]);
    }
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.split_saved", splitId, { itemId: input.itemId, shares: [...shares], fees: input.fees });
    return (await repo.getSplit(q, splitId))!;
  });
}

/** Snapshot a collaboration's fee lines as this booking line's split terms. */
export async function importCollaborationFeeLines(
  db: Db,
  tenant: Tenant,
  input: { itemId: string; collaborationRef: string; lines: CollaborationFeeLineInput[]; reversalLossBearer: LossBearer; hostRulesOurs: SplitTerms["hostRulesOurs"]; hostRulesTheirs: SplitTerms["hostRulesTheirs"] },
) {
  const ws = await withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "edit split terms");
    return repo.ensureWorkspaceRecipient(q, tenant.workspaceId);
  });
  const terms = splitFromFeeLines(input.itemId, input.lines, ws);
  return saveSplitTerms(db, tenant, {
    itemId: input.itemId,
    collaborationRef: input.collaborationRef,
    reversalLossBearer: input.reversalLossBearer,
    hostRulesOurs: input.hostRulesOurs,
    hostRulesTheirs: input.hostRulesTheirs,
    shares: terms.shares.filter((s) => s.recipientId !== ws),
    fees: terms.fees,
  });
}

/** Agreeing terms is a money decision: the trip owner or a workspace owner. */
export function agreeSplit(db: Db, tenant: Tenant, splitId: string, now: Date) {
  return withTenant(db, tenant, async (q) => {
    const role = await requireRole(q, WRITERS, "agree split terms");
    const split = await repo.getSplit(q, splitId);
    if (!split) throw new DomainError("not_found", "Split terms not found");
    const { rows } = await q.query<{ owner_id: string }>("select owner_id from trips where id = $1", [split.tripId]);
    if (rows[0]?.owner_id !== tenant.memberId && role !== "owner") {
      throw new DomainError("forbidden", "Only the trip owner or a workspace owner can agree split terms");
    }
    if (split.status === "agreed") throw new DomainError("invalid_transition", "These terms are already agreed");
    const ws = await repo.ensureWorkspaceRecipient(q, tenant.workspaceId);
    assertSplitAgreeable(split, ws);
    await q.query("update money_splits set status = 'agreed', agreed_by = $2, agreed_at = $3 where id = $1 and status = 'draft'", [splitId, tenant.memberId, now.toISOString()]);
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.split_agreed", splitId, { shares: split.shares, fees: split.fees, bearer: split.reversalLossBearer });
  });
}

/** Reopen agreed terms, only while nothing has been allocated or paid under them. */
export function reopenSplit(db: Db, tenant: Tenant, splitId: string) {
  return withTenant(db, tenant, async (q) => {
    const role = await requireRole(q, WRITERS, "reopen split terms");
    const split = await repo.getSplit(q, splitId);
    if (!split) throw new DomainError("not_found", "Split terms not found");
    const { rows } = await q.query<{ owner_id: string }>("select owner_id from trips where id = $1", [split.tripId]);
    if (rows[0]?.owner_id !== tenant.memberId && role !== "owner") throw new DomainError("forbidden", "Only the trip owner or a workspace owner can reopen split terms");
    const { rows: lines } = await q.query("select 1 from money_payout_lines where split_id = $1 and status <> 'canceled' limit 1", [splitId]);
    if (lines.length) throw new DomainError("split_in_use", "Money has already been allocated under these terms; record an amendment instead");
    await q.query("update money_splits set status = 'draft', agreed_by = null, agreed_at = null where id = $1", [splitId]);
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.split_reopened", splitId);
  });
}
