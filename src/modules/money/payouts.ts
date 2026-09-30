/**
 * Payout batches. Anyone in the workspace (assistants included) can prepare a
 * batch: allocate verified nets, add agreed fees, group what is owed. Only a
 * workspace owner approves one. Execution then pays each line by the method
 * the funding path allows: a Stripe transfer from the platform balance, or a
 * settlement instruction telling the paying party exactly what to send.
 */
import type { Db, Queryable } from "@/db/client";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { DomainError, formatMoney } from "@/domain/common";
import { assertCanApproveBatch, lineMethod, settlementInstructionText, settlementReference, type LandedIn } from "@/domain/money";
import { StripeError, type StripeTransfer } from "@/providers/stripe";
import { enqueueAsTenant } from "@/server/jobs/queue";
import { log } from "@/server/log";
import { ownerEmails, requireRole, sendSystemMail, type MoneyDeps } from "./deps";
import { allocateReceivable } from "./ledger";
import { settlementDetails } from "./recipients";
import * as repo from "./repo";

const KIND_LABEL: Record<repo.LineKind, string> = {
  commission_share: "Commission share",
  commission_adjustment: "Commission adjustment",
  advisory: "Advisory fee",
  design: "Design fee",
  referral: "Referral fee",
  execution: "Execution fee",
};

/**
 * Allocates every allocatable receivable under agreed terms, adds agreed fees
 * not yet owed, and puts all unbatched payable lines into one draft batch per
 * currency. Idempotent: allocation and fee lines are unique per source.
 */
export function prepareBatches(db: Db, tenant: Tenant, now: Date): Promise<string[]> {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, ["owner", "advisor", "admin", "assistant"], "prepare payouts");
    const splits = (await repo.listSplits(q)).filter((s) => s.status === "agreed");
    for (const s of splits) {
      const r = await repo.getReceivableByItem(q, s.itemId);
      if (r) await allocateReceivable(q, tenant, r.id, now);
      for (const f of s.fees) {
        await q.query(
          `insert into money_payout_lines (workspace_id, split_id, fee_id, recipient_id, kind, amount_minor, currency, status)
           values ($1,$2,$3,$4,$5,$6,$7,'pending') on conflict (fee_id) where fee_id is not null do nothing`,
          [tenant.workspaceId, s.id, f.id, f.recipientId, f.kind, f.amountMinor, f.currency],
        );
      }
    }
    const pending = (await repo.listLines(q, { unbatchedPending: true })).filter((l) => l.amountMinor !== 0);
    if (pending.length === 0) throw new DomainError("nothing_to_pay", "Nothing is ready to pay: no verified commission under agreed terms and no unpaid fees");
    const byCurrency = new Map<string, repo.PayoutLineRow[]>();
    for (const l of pending) byCurrency.set(l.currency, [...(byCurrency.get(l.currency) ?? []), l]);
    const ids: string[] = [];
    for (const [currency, lines] of byCurrency) {
      const { rows } = await q.query<{ id: string }>(
        "insert into money_payout_batches (workspace_id, currency, status, prepared_by, prepared_at) values ($1,$2,'draft',$3,$4) returning id",
        [tenant.workspaceId, currency, tenant.memberId, now.toISOString()],
      );
      const batchId = rows[0]!.id;
      await q.query("update money_payout_lines set batch_id = $1 where id = any($2::uuid[]) and batch_id is null and status = 'pending'", [batchId, lines.map((l) => l.id)]);
      await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.batch_prepared", batchId, { currency, lines: lines.length, totalMinor: lines.reduce((s, l) => s + l.amountMinor, 0) });
      ids.push(batchId);
    }
    return ids;
  });
}

/** Money is a human gate: a workspace owner approves the batch, then the worker pays it. */
export function approveBatch(db: Db, tenant: Tenant, batchId: string, now: Date) {
  return withTenant(db, tenant, async (q) => {
    const role = await repo.memberRole(q);
    const batch = (await repo.listBatches(q, batchId))[0];
    if (!batch) throw new DomainError("not_found", "Batch not found");
    assertCanApproveBatch(role, batch);
    const { rows } = await q.query(
      "update money_payout_batches set status = 'approved', approved_by = $2, approved_at = $3 where id = $1 and status = 'draft' returning id",
      [batchId, tenant.memberId, now.toISOString()],
    );
    if (rows.length !== 1) throw new DomainError("invalid_transition", "This batch was already decided");
    await q.query("update money_payout_lines set status = 'approved' where batch_id = $1 and status = 'pending'", [batchId]);
    await enqueueAsTenant(q, { kind: "money.execute_batch", payload: { batchId }, dedupeKey: `money.execute_batch:${batchId}` });
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.batch_approved", batchId, { totalMinor: batch.totalMinor, currency: batch.currency, lines: batch.lineCount });
  });
}

