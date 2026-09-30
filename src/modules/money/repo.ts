/**
 * Money repositories. Every function takes a Queryable already bound by
 * withTenant (or withSystem for webhook work), so row-level security decides
 * what each caller sees.
 */
import type { Queryable } from "@/db/client";
import type { Role } from "@/domain/common";
import type { LandedIn, LedgerEvent, LineStatus, LossBearer, SplitTerms } from "@/domain/money";

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const str = (v: unknown): string | null => (v == null ? null : String(v));

export async function memberRole(q: Queryable): Promise<Role | null> {
  const { rows } = await q.query<{ role: Role }>("select role from members where id = app_member() and workspace_id = app_workspace()");
  return rows[0]?.role ?? null;
}

// ---------------------------------------------------------------------------
// Receivables and receipt events

export interface ReceivableRow {
  id: string;
  itemId: string;
  tripId: string;
  tripTitle: string;
  tripOwnerId: string;
  itemTitle: string;
  itemState: string;
  supplierName: string | null;
  confirmationRef: string | null;
  commissionRecipient: string | null;
  hostAgency: string | null;
  basis: "rate" | "amount";
  rateBps: number | null;
  expectedMinor: number;
  currency: string;
  expectedBy: string | null;
}

const RECEIVABLE_SELECT = `
  select r.*, i.title as item_title, i.state as item_state, i.supplier_name, i.confirmation_ref, t.title as trip_title, t.owner_id as trip_owner_id
    from money_receivables r join trip_items i on i.id = r.item_id join trips t on t.id = r.trip_id`;

function mapReceivable(r: Record<string, unknown>): ReceivableRow {
  return {
    id: String(r.id),
    itemId: String(r.item_id),
    tripId: String(r.trip_id),
    tripTitle: String(r.trip_title),
    tripOwnerId: String(r.trip_owner_id),
    itemTitle: String(r.item_title),
    itemState: String(r.item_state),
    supplierName: str(r.supplier_name),
    confirmationRef: str(r.confirmation_ref),
    commissionRecipient: str(r.commission_recipient),
    hostAgency: str(r.host_agency),
    basis: r.basis as ReceivableRow["basis"],
    rateBps: r.rate_bps == null ? null : Number(r.rate_bps),
    expectedMinor: Number(r.expected_minor),
    currency: String(r.currency),
    expectedBy: day(r.expected_by),
  };
}

export async function listReceivables(q: Queryable): Promise<ReceivableRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(`${RECEIVABLE_SELECT} order by r.expected_by nulls last, t.title, i.position`);
  return rows.map(mapReceivable);
}

export async function getReceivable(q: Queryable, id: string): Promise<ReceivableRow | null> {
  const { rows } = await q.query<Record<string, unknown>>(`${RECEIVABLE_SELECT} where r.id = $1`, [id]);
  return rows[0] ? mapReceivable(rows[0]) : null;
}

export async function getReceivableByItem(q: Queryable, itemId: string): Promise<ReceivableRow | null> {
  const { rows } = await q.query<Record<string, unknown>>(`${RECEIVABLE_SELECT} where r.item_id = $1`, [itemId]);
  return rows[0] ? mapReceivable(rows[0]) : null;
}

function mapEvent(r: Record<string, unknown>): LedgerEvent {
  return {
    id: String(r.id),
    receivableId: String(r.receivable_id),
    kind: r.kind as LedgerEvent["kind"],
    amountMinor: Number(r.amount_minor),
    at: iso(r.at)!,
    note: str(r.note),
    originalCurrency: str(r.original_currency),
    originalAmountMinor: r.original_amount_minor == null ? null : Number(r.original_amount_minor),
    fxRate: r.fx_rate == null ? null : Number(r.fx_rate),
    landedIn: (r.landed_in as LandedIn | null) ?? null,
    source: r.source as LedgerEvent["source"],
  };
}

