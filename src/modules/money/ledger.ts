/**
 * Receivables ledger operations: commission terms on booking lines, receipt
 * events (adjustments land here, before any split), host-agency statement
 * import with matching, and re-allocation when a net changes after it was
 * allocated.
 */
import type { Db, Queryable } from "@/db/client";
import { withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import {
  allocatable,
  allocateNet,
  convertFx,
  matchStatementRows,
  openHoldMinor,
  parseCommissionStatement,
  reallocationDelta,
  receivableState,
  validateReceiptEvent,
  type LandedIn,
  type ReceiptKind,
} from "@/domain/money";
import { sha256 } from "@/server/crypto";
import { requireRole, WRITERS } from "./deps";
import * as repo from "./repo";

// ---------------------------------------------------------------------------
// Commission terms

export interface CommissionTermsInput {
  itemId: string;
  rateBps: number | null;
  amountMinor: number | null;
  expectedBy: string | null;
  hostAgency: string | null;
}

/**
 * Captures commission terms on a booking line. If the item is already
 * confirmed the trigger creates its receivable now; if a receivable exists and
 * nothing has been received or allocated, its expectation follows the terms.
 */
export function setCommissionTerms(db: Db, tenant: Tenant, input: CommissionTermsInput) {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "change commission terms");
    if (input.rateBps == null && input.amountMinor == null) throw new DomainError("bad_terms", "Give a commission rate or a fixed commission amount");
    if (input.rateBps != null && (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10_000)) {
      throw new DomainError("bad_terms", "Commission rate must be between 0% and 100%");
    }
    if (input.amountMinor != null && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0)) throw new DomainError("bad_terms", "Commission amount must be positive");
    const { rows } = await q.query<{ price_minor: number | null; currency: string | null }>(
      `update trip_items set commission_rate_bps = $2, commission_amount_minor = $3, commission_expected_by = $4, commission_host_agency = $5
        where id = $1 returning price_minor, currency`,
      [input.itemId, input.rateBps, input.amountMinor, input.expectedBy, input.hostAgency],
    );
    const item = rows[0];
    if (!item) throw new DomainError("not_found", "Booking line not found");
    if (input.amountMinor == null && item.price_minor == null) throw new DomainError("bad_terms", "This line has no price, so give a fixed commission amount");

    const r = await repo.getReceivableByItem(q, input.itemId);
    if (r) {
      const [events, lines] = await Promise.all([repo.listEvents(q, r.id), repo.listLines(q, { receivableId: r.id })]);
      if (events.length === 0 && lines.length === 0) {
        const expected = input.amountMinor ?? Math.round((Number(item.price_minor) * input.rateBps!) / 10_000);
        await q.query(
          `update money_receivables set basis = $2, rate_bps = $3, expected_minor = $4, host_agency = coalesce($5, host_agency),
                  expected_by = coalesce($6::date, expected_by) where id = $1`,
          [r.id, input.amountMinor != null ? "amount" : "rate", input.rateBps, expected, input.hostAgency, input.expectedBy],
        );
      }
    }
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.commission_terms", input.itemId, input);
    return repo.getReceivableByItem(q, input.itemId);
  });
}

// ---------------------------------------------------------------------------
// Receipt events

export interface ReceiptInput {
  receivableId: string;
  kind: ReceiptKind;
  /** Signed, in minor units of `currency`. */
  amountMinor: number;
  currency: string;
  /** Required when `currency` differs from the receivable's: units of the receivable's currency per unit of `currency`. */
  fxRate: number | null;
  landedIn: LandedIn | null;
  at: string;
  note: string | null;
}