export function cancelBatch(db: Db, tenant: Tenant, batchId: string) {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, ["owner", "advisor", "admin", "assistant"], "cancel a draft batch");
    const { rows } = await q.query("update money_payout_batches set status = 'canceled' where id = $1 and status = 'draft' returning id", [batchId]);
    if (rows.length !== 1) throw new DomainError("invalid_transition", "Only a draft batch can be canceled");
    await q.query("update money_payout_lines set batch_id = null where batch_id = $1 and status = 'pending'", [batchId]);
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.batch_canceled", batchId);
  });
}

interface LinePlan {
  line: repo.PayoutLineRow;
  method: "platform_transfer" | "settlement_instruction";
  destination: string | null;
}

/**
 * Pays an approved batch. Runs as the approving owner (job). Transfers use an
 * idempotency key derived from the line id; a line left "sending" by a crash
 * or timeout is reconciled against Stripe (by transfer group) before any
 * retry, so a payee is never paid twice. Safe to run any number of times.
 */
export async function executeBatch(db: Db, tenant: Tenant, batchId: string, deps: MoneyDeps, now: Date): Promise<{ transferred: number; instructed: number; failed: number }> {
  const plans = await withTenant(db, tenant, async (q) => {
    const batch = (await repo.listBatches(q, batchId))[0];
    if (!batch) throw new DomainError("not_found", "Batch not found");
    if (!["approved", "processing"].includes(batch.status)) return [];
    await q.query("update money_payout_batches set status = 'processing' where id = $1 and status = 'approved'", [batchId]);
    const lines = (await repo.listLines(q, { batchId })).filter((l) => l.status === "approved" || l.status === "sending");
    const out: LinePlan[] = [];
    for (const line of lines) {
      const recipient = (await repo.getRecipient(q, line.recipientId))!;
      let landed: LandedIn[] = [];
      if (line.receivableId) {
        landed = (await repo.listEvents(q, line.receivableId)).filter((e) => e.kind === "received").map((e) => e.landedIn ?? "external_account");
      }
      // A line already "sending" may have been transferred: it can only be finished by reconciling with Stripe.
      let method = line.status === "sending" ? "platform_transfer" : lineMethod({ kind: line.kind, amountMinor: line.amountMinor, receiptsLandedIn: landed, recipient });
      if (method === "platform_transfer" && !deps.stripe) {
        if (line.status === "sending") throw new Error("Stripe is not configured, so a transfer in flight can't be reconciled");
        method = "settlement_instruction";
      }
      if (method === "settlement_instruction") await issueInstruction(q, tenant, line, now);
      else if (line.status === "approved") {
        // Record intent before the external call, so a crash leaves evidence we may have sent it.
        await q.query("update money_payout_lines set status = 'sending', method = 'platform_transfer' where id = $1", [line.id]);
      }
      out.push({ line, method, destination: recipient.stripeAccountId });
    }
    return out;
  });

  let transferred = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const p of plans.filter((x) => x.method === "platform_transfer")) {
    const stripe = deps.stripe!;
    const group = `line_${p.line.id}`;
    try {
      let transfer: StripeTransfer | null = null;
      if (p.line.status === "sending") transfer = await stripe.findTransferByGroup(group);
      transfer ??= await stripe.createTransfer(
        {
          amountMinor: p.line.amountMinor,
          currency: p.line.currency,
          destination: p.destination!,
          transferGroup: group,
          description: `${KIND_LABEL[p.line.kind]}${p.line.itemTitle ? `: ${p.line.itemTitle}` : ""}`.slice(0, 350),
          metadata: { workspace_id: tenant.workspaceId, payout_line_id: p.line.id, batch_id: batchId },
        },
        `payout-line-${p.line.id}`,
      );
      await withTenant(db, tenant, async (q) => {
        await q.query("update money_payout_lines set status = 'settled', stripe_transfer_id = $2, settled_at = $3, failure = null where id = $1 and status = 'sending'", [
          p.line.id,
          transfer!.id,
          now.toISOString(),
        ]);
        await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.transfer_sent", p.line.id, { transfer: transfer!.id, amountMinor: p.line.amountMinor, currency: p.line.currency });
      });
      transferred++;
    } catch (err) {
      if (err instanceof StripeError && !err.retryable) {
        await withTenant(db, tenant, async (q) => {
          await q.query("update money_payout_lines set status = 'failed', failure = $2 where id = $1", [p.line.id, err.message.slice(0, 500)]);
          await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.transfer_failed", p.line.id, { code: err.code, type: err.type });
        });
        failures.push(`${p.line.recipientName}: ${formatMoney({ amountMinor: p.line.amountMinor, currency: p.line.currency })} — ${err.message}`);
        failed++;
      } else {
        // Outcome unknown: the line stays "sending" and the job retries, reconciling first.
        log.warn({ lineId: p.line.id, err: err instanceof Error ? err.message : String(err) }, "transfer outcome unknown");
        throw err;
      }
    }
  }

  await sendPendingInstructionEmails(db, tenant, deps);
  await withTenant(db, tenant, async (q) => {
    const { rows } = await q.query("select 1 from money_payout_lines where batch_id = $1 and status in ('approved', 'sending') limit 1", [batchId]);
    if (!rows.length) await maybeCompleteBatch(q, batchId, now);
  });
  if (failures.length) {
    const to = await withTenant(db, tenant, (q) => ownerEmails(q, tenant.workspaceId));
    await sendSystemMail(deps.mail, to, "Some payouts could not be sent", `These transfers failed and need your attention:\n\n${failures.join("\n")}\n\nOpen Money → Payouts to retry or settle them another way.`);
  }
  return { transferred, instructed: plans.filter((p) => p.method === "settlement_instruction").length, failed };
}