export async function listEvents(q: Queryable, receivableId?: string): Promise<LedgerEvent[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from money_receipt_events ${receivableId ? "where receivable_id = $1" : ""} order by at, created_at`,
    receivableId ? [receivableId] : [],
  );
  return rows.map(mapEvent);
}

export interface NewEvent {
  receivableId: string;
  kind: LedgerEvent["kind"];
  amountMinor: number;
  originalCurrency: string | null;
  originalAmountMinor: number | null;
  fxRate: number | null;
  landedIn: LandedIn | null;
  at: string;
  note: string | null;
  source: LedgerEvent["source"];
  sourceRef: string | null;
  createdBy: string | null;
}

/** Inserts a receipt event; returns null when an event with the same source ref already exists (idempotent re-delivery). */
export async function insertEvent(q: Queryable, workspaceId: string, e: NewEvent): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into money_receipt_events (workspace_id, receivable_id, kind, amount_minor, original_currency, original_amount_minor, fx_rate, landed_in, at, note, source, source_ref, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (workspace_id, source, source_ref) where source_ref is not null do nothing returning id`,
    [workspaceId, e.receivableId, e.kind, e.amountMinor, e.originalCurrency, e.originalAmountMinor, e.fxRate, e.landedIn, e.at, e.note, e.source, e.sourceRef, e.createdBy],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Recipients

export interface RecipientRow {
  id: string;
  kind: "workspace" | "member" | "external";
  memberId: string | null;
  name: string;
  email: string | null;
  stripeAccountId: string | null;
  onboardingStatus: "not_started" | "pending" | "restricted" | "enabled";
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  hasSettlementDetails: boolean;
  lastPayoutFailure: string | null;
}

function mapRecipient(r: Record<string, unknown>): RecipientRow {
  return {
    id: String(r.id),
    kind: r.kind as RecipientRow["kind"],
    memberId: str(r.member_id),
    name: String(r.name),
    email: str(r.email),
    stripeAccountId: str(r.stripe_account_id),
    onboardingStatus: r.onboarding_status as RecipientRow["onboardingStatus"],
    payoutsEnabled: Boolean(r.payouts_enabled),
    detailsSubmitted: Boolean(r.details_submitted),
    hasSettlementDetails: r.settlement_details_enc != null,
    lastPayoutFailure: str(r.last_payout_failure),
  };
}

export async function listRecipients(q: Queryable): Promise<RecipientRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from money_recipients order by (kind = 'workspace') desc, name");
  return rows.map(mapRecipient);
}

export async function getRecipient(q: Queryable, id: string): Promise<RecipientRow | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from money_recipients where id = $1", [id]);
  return rows[0] ? mapRecipient(rows[0]) : null;
}

export async function workspaceRecipientId(q: Queryable): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>("select id from money_recipients where kind = 'workspace' and workspace_id = app_workspace()");
  return rows[0]?.id ?? null;
}

/** The workspace's own payee row (its retained share). Created on first write. */
export async function ensureWorkspaceRecipient(q: Queryable, workspaceId: string): Promise<string> {
  const existing = await q.query<{ id: string }>("select id from money_recipients where kind = 'workspace' and workspace_id = $1", [workspaceId]);
  if (existing.rows[0]) return existing.rows[0].id;
  await q.query(
    `insert into money_recipients (workspace_id, kind, name) select id, 'workspace', name from workspaces where id = $1
     on conflict (workspace_id) where kind = 'workspace' do nothing`,
    [workspaceId],
  );
  const { rows } = await q.query<{ id: string }>("select id from money_recipients where kind = 'workspace' and workspace_id = $1", [workspaceId]);
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Splits

export interface SplitRow extends SplitTerms {
  tripId: string;
  collaborationRef: string | null;
  agreedBy: string | null;
  agreedAt: string | null;
}

export async function getSplitByItem(q: Queryable, itemId: string): Promise<SplitRow | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from money_splits where item_id = $1", [itemId]);
  return rows[0] ? loadSplit(q, rows[0]) : null;
}

export async function getSplit(q: Queryable, id: string): Promise<SplitRow | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from money_splits where id = $1", [id]);
  return rows[0] ? loadSplit(q, rows[0]) : null;
}

export async function listSplits(q: Queryable): Promise<SplitRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from money_splits order by created_at");
  return Promise.all(rows.map((r) => loadSplit(q, r)));
}

async function loadSplit(q: Queryable, r: Record<string, unknown>): Promise<SplitRow> {
  const id = String(r.id);
  const [shares, fees] = await Promise.all([
    q.query<{ recipient_id: string; bps: number }>("select recipient_id, bps from money_split_shares where split_id = $1 order by bps desc", [id]),
    q.query<{ id: string; recipient_id: string; kind: SplitTerms["fees"][number]["kind"]; amount_minor: number; currency: string }>(
      "select id, recipient_id, kind, amount_minor, currency from money_split_fees where split_id = $1 order by kind",
      [id],
    ),
  ]);
  return {
    id,
    itemId: String(r.item_id),
    tripId: String(r.trip_id),
    collaborationRef: str(r.collaboration_ref),
    status: r.status as SplitRow["status"],
    reversalLossBearer: r.reversal_loss_bearer as LossBearer,
    hostRulesOurs: r.host_rules_ours as SplitRow["hostRulesOurs"],
    hostRulesTheirs: r.host_rules_theirs as SplitRow["hostRulesTheirs"],
    agreedBy: str(r.agreed_by),
    agreedAt: iso(r.agreed_at),
    shares: shares.rows.map((s) => ({ recipientId: String(s.recipient_id), bps: Number(s.bps) })),
    fees: fees.rows.map((f) => ({ id: String(f.id), recipientId: String(f.recipient_id), kind: f.kind, amountMinor: Number(f.amount_minor), currency: String(f.currency) })),
  };
}