export async function recordReceiptTx(q: Queryable, tenant: Tenant, input: ReceiptInput, now: Date, source: { source: "manual" | "statement" | "stripe"; ref: string | null } = { source: "manual", ref: null }) {
  const r = await repo.getReceivable(q, input.receivableId);
  if (!r) throw new DomainError("not_found", "Receivable not found");
  const currency = input.currency.toUpperCase();
  let amountMinor = input.amountMinor;
  let original: { currency: string; amountMinor: number; rate: number } | null = null;
  if (currency !== r.currency) {
    if (input.fxRate == null) throw new DomainError("fx_details_required", `Paid in ${currency} against a ${r.currency} receivable: give the rate applied`);
    amountMinor = convertFx(input.amountMinor, currency, input.fxRate, r.currency);
    original = { currency, amountMinor: input.amountMinor, rate: input.fxRate };
  }
  validateReceiptEvent({
    kind: input.kind,
    amountMinor,
    landedIn: input.kind === "received" ? input.landedIn : null,
    originalCurrency: original?.currency ?? null,
    originalAmountMinor: original?.amountMinor ?? null,
    fxRate: original?.rate ?? null,
  });
  const events = await repo.listEvents(q, r.id);
  if (input.kind === "dispute_hold" && amountMinor > 0 && openHoldMinor(events) + amountMinor > 0) {
    throw new DomainError("bad_release", "That releases more than is held");
  }
  const before = receivableState(r, events, now);
  if (before.net + amountMinor < 0 && input.kind !== "dispute_hold") {
    throw new DomainError("negative_net", "That would take the net for this receivable below zero");
  }
  const id = await repo.insertEvent(q, tenant.workspaceId, {
    receivableId: r.id,
    kind: input.kind,
    amountMinor,
    originalCurrency: original?.currency ?? null,
    originalAmountMinor: original?.amountMinor ?? null,
    fxRate: original?.rate ?? null,
    landedIn: input.kind === "received" ? input.landedIn : null,
    at: input.at,
    note: input.note,
    source: source.source,
    sourceRef: source.ref,
    createdBy: tenant.memberId,
  });
  if (!id) return null; // already recorded from this source
  await repo.audit(q, tenant.workspaceId, tenant.memberId, `money.receipt.${input.kind}`, r.id, { amountMinor, currency: r.currency, original, source: source.source });
  await reallocate(q, tenant, r.id, now);
  return id;
}

export function recordReceipt(db: Db, tenant: Tenant, input: ReceiptInput, now: Date) {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "record money received or adjusted");
    await recordReceiptTx(q, tenant, input, now);
    const r = (await repo.getReceivable(q, input.receivableId))!;
    return receivableState(r, await repo.listEvents(q, r.id), now);
  });
}

// ---------------------------------------------------------------------------
// Allocation

/**
 * First allocation of a receivable's verified net across its agreed split.
 * Idempotent: a receivable is allocated once (unique per recipient); later
 * changes to the net go through reallocate().
 */
export async function allocateReceivable(q: Queryable, tenant: Tenant, receivableId: string, now: Date): Promise<number> {
  const r = await repo.getReceivable(q, receivableId);
  if (!r) return 0;
  const split = await repo.getSplitByItem(q, r.itemId);
  if (!split || split.status !== "agreed") return 0;
  const existing = (await repo.listLines(q, { receivableId })).filter((l) => l.kind === "commission_share");
  if (existing.length > 0) return 0;
  const state = receivableState(r, await repo.listEvents(q, r.id), now);
  if (!allocatable(state)) return 0;
  const wsRecipient = await repo.ensureWorkspaceRecipient(q, tenant.workspaceId);
  let n = 0;
  for (const a of allocateNet(state.net, split.shares)) {
    if (a.amountMinor === 0) continue;
    const { rows } = await q.query(
      `insert into money_payout_lines (workspace_id, receivable_id, split_id, recipient_id, kind, amount_minor, currency, status)
       values ($1,$2,$3,$4,'commission_share',$5,$6,$7) on conflict (receivable_id, recipient_id) where kind = 'commission_share' do nothing returning id`,
      [tenant.workspaceId, r.id, split.id, a.recipientId, a.amountMinor, r.currency, a.recipientId === wsRecipient ? "retained" : "pending"],
    );
    n += rows.length;
  }
  if (n) await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.allocated", r.id, { netMinor: state.net, currency: r.currency, splitId: split.id });
  return n;
}

/**
 * Re-allocates the difference when a receivable's net changes after it was
 * allocated. Unpaid lines are adjusted in place; paid ones get adjustment
 * lines (negative = owed back), per the terms' loss bearer.
 */