async function maybeCompleteBatch(q: Queryable, batchId: string, now: Date) {
  const { rows } = await q.query("select 1 from money_payout_lines where batch_id = $1 and status in ('approved', 'sending', 'instructed') limit 1", [batchId]);
  if (!rows.length) await q.query("update money_payout_batches set status = 'completed', completed_at = $2 where id = $1 and status = 'processing'", [batchId, now.toISOString()]);
}

/**
 * A settlement instruction: who pays whom, exactly how much, with which
 * reference. A positive line is paid by the workspace to the payee; a negative
 * one (an allocation clawed back) is owed by the payee to the workspace.
 */
async function issueInstruction(q: Queryable, tenant: Tenant, line: repo.PayoutLineRow, now: Date) {
  const { rows: ws } = await q.query<{ name: string }>("select name from workspaces where id = $1", [tenant.workspaceId]);
  const { rows: me } = await q.query<{ email: string }>("select email from members where id = $1", [tenant.memberId]);
  const recipient = (await repo.getRecipient(q, line.recipientId))!;
  const workspace = { name: ws[0]!.name, email: me[0]?.email ?? null };
  const payee = { name: recipient.name, email: recipient.email };
  const [payer, to] = line.amountMinor > 0 ? [workspace, payee] : [payee, workspace];
  const purpose = `${KIND_LABEL[line.kind]}${line.itemTitle ? ` — ${line.itemTitle}` : ""}${line.tripTitle ? ` (${line.tripTitle})` : ""}${line.amountMinor < 0 ? " — repayment of an allocation reduced after payment" : ""}`;
  await q.query(
    `insert into money_settlement_instructions (workspace_id, payout_line_id, payer_name, payer_email, payee_name, payee_email, amount_minor, currency, reference, purpose, issued_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (payout_line_id) do nothing`,
    [tenant.workspaceId, line.id, payer.name, payer.email, to.name, to.email, Math.abs(line.amountMinor), line.currency, settlementReference(line.id), purpose, now.toISOString()],
  );
  await q.query("update money_payout_lines set status = 'instructed', method = 'settlement_instruction' where id = $1 and status in ('approved', 'sending')", [line.id]);
  await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.instruction_issued", line.id, { amountMinor: line.amountMinor, currency: line.currency });
}