// ---------------------------------------------------------------------------
// Payout lines and batches

export type LineKind = "commission_share" | "commission_adjustment" | "advisory" | "design" | "referral" | "execution";

export interface PayoutLineRow {
  id: string;
  batchId: string | null;
  receivableId: string | null;
  splitId: string | null;
  feeId: string | null;
  recipientId: string;
  recipientName: string;
  kind: LineKind;
  amountMinor: number;
  currency: string;
  status: LineStatus;
  method: "platform_transfer" | "settlement_instruction" | null;
  stripeTransferId: string | null;
  reversedMinor: number;
  failure: string | null;
  itemTitle: string | null;
  tripTitle: string | null;
  createdAt: string;
  settledAt: string | null;
}

const LINE_SELECT = `
  select l.*, rc.name as recipient_name, coalesce(i1.title, i2.title) as item_title, coalesce(t1.title, t2.title) as trip_title
    from money_payout_lines l
    join money_recipients rc on rc.id = l.recipient_id
    left join money_receivables r on r.id = l.receivable_id
    left join trip_items i1 on i1.id = r.item_id
    left join trips t1 on t1.id = r.trip_id
    left join money_splits s on s.id = l.split_id
    left join trip_items i2 on i2.id = s.item_id
    left join trips t2 on t2.id = s.trip_id`;

function mapLine(r: Record<string, unknown>): PayoutLineRow {
  return {
    id: String(r.id),
    batchId: str(r.batch_id),
    receivableId: str(r.receivable_id),
    splitId: str(r.split_id),
    feeId: str(r.fee_id),
    recipientId: String(r.recipient_id),
    recipientName: String(r.recipient_name),
    kind: r.kind as LineKind,
    amountMinor: Number(r.amount_minor),
    currency: String(r.currency),
    status: r.status as LineStatus,
    method: (r.method as PayoutLineRow["method"]) ?? null,
    stripeTransferId: str(r.stripe_transfer_id),
    reversedMinor: Number(r.reversed_minor),
    failure: str(r.failure),
    itemTitle: str(r.item_title),
    tripTitle: str(r.trip_title),
    createdAt: iso(r.created_at)!,
    settledAt: iso(r.settled_at),
  };
}

export async function listLines(q: Queryable, filter: { batchId?: string; receivableId?: string; unbatchedPending?: boolean } = {}): Promise<PayoutLineRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) where.push(`l.batch_id = $${params.push(filter.batchId)}`);
  if (filter.receivableId) where.push(`l.receivable_id = $${params.push(filter.receivableId)}`);
  if (filter.unbatchedPending) where.push("l.batch_id is null and l.status = 'pending'");
  const { rows } = await q.query<Record<string, unknown>>(`${LINE_SELECT} ${where.length ? `where ${where.join(" and ")}` : ""} order by l.created_at, rc.name`, params);
  return rows.map(mapLine);
}

export async function getLine(q: Queryable, id: string): Promise<PayoutLineRow | null> {
  const { rows } = await q.query<Record<string, unknown>>(`${LINE_SELECT} where l.id = $1`, [id]);
  return rows[0] ? mapLine(rows[0]) : null;
}

export interface BatchRow {
  id: string;
  currency: string;
  status: "draft" | "approved" | "processing" | "completed" | "canceled";
  preparedBy: string;
  preparedByName: string;
  preparedAt: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  completedAt: string | null;
  lineCount: number;
  totalMinor: number;
}