export async function reallocate(q: Queryable, tenant: Tenant, receivableId: string, now: Date): Promise<void> {
  const r = await repo.getReceivable(q, receivableId);
  if (!r) return;
  const split = await repo.getSplitByItem(q, r.itemId);
  if (!split || split.status !== "agreed") return;
  const lines = (await repo.listLines(q, { receivableId })).filter(
    (l) => (l.kind === "commission_share" || l.kind === "commission_adjustment") && l.status !== "canceled" && l.status !== "failed",
  );
  if (lines.length === 0) return;
  const state = receivableState(r, await repo.listEvents(q, r.id), now);
  if (state.status === "disputed") return; // wait until the dispute resolves
  const wsRecipient = await repo.ensureWorkspaceRecipient(q, tenant.workspaceId);
  const allocated = new Map<string, number>();
  // What each payee was allocated from this receivable. Transfer reversals are a payment problem, not a change
  // in allocation, so they are tracked on the line and in money_adjustments, not netted here.
  for (const l of lines) allocated.set(l.recipientId, (allocated.get(l.recipientId) ?? 0) + l.amountMinor);
  const deltas = reallocationDelta(allocated, state.net, split, wsRecipient);
  if (deltas.length === 0) return;
  for (const d of deltas) {
    const open = lines.find((l) => l.recipientId === d.recipientId && l.batchId === null && (l.status === "pending" || l.status === "retained"));
    if (open && open.amountMinor + d.amountMinor >= 0) {
      await q.query("update money_payout_lines set amount_minor = amount_minor + $2 where id = $1", [open.id, d.amountMinor]);
    } else {
      await q.query(
        `insert into money_payout_lines (workspace_id, receivable_id, split_id, recipient_id, kind, amount_minor, currency, status)
         values ($1,$2,$3,$4,'commission_adjustment',$5,$6,$7)`,
        [tenant.workspaceId, r.id, split.id, d.recipientId, d.amountMinor, r.currency, d.recipientId === wsRecipient ? "retained" : "pending"],
      );
    }
  }
  const diff = deltas.reduce((s, d) => s + d.amountMinor, 0);
  await q.query(
    `insert into money_adjustments (workspace_id, kind, receivable_id, amount_minor, currency, borne_by, note, at)
     values ($1, 'commission_reallocation', $2, $3, $4, $5, $6, $7)`,
    [tenant.workspaceId, r.id, diff, r.currency, diff < 0 ? split.reversalLossBearer : "pro_rata", `Net changed to ${state.net} after allocation`, now.toISOString()],
  );
  await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.reallocated", r.id, { deltas, bearer: split.reversalLossBearer });
}

// ---------------------------------------------------------------------------
// Host-agency statements

export interface StatementImportResult {
  importId: string;
  duplicate: boolean;
  matched: number;
  unmatched: number;
  errors: { rowNo: number; message: string }[];
}

/**
 * Imports a host-agency commission statement. The file hash makes re-import a
 * no-op. Rows matched by confirmation number become receipts (and host
 * deductions); everything else waits for a person to match or ignore it.
 */
export function importStatement(
  db: Db,
  tenant: Tenant,
  input: { fileName: string; content: string; defaultCurrency: string | null; hostAgency: string | null },
  now: Date,
): Promise<StatementImportResult> {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "import commission statements");
    const fileHash = sha256(input.content);
    const { rows: prior } = await q.query<{ id: string; matched_count: number; row_count: number }>(
      "select id, matched_count, row_count from money_statement_imports where file_hash = $1",
      [fileHash],
    );
    if (prior[0]) {
      return { importId: prior[0].id, duplicate: true, matched: Number(prior[0].matched_count), unmatched: Number(prior[0].row_count) - Number(prior[0].matched_count), errors: [] };
    }
    const parsed = parseCommissionStatement(input.content, input.defaultCurrency);
    if (parsed.rows.length === 0 && parsed.errors.length === 0) throw new DomainError("empty_statement", "The statement has no rows");

    const receivables = await repo.listReceivables(q);
    const matches = matchStatementRows(
      parsed.rows,
      receivables.map((r) => ({ receivableId: r.id, confirmationRef: r.confirmationRef, currency: r.currency })),
    );
    const matchedCount = matches.filter((m) => m.status === "matched").length;
    const { rows: ins } = await q.query<{ id: string }>(
      `insert into money_statement_imports (workspace_id, file_name, file_hash, host_agency, row_count, matched_count, imported_by, imported_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [tenant.workspaceId, input.fileName.slice(0, 200), fileHash, input.hostAgency, parsed.rows.length + parsed.errors.length, matchedCount, tenant.memberId, now.toISOString()],
    );
    const importId = ins[0]!.id;

    for (const [i, row] of parsed.rows.entries()) {
      const m = matches[i]!;
      await q.query(
        `insert into money_statement_rows (workspace_id, import_id, row_no, confirmation_ref, supplier, guest, amount_minor, deduction_minor, currency, status, reason, receivable_id, matched_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          tenant.workspaceId, importId, row.rowNo, row.confirmationRef, row.supplier, row.guest, row.amountMinor, row.deductionMinor, row.currency,
          m.status, m.status === "unmatched" ? m.reason : null, m.status === "matched" ? m.receivableId : null, null,
        ],
      );
      if (m.status === "matched") await applyStatementRow(q, tenant, importId, row, m.receivableId, input.hostAgency, now);
    }
    for (const e of parsed.errors) {
      await q.query(
        `insert into money_statement_rows (workspace_id, import_id, row_no, amount_minor, currency, status, reason)
         values ($1,$2,$3,0,'',  'ignored', $4)`,
        [tenant.workspaceId, importId, e.rowNo, `Could not read this row: ${e.message}`],
      );
    }
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.statement_imported", importId, {
      fileName: input.fileName,
      rows: parsed.rows.length,
      matched: matchedCount,
      errors: parsed.errors.length,
    });
    return { importId, duplicate: false, matched: matchedCount, unmatched: parsed.rows.length - matchedCount, errors: parsed.errors };
  });
}