/** Emails instructions not yet sent. At-least-once: a crash after sending may repeat one email, never skip one. */
async function sendPendingInstructionEmails(db: Db, tenant: Tenant, deps: MoneyDeps) {
  const pending = await withTenant(db, tenant, async (q) => {
    const list = (await repo.listInstructions(q)).filter((i) => !i.emailedAt && i.status === "issued");
    return Promise.all(
      list.map(async (i) => {
        const line = (await repo.getLine(q, i.payoutLineId))!;
        // Remittance details belong to whoever receives the money.
        const payeeDetails = line.amountMinor > 0 ? await settlementDetails(q, tenant.workspaceId, line.recipientId) : null;
        return { i, payeeDetails };
      }),
    );
  });
  for (const { i, payeeDetails } of pending) {
    const text = settlementInstructionText({
      payer: { name: i.payerName, email: i.payerEmail },
      payee: { name: i.payeeName, email: i.payeeEmail },
      amountMinor: i.amountMinor,
      currency: i.currency,
      reference: i.reference,
      purpose: i.purpose,
      payeeDetails,
    });
    const link = `${deps.appUrl}/money/instructions/${i.id}`;
    if (i.payerEmail) await sendSystemMail(deps.mail, [i.payerEmail], `Payment to send: ${formatMoney(i)} to ${i.payeeName} (${i.reference})`, `${text}\n\nPrintable copy: ${link}`);
    if (i.payeeEmail) {
      await sendSystemMail(
        deps.mail,
        [i.payeeEmail],
        `Payment on its way: ${formatMoney(i)} from ${i.payerName} (${i.reference})`,
        `${i.payerName} has been instructed to send you ${formatMoney(i)} (${i.currency}) with reference ${i.reference}.\nFor: ${i.purpose}`,
      );
    }
    await withTenant(db, tenant, (q) => q.query("update money_settlement_instructions set emailed_at = now() where id = $1", [i.id]));
  }
}

/** The owner confirms money sent under an instruction has arrived. */
export function markInstructionSettled(db: Db, tenant: Tenant, instructionId: string, now: Date) {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, ["owner"], "confirm a settlement");
    const { rows } = await q.query<{ payout_line_id: string }>(
      "update money_settlement_instructions set status = 'settled', settled_at = $2, settled_by = $3 where id = $1 and status = 'issued' returning payout_line_id",
      [instructionId, now.toISOString(), tenant.memberId],
    );
    if (rows.length !== 1) throw new DomainError("invalid_transition", "This instruction is not open");
    const { rows: lines } = await q.query<{ batch_id: string | null }>(
      "update money_payout_lines set status = 'settled', settled_at = $2 where id = $1 returning batch_id",
      [rows[0]!.payout_line_id, now.toISOString()],
    );
    if (lines[0]?.batch_id) await maybeCompleteBatch(q, lines[0].batch_id, now);
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.instruction_settled", instructionId);
  });
}

/** Owner-initiated clawback of a transfer. The webhook (transfer.reversed) records the adjustment. */
export async function reverseTransfer(db: Db, tenant: Tenant, lineId: string, deps: MoneyDeps, amountMinor: number | null) {
  const line = await withTenant(db, tenant, async (q) => {
    await requireRole(q, ["owner"], "reverse a transfer");
    const l = await repo.getLine(q, lineId);
    if (!l?.stripeTransferId || l.status !== "settled") throw new DomainError("invalid_transition", "Only a settled transfer can be reversed");
    if (amountMinor != null && (amountMinor <= 0 || amountMinor > l.amountMinor - l.reversedMinor)) throw new DomainError("bad_amount", "Reversal amount is more than remains on the transfer");
    return l;
  });
  const stripe = deps.stripe;
  if (!stripe) throw new DomainError("stripe_unavailable", "Stripe is not configured");
  const reversal = await stripe.createTransferReversal(
    line.stripeTransferId!,
    { amountMinor: amountMinor ?? undefined, metadata: { workspace_id: tenant.workspaceId, payout_line_id: line.id } },
    `reverse-line-${line.id}-${line.reversedMinor}`,
  );
  await withTenant(db, tenant, (q) => repo.audit(q, tenant.workspaceId, tenant.memberId, "money.transfer_reversal_requested", line.id, { reversal: reversal.id, amountMinor: reversal.amount }));
  return reversal;
}