export async function listBatches(q: Queryable, id?: string): Promise<BatchRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select b.*, mp.name as prepared_by_name, ma.name as approved_by_name,
            (select count(*) from money_payout_lines l where l.batch_id = b.id) as line_count,
            (select coalesce(sum(amount_minor), 0) from money_payout_lines l where l.batch_id = b.id) as total_minor
       from money_payout_batches b join members mp on mp.id = b.prepared_by left join members ma on ma.id = b.approved_by
      ${id ? "where b.id = $1" : ""} order by b.prepared_at desc`,
    id ? [id] : [],
  );
  return rows.map((r) => ({
    id: String(r.id),
    currency: String(r.currency),
    status: r.status as BatchRow["status"],
    preparedBy: String(r.prepared_by),
    preparedByName: String(r.prepared_by_name),
    preparedAt: iso(r.prepared_at)!,
    approvedBy: str(r.approved_by),
    approvedByName: str(r.approved_by_name),
    approvedAt: iso(r.approved_at),
    completedAt: iso(r.completed_at),
    lineCount: Number(r.line_count),
    totalMinor: Number(r.total_minor),
  }));
}

// ---------------------------------------------------------------------------
// Settlement instructions

export interface InstructionRow {
  id: string;
  payoutLineId: string;
  payerName: string;
  payerEmail: string | null;
  payeeName: string;
  payeeEmail: string | null;
  amountMinor: number;
  currency: string;
  reference: string;
  purpose: string;
  status: "issued" | "settled" | "canceled";
  issuedAt: string;
  emailedAt: string | null;
  settledAt: string | null;
}

function mapInstruction(r: Record<string, unknown>): InstructionRow {
  return {
    id: String(r.id),
    payoutLineId: String(r.payout_line_id),
    payerName: String(r.payer_name),
    payerEmail: str(r.payer_email),
    payeeName: String(r.payee_name),
    payeeEmail: str(r.payee_email),
    amountMinor: Number(r.amount_minor),
    currency: String(r.currency),
    reference: String(r.reference),
    purpose: String(r.purpose),
    status: r.status as InstructionRow["status"],
    issuedAt: iso(r.issued_at)!,
    emailedAt: iso(r.emailed_at),
    settledAt: iso(r.settled_at),
  };
}

export async function listInstructions(q: Queryable, filter: { id?: string; lineId?: string } = {}): Promise<InstructionRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.id) where.push(`id = $${params.push(filter.id)}`);
  if (filter.lineId) where.push(`payout_line_id = $${params.push(filter.lineId)}`);
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from money_settlement_instructions ${where.length ? `where ${where.join(" and ")}` : ""} order by issued_at desc`,
    params,
  );
  return rows.map(mapInstruction);
}

// ---------------------------------------------------------------------------
// Statements

export interface StatementImportRow {
  id: string;
  fileName: string;
  hostAgency: string | null;
  rowCount: number;
  matchedCount: number;
  importedAt: string;
  importedByName: string;
  openCount: number;
}

export async function listImports(q: Queryable, id?: string): Promise<StatementImportRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select s.*, m.name as imported_by_name,
            (select count(*) from money_statement_rows r where r.import_id = s.id and r.status = 'unmatched') as open_count
       from money_statement_imports s join members m on m.id = s.imported_by ${id ? "where s.id = $1" : ""} order by s.imported_at desc`,
    id ? [id] : [],
  );
  return rows.map((r) => ({
    id: String(r.id),
    fileName: String(r.file_name),
    hostAgency: str(r.host_agency),
    rowCount: Number(r.row_count),
    matchedCount: Number(r.matched_count),
    importedAt: iso(r.imported_at)!,
    importedByName: String(r.imported_by_name),
    openCount: Number(r.open_count),
  }));
}

export interface StatementLineRow {
  id: string;
  rowNo: number;
  confirmationRef: string | null;
  supplier: string | null;
  guest: string | null;
  amountMinor: number;
  deductionMinor: number;
  currency: string;
  status: "matched" | "unmatched" | "manual" | "ignored";
  reason: string | null;
  receivableId: string | null;
}

export async function listStatementRows(q: Queryable, importId: string): Promise<StatementLineRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from money_statement_rows where import_id = $1 order by row_no", [importId]);
  return rows.map((r) => ({
    id: String(r.id),
    rowNo: Number(r.row_no),
    confirmationRef: str(r.confirmation_ref),
    supplier: str(r.supplier),
    guest: str(r.guest),
    amountMinor: Number(r.amount_minor),
    deductionMinor: Number(r.deduction_minor),
    currency: String(r.currency),
    status: r.status as StatementLineRow["status"],
    reason: str(r.reason),
    receivableId: str(r.receivable_id),
  }));
}

// ---------------------------------------------------------------------------
// Card vault

export interface PaymentMethodRow {
  id: string;
  clientId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  stripePaymentMethodId: string;
  createdAt: string;
}

export async function listPaymentMethods(q: Queryable, clientId: string): Promise<PaymentMethodRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    "select * from money_payment_methods where client_id = $1 and removed_at is null order by created_at desc",
    [clientId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    clientId: String(r.client_id),
    brand: String(r.brand),
    last4: String(r.last4),
    expMonth: Number(r.exp_month),
    expYear: Number(r.exp_year),
    stripePaymentMethodId: String(r.stripe_payment_method_id),
    createdAt: iso(r.created_at)!,
  }));
}

export async function audit(q: Queryable, workspaceId: string, actor: string, action: string, subject: string, data: unknown = {}): Promise<void> {
  await q.query("insert into audit_events (workspace_id, actor, action, subject, data) values ($1,$2,$3,$4,$5)", [
    workspaceId,
    actor,
    action,
    subject,
    JSON.stringify(data),
  ]);
}