async function applyStatementRow(
  q: Queryable,
  tenant: Tenant,
  importId: string,
  row: { rowNo: number; amountMinor: number; deductionMinor: number; currency: string },
  receivableId: string,
  hostAgency: string | null,
  now: Date,
) {
  const note = `Host statement${hostAgency ? ` (${hostAgency})` : ""}, row ${row.rowNo}`;
  // Host agencies pay commission into the advisor's own account, never the platform balance.
  await recordReceiptTx(
    q,
    tenant,
    { receivableId, kind: "received", amountMinor: row.amountMinor, currency: row.currency, fxRate: null, landedIn: "external_account", at: now.toISOString(), note },
    now,
    { source: "statement", ref: `${importId}:${row.rowNo}` },
  );
  if (row.deductionMinor < 0) {
    await recordReceiptTx(
      q,
      tenant,
      { receivableId, kind: "host_deduction", amountMinor: row.deductionMinor, currency: row.currency, fxRate: null, landedIn: null, at: now.toISOString(), note },
      now,
      { source: "statement", ref: `${importId}:${row.rowNo}:deduction` },
    );
  }
}

/** A person matches a row the importer couldn't. */
export function matchStatementRow(db: Db, tenant: Tenant, input: { rowId: string; receivableId: string }, now: Date) {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "match statement rows");
    const { rows } = await q.query<Record<string, unknown>>("select r.*, i.host_agency from money_statement_rows r join money_statement_imports i on i.id = r.import_id where r.id = $1", [input.rowId]);
    const row = rows[0];
    if (!row) throw new DomainError("not_found", "Statement row not found");
    if (row.status !== "unmatched") throw new DomainError("already_matched", "This row has already been dealt with");
    const r = await repo.getReceivable(q, input.receivableId);
    if (!r) throw new DomainError("not_found", "Receivable not found");
    if (String(row.currency) !== r.currency) throw new DomainError("currency_mismatch", `This row is in ${String(row.currency)}; record it on the receivable with the FX rate instead`);
    const { rows: upd } = await q.query(
      "update money_statement_rows set status = 'manual', receivable_id = $2, matched_by = $3, reason = null where id = $1 and status = 'unmatched' returning id",
      [input.rowId, r.id, tenant.memberId],
    );
    if (upd.length !== 1) throw new DomainError("already_matched", "This row has already been dealt with");
    await applyStatementRow(
      q,
      tenant,
      String(row.import_id),
      { rowNo: Number(row.row_no), amountMinor: Number(row.amount_minor), deductionMinor: Number(row.deduction_minor), currency: String(row.currency) },
      r.id,
      (row.host_agency as string | null) ?? null,
      now,
    );
    await q.query("update money_statement_imports set matched_count = matched_count + 1 where id = $1", [row.import_id]);
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.statement_row_matched", input.rowId, { receivableId: r.id });
  });
}

export function ignoreStatementRow(db: Db, tenant: Tenant, rowId: string, reason: string) {
  return withTenant(db, tenant, async (q) => {
    await requireRole(q, WRITERS, "change statement rows");
    const { rows } = await q.query("update money_statement_rows set status = 'ignored', reason = $2 where id = $1 and status = 'unmatched' returning id", [rowId, reason || "Ignored"]);
    if (rows.length !== 1) throw new DomainError("not_found", "No unmatched row to ignore");
    await repo.audit(q, tenant.workspaceId, tenant.memberId, "money.statement_row_ignored", rowId, { reason });
  });
}