// ---------------------------------------------------------------------------
// Webhook-driven updates (app_system; workspace comes from the line itself)

/** transfer.created: confirms a transfer, and settles a line whose API reply we never saw. */
export async function applyTransferCreated(q: Queryable, t: StripeTransfer, now: Date): Promise<string | null> {
  const lineId = t.metadata?.payout_line_id;
  if (!lineId) return null;
  const { rows } = await q.query<{ id: string; workspace_id: string }>(
    `update money_payout_lines set stripe_transfer_id = $2, status = 'settled', settled_at = coalesce(settled_at, $3)
      where id = $1 and status in ('sending', 'settled') and (stripe_transfer_id is null or stripe_transfer_id = $2) returning id, workspace_id`,
    [lineId, t.id, now.toISOString()],
  );
  if (rows[0]) await repo.audit(q, rows[0].workspace_id, "system:stripe", "money.transfer_confirmed", lineId, { transfer: t.id });
  return rows[0]?.workspace_id ?? null;
}

/**
 * transfer.reversed: money came back from the payee's account. Updates the
 * line and records who bears the loss per the split terms. Idempotent on the
 * cumulative reversed amount.
 */
export async function applyTransferReversal(q: Queryable, t: StripeTransfer, now: Date): Promise<{ workspaceId: string; lineId: string; deltaMinor: number; bearer: string } | null> {
  const { rows } = await q.query<{ id: string; workspace_id: string; amount_minor: number; reversed_minor: number; currency: string; receivable_id: string | null; recipient_id: string; bearer: string | null }>(
    `select l.id, l.workspace_id, l.amount_minor, l.reversed_minor, l.currency, l.receivable_id, l.recipient_id, s.reversal_loss_bearer as bearer
       from money_payout_lines l left join money_splits s on s.id = l.split_id where l.stripe_transfer_id = $1`,
    [t.id],
  );
  const line = rows[0];
  if (!line) return null;
  const delta = t.amount_reversed - Number(line.reversed_minor);
  if (delta <= 0) return null;
  const bearer = line.bearer ?? "owner_workspace";
  const { rows: adj } = await q.query(
    `insert into money_adjustments (workspace_id, kind, receivable_id, payout_line_id, recipient_id, amount_minor, currency, borne_by, source_ref, note, at)
     values ($1, 'transfer_reversal', $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (workspace_id, source_ref) where source_ref is not null do nothing returning id`,
    [line.workspace_id, line.receivable_id, line.id, line.recipient_id, -delta, line.currency, bearer, `transfer_reversed:${t.id}:${t.amount_reversed}`, "Stripe transfer reversed", now.toISOString()],
  );
  if (!adj.length) return null;
  await q.query("update money_payout_lines set reversed_minor = $2, status = case when $2 >= amount_minor then 'reversed' else status end where id = $1", [line.id, t.amount_reversed]);
  await repo.audit(q, line.workspace_id, "system:stripe", "money.transfer_reversed", line.id, { transfer: t.id, deltaMinor: delta, bearer });
  return { workspaceId: line.workspace_id, lineId: line.id, deltaMinor: delta, bearer };
}

export async function notifyReversal(db: Db, deps: MoneyDeps, r: { workspaceId: string; lineId: string; deltaMinor: number; bearer: string }) {
  const { to, line } = await withSystem(db, async (q) => ({
    to: await ownerEmails(q, r.workspaceId),
    line: (await q.query<{ currency: string; name: string }>("select l.currency, rc.name from money_payout_lines l join money_recipients rc on rc.id = l.recipient_id where l.id = $1", [r.lineId])).rows[0]!,
  }));
  await sendSystemMail(
    deps.mail,
    to,
    `Transfer reversed: ${formatMoney({ amountMinor: r.deltaMinor, currency: line.currency })} from ${line.name}`,
    `A transfer to ${line.name} was reversed by ${formatMoney({ amountMinor: r.deltaMinor, currency: line.currency })}.\nPer the agreed terms, the loss is borne: ${r.bearer.replace("_", " ")}.\n\nOpen Money → Payouts to review the line and the adjustment.`,
  );
}
