/**
 * Money rules beyond the core ledger (src/domain/ledger.ts): receipt-event
 * validation and FX, commission-statement parsing and matching, allocation of
 * a verified net across agreed split terms (and re-allocation when the net
 * later changes), the payout method per line, the owner gate on payout
 * batches, settlement-instruction wording and the reconciliation and
 * reputation reports. Pure: no I/O, callers pass `now`.
 */
import { DomainError, formatMoney, type Id, type Role } from "./common";
import { allocate, payoutMethod, receivableStatus, type PayoutMethod, type ReceiptAdjustmentKind, type Receivable, type ReceiptEvent } from "./ledger";

// ---------------------------------------------------------------------------
// Currency

/** Minor-unit exponent for an ISO 4217 code (USD 2, JPY 0, BHD 3). */
export function currencyExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new DomainError("bad_currency", `Not a currency code: ${currency}`);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new DomainError("bad_currency", `Unknown currency: ${currency}`);
  }
}

/**
 * Parses a human amount ("1,234.56", "(12.00)", "-12", "USD 40") into integer
 * minor units. Rejects more decimals than the currency has.
 */
export function parseAmountMinor(text: string, currency: string): number {
  const exp = currencyExponent(currency);
  let s = text.trim().replace(/[A-Za-z$€£¥\s]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  s = s.replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new DomainError("bad_amount", `Not an amount: "${text}"`);
  const frac = m[2] ?? "";
  if (frac.length > exp) throw new DomainError("bad_amount", `Too many decimals for ${currency}: "${text}"`);
  const minor = Number(m[1]) * 10 ** exp + Number(frac.padEnd(exp, "0") || "0");
  if (!Number.isSafeInteger(minor)) throw new DomainError("bad_amount", `Amount out of range: "${text}"`);
  return negative ? -minor : minor;
}

/**
 * Converts an amount received in another currency into the receivable's
 * currency at the rate actually applied (units of target per unit of source),
 * rounding half away from zero to the target's minor unit.
 */
export function convertFx(originalMinor: number, originalCurrency: string, rate: number, targetCurrency: string): number {
  if (!(rate > 0) || !Number.isFinite(rate)) throw new DomainError("bad_rate", "FX rate must be a positive number");
  const major = originalMinor / 10 ** currencyExponent(originalCurrency);
  const target = major * rate * 10 ** currencyExponent(targetCurrency);
  return Math.sign(target) * Math.round(Math.abs(target) + 1e-9);
}

// ---------------------------------------------------------------------------
// Receipt events

export type ReceiptKind = ReceiptEvent["kind"];
export type LandedIn = "platform_balance" | "external_account";

export interface LedgerEvent extends ReceiptEvent {
  id: Id;
  originalCurrency: string | null;
  originalAmountMinor: number | null;
  fxRate: number | null;
  landedIn: LandedIn | null;
  source: "manual" | "statement" | "stripe";
}

const NEGATIVE_KINDS: readonly ReceiptAdjustmentKind[] = ["host_deduction", "short_payment", "reversal"];

/**
 * Sign and shape rules for a receipt event. Adjustments are recorded against
 * the receivable, so they reduce the net before any split is computed.
 * A dispute hold is negative; a positive dispute_hold releases a hold.
 */
export function validateReceiptEvent(e: {
  kind: ReceiptKind;
  amountMinor: number;
  landedIn: LandedIn | null;
  originalCurrency: string | null;
  originalAmountMinor: number | null;
  fxRate: number | null;
}): void {
  if (!Number.isSafeInteger(e.amountMinor) || e.amountMinor === 0) throw new DomainError("bad_amount", "Amount must be a non-zero whole number of minor units");
  if (e.kind === "received") {
    if (e.amountMinor <= 0) throw new DomainError("bad_amount", "A receipt must be positive");
    if (!e.landedIn) throw new DomainError("landed_in_required", "Say where the money landed: the platform balance or an external account");
  }
  if (NEGATIVE_KINDS.includes(e.kind as ReceiptAdjustmentKind) && e.amountMinor >= 0) {
    throw new DomainError("bad_amount", `A ${e.kind.replace("_", " ")} reduces the amount and must be negative`);
  }
  if (e.kind === "fx" && (!e.originalCurrency || e.originalAmountMinor == null || e.fxRate == null)) {
    throw new DomainError("fx_details_required", "An FX adjustment needs the original currency, amount and rate");
  }
}

/** Sum of dispute holds still in force (negative while held; released holds net to zero). */
export const openHoldMinor = (events: readonly ReceiptEvent[]): number =>
  events.filter((e) => e.kind === "dispute_hold").reduce((s, e) => s + e.amountMinor, 0);

export type ReceivableStatus = ReturnType<typeof receivableStatus>["status"];

/**
 * Ledger status for one receivable. Wraps receivableStatus so that released
 * dispute holds (a hold plus its release) no longer mark it disputed.
 */
export function receivableState(r: Receivable, events: readonly ReceiptEvent[], now: Date) {
  const mine = events.filter((e) => e.receivableId === r.id);
  const held = openHoldMinor(mine) < 0;
  const effective = held ? mine : mine.filter((e) => e.kind !== "dispute_hold");
  const s = receivableStatus(r, effective, now);
  const firstReceivedAt = mine.filter((e) => e.kind === "received").map((e) => e.at).sort()[0] ?? null;
  return { ...s, firstReceivedAt };
}

/** A receivable's verified net may be allocated once money arrived and nothing is disputed. */
export function allocatable(state: { status: ReceivableStatus; received: number; net: number }): boolean {
  return state.received > 0 && state.net > 0 && (state.status === "settled" || state.status === "short");
}

// ---------------------------------------------------------------------------
// Commission statements

export interface StatementRow {
  rowNo: number;
  confirmationRef: string | null;
  supplier: string | null;
  guest: string | null;
  amountMinor: number;
  deductionMinor: number;
  currency: string;
}

export interface StatementParse {
  rows: StatementRow[];
  errors: { rowNo: number; message: string }[];
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, commas inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) out.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) out.push(row);
  return out;
}

const HEADER_ALIASES: Record<"confirmation" | "supplier" | "guest" | "amount" | "currency" | "deduction", string[]> = {
  confirmation: ["confirmation", "confirmationnumber", "confirmationno", "confno", "conf", "confirmationref", "bookingref", "bookingreference", "reference", "ref", "pnr"],
  supplier: ["supplier", "vendor", "property", "hotel", "suppliername"],
  guest: ["guest", "guestname", "client", "clientname", "traveler", "traveller", "passenger", "leadguest"],
  amount: ["amount", "commission", "commissionamount", "amountpaid", "paid", "netcommission", "commissionpaid"],
  currency: ["currency", "ccy", "cur", "currencycode"],
  deduction: ["deduction", "hostfee", "hostdeduction", "agencyfee", "hostagencyfee", "fee"],
};

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Parses a host-agency commission statement. Column names vary by host, so
 * headers are matched by alias. Confirmation and amount are required; currency
 * falls back to `defaultCurrency`. An optional deduction column records the
 * host's fee as a separate adjustment (positive or negative in the file; it is
 * always stored as a reduction).
 */
export function parseCommissionStatement(text: string, defaultCurrency: string | null = null): StatementParse {
  const table = parseCsv(text);
  if (table.length === 0) throw new DomainError("empty_statement", "The statement is empty");
  const header = table[0]!.map(normHeader);
  const col = (k: keyof typeof HEADER_ALIASES) => header.findIndex((h) => HEADER_ALIASES[k].includes(h));
  const idx = { confirmation: col("confirmation"), supplier: col("supplier"), guest: col("guest"), amount: col("amount"), currency: col("currency"), deduction: col("deduction") };
  if (idx.confirmation < 0 || idx.amount < 0) {
    throw new DomainError("bad_statement", "The statement needs a confirmation-number column and an amount column");
  }
  if (idx.currency < 0 && !defaultCurrency) throw new DomainError("bad_statement", "The statement has no currency column; choose a default currency");
  const rows: StatementRow[] = [];
  const errors: StatementParse["errors"] = [];
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  table.slice(1).forEach((r, n) => {
    const rowNo = n + 2; // 1-based, counting the header, as a spreadsheet shows it
    try {
      const currency = (cell(r, idx.currency) || defaultCurrency || "").toUpperCase();
      currencyExponent(currency);
      const amountMinor = parseAmountMinor(cell(r, idx.amount), currency);
      const d = cell(r, idx.deduction);
      const deductionMinor = d ? -Math.abs(parseAmountMinor(d, currency)) : 0;
      rows.push({
        rowNo,
        confirmationRef: cell(r, idx.confirmation) || null,
        supplier: cell(r, idx.supplier) || null,
        guest: cell(r, idx.guest) || null,
        amountMinor,
        deductionMinor,
        currency,
      });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      errors.push({ rowNo, message: err.message });
    }
  });
  return { rows, errors };
}

/** Confirmation numbers are compared ignoring case, spaces and punctuation ("ca-55812" = "CA 55812"). */
export const normalizeRef = (ref: string | null | undefined): string => (ref ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface MatchCandidate {
  receivableId: Id;
  confirmationRef: string | null;
  currency: string;
}

export type RowMatch = { rowNo: number; status: "matched"; receivableId: Id } | { rowNo: number; status: "unmatched"; reason: string };

/** Matches statement rows to receivables by confirmation number. Anything uncertain is left for a person. */
export function matchStatementRows(rows: readonly StatementRow[], candidates: readonly MatchCandidate[]): RowMatch[] {
  const byRef = new Map<string, MatchCandidate[]>();
  for (const c of candidates) {
    const k = normalizeRef(c.confirmationRef);
    if (!k) continue;
    byRef.set(k, [...(byRef.get(k) ?? []), c]);
  }
  return rows.map((row): RowMatch => {
    const k = normalizeRef(row.confirmationRef);
    if (!k) return { rowNo: row.rowNo, status: "unmatched", reason: "No confirmation number" };
    const found = byRef.get(k) ?? [];
    if (found.length === 0) return { rowNo: row.rowNo, status: "unmatched", reason: "No receivable with this confirmation number" };
    if (found.length > 1) return { rowNo: row.rowNo, status: "unmatched", reason: "More than one receivable has this confirmation number" };
    const c = found[0]!;
    if (c.currency.toUpperCase() !== row.currency) {
      return { rowNo: row.rowNo, status: "unmatched", reason: `Paid in ${row.currency}, expected ${c.currency}: record with the FX rate` };
    }
    if (row.amountMinor <= 0) return { rowNo: row.rowNo, status: "unmatched", reason: "Non-positive amount: record as an adjustment by hand" };
    return { rowNo: row.rowNo, status: "matched", receivableId: c.receivableId };
  });
}

// ---------------------------------------------------------------------------
// Split terms and allocation

export type FeeKind = "advisory" | "design" | "referral" | "execution";
export type LossBearer = "pro_rata" | "owner_workspace";

export interface SplitTerms {
  id: Id;
  itemId: Id;
  status: "draft" | "agreed";
  reversalLossBearer: LossBearer;
  hostRulesOurs: "unknown" | "permitted" | "not_permitted";
  hostRulesTheirs: "unknown" | "permitted" | "not_permitted";
  /** Commission shares by recipient; must total 10000 bps. */
  shares: { recipientId: Id; bps: number }[];
  /** Fixed fees: separate payable lines, not carved out of commission. */
  fees: { id: Id; recipientId: Id; kind: FeeKind; amountMinor: number; currency: string }[];
}

/**
 * Terms can be agreed only when shares total 100% and, if any commission is
 * shared outside the workspace, both sides' host agreements permit it.
 * No AI-suggested splits: every number here was entered by a person.
 */
export function assertSplitAgreeable(t: SplitTerms, workspaceRecipientId: Id): void {
  const total = t.shares.reduce((s, x) => s + x.bps, 0);
  if (total !== 10_000) throw new DomainError("bad_split", `Shares must total 100% (10000 bps), got ${total} bps`);
  if (t.shares.some((s) => s.bps < 0 || !Number.isInteger(s.bps))) throw new DomainError("bad_split", "Shares must be whole, non-negative basis points");
  const sharesOutside = t.shares.some((s) => s.recipientId !== workspaceRecipientId && s.bps > 0);
  if (sharesOutside && (t.hostRulesOurs !== "permitted" || t.hostRulesTheirs !== "permitted")) {
    throw new DomainError("host_rules", "Both sides' host agreements must permit sharing commission before these terms are agreed");
  }
  for (const f of t.fees) {
    if (!Number.isSafeInteger(f.amountMinor) || f.amountMinor <= 0) throw new DomainError("bad_fee", "Fees must be positive amounts");
  }
}

/** Shape of a collaboration fee line as the network slice stores it (see src/domain/collaboration.ts FeeLine). */
export interface CollaborationFeeLineInput {
  kind: "commission_split" | FeeKind;
  amount: { amountMinor: number; currency: string } | null;
  commissionShareBps: number | null;
  bookingItemIds: Id[];
  recipientId: Id;
}

/**
 * Turns a collaboration's fee lines into split terms for one booking line:
 * commission_split lines become shares (the rest stays with the workspace),
 * fixed fees become fee lines.
 */
export function splitFromFeeLines(
  itemId: Id,
  lines: readonly CollaborationFeeLineInput[],
  workspaceRecipientId: Id,
): { shares: SplitTerms["shares"]; fees: Omit<SplitTerms["fees"][number], "id">[] } {
  const mine = lines.filter((l) => l.bookingItemIds.length === 0 || l.bookingItemIds.includes(itemId));
  const shares = new Map<Id, number>();
  const fees: Omit<SplitTerms["fees"][number], "id">[] = [];
  for (const l of mine) {
    if (l.kind === "commission_split") {
      if (l.commissionShareBps == null) throw new DomainError("bad_fee_line", "A commission split needs a share in basis points");
      shares.set(l.recipientId, (shares.get(l.recipientId) ?? 0) + l.commissionShareBps);
    } else {
      if (!l.amount) throw new DomainError("bad_fee_line", `A ${l.kind} fee needs a fixed amount`);
      // Fixed fees apply once per collaboration; attach them to the first booking line they name.
      if (l.bookingItemIds.length > 0 && l.bookingItemIds[0] !== itemId) continue;
      fees.push({ recipientId: l.recipientId, kind: l.kind, amountMinor: l.amount.amountMinor, currency: l.amount.currency });
    }
  }
  const outside = [...shares.values()].reduce((s, b) => s + b, 0);
  if (outside > 10_000) throw new DomainError("bad_split", "Commission shares exceed 100%");
  shares.set(workspaceRecipientId, (shares.get(workspaceRecipientId) ?? 0) + (10_000 - outside));
  return { shares: [...shares].map(([recipientId, bps]) => ({ recipientId, bps })), fees };
}

/** Allocate a verified net across agreed shares; parts sum exactly to the net. */
export function allocateNet(netMinor: number, shares: readonly { recipientId: Id; bps: number }[]): { recipientId: Id; amountMinor: number }[] {
  return allocate(
    netMinor,
    shares.map((s) => ({ memberId: s.recipientId, bps: s.bps })),
  ).map((a) => ({ recipientId: a.memberId, amountMinor: a.amountMinor }));
}

/**
 * When the net changes after allocation (a late reversal, a top-up, a released
 * hold), the difference is re-allocated per the terms. An increase is always
 * shared pro rata. A decrease is shared pro rata, or absorbed entirely by the
 * owning workspace when the terms say it bears the loss. The returned deltas
 * sum exactly to newNet minus what was already allocated.
 */
export function reallocationDelta(
  allocated: ReadonlyMap<Id, number>,
  newNetMinor: number,
  terms: Pick<SplitTerms, "shares" | "reversalLossBearer">,
  workspaceRecipientId: Id,
): { recipientId: Id; amountMinor: number }[] {
  if (newNetMinor < 0) throw new DomainError("negative_net", "The net for this receivable would be negative; resolve it before re-allocating");
  const already = [...allocated.values()].reduce((s, x) => s + x, 0);
  const diff = newNetMinor - already;
  if (diff === 0) return [];
  if (diff < 0 && terms.reversalLossBearer === "owner_workspace") return [{ recipientId: workspaceRecipientId, amountMinor: diff }];
  const target = allocateNet(newNetMinor, terms.shares);
  return target
    .map((t) => ({ recipientId: t.recipientId, amountMinor: t.amountMinor - (allocated.get(t.recipientId) ?? 0) }))
    .filter((d) => d.amountMinor !== 0);
}

// ---------------------------------------------------------------------------
// Payouts

export type LineStatus = "retained" | "pending" | "approved" | "sending" | "settled" | "instructed" | "failed" | "reversed" | "canceled";

/**
 * How one payout line is paid. Transfers draw on the platform balance, so a
 * commission share is transferred only when every receipt for it landed in
 * that balance and the recipient can receive payouts. Fixed fees are owed by
 * the workspace, which the platform doesn't hold, and money owed back
 * (negative lines) is collected by instruction too.
 */
export function lineMethod(input: {
  kind: "commission_share" | "commission_adjustment" | FeeKind;
  amountMinor: number;
  receiptsLandedIn: readonly LandedIn[];
  recipient: { stripeAccountId: string | null; payoutsEnabled: boolean };
}): PayoutMethod {
  const isCommission = input.kind === "commission_share" || input.kind === "commission_adjustment";
  const landed = isCommission && input.amountMinor > 0 && input.receiptsLandedIn.length > 0 && input.receiptsLandedIn.every((l) => l === "platform_balance");
  return payoutMethod({ commissionLandsInPlatformBalance: landed, recipientOnboarded: Boolean(input.recipient.stripeAccountId) && input.recipient.payoutsEnabled });
}

/** Money is a human gate: only a workspace owner approves a payout batch, and only a draft with lines in it. */
export function assertCanApproveBatch(role: Role | null, batch: { status: string; lineCount: number }): void {
  if (role !== "owner") throw new DomainError("forbidden", "Only a workspace owner can approve a payout batch; assistants and advisors can prepare one");
  if (batch.status !== "draft") throw new DomainError("invalid_transition", `This batch is ${batch.status}, not a draft`);
  if (batch.lineCount === 0) throw new DomainError("empty_batch", "There is nothing in this batch to approve");
}

/** Stable reference printed on instructions and used as the bank-transfer memo. */
export const settlementReference = (lineId: Id): string => `ATP-${lineId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

export interface InstructionParty {
  name: string;
  email: string | null;
}

/** The exact words a paying party gets: what to send, to whom, with which reference. */
export function settlementInstructionText(i: {
  payer: InstructionParty;
  payee: InstructionParty;
  amountMinor: number;
  currency: string;
  reference: string;
  purpose: string;
  payeeDetails: string | null;
}): string {
  const amount = formatMoney({ amountMinor: i.amountMinor, currency: i.currency });
  return [
    `Settlement instruction ${i.reference}`,
    ``,
    `From: ${i.payer.name}`,
    `To: ${i.payee.name}${i.payee.email ? ` <${i.payee.email}>` : ""}`,
    `Amount: ${amount} (${i.currency}) — send exactly this amount; do not deduct fees from it.`,
    `Reference: ${i.reference} (include it on the transfer so it can be matched)`,
    `For: ${i.purpose}`,
    ``,
    i.payeeDetails ? `Payee's payment details:\n${i.payeeDetails}` : `Payee's payment details: ask ${i.payee.name} directly; none are on file.`,
    ``,
    `When the payment has been sent, the workspace owner marks this instruction settled.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reconciliation and reports

export interface LedgerRow {
  receivable: Receivable & { tripId: Id; tripTitle: string; supplierName: string | null; hostAgency: string | null };
  events: readonly ReceiptEvent[];
}

export interface ReconGroup {
  key: string;
  expectedMinor: number;
  receivedMinor: number;
  adjustmentsMinor: number;
  netMinor: number;
  varianceMinor: number;
  open: number;
  overdue: number;
  disputed: number;
}

/** Received vs expected, grouped (per trip, supplier or host agency) and per currency. */
export function reconcile(rows: readonly LedgerRow[], by: "trip" | "supplier" | "host_agency", now: Date): (ReconGroup & { currency: string })[] {
  const groups = new Map<string, ReconGroup & { currency: string }>();
  for (const row of rows) {
    const r = row.receivable;
    const label = by === "trip" ? r.tripTitle : by === "supplier" ? (r.supplierName ?? "Unknown supplier") : (r.hostAgency ?? "No host agency");
    const k = `${label}\u0000${r.currency}`;
    const g = groups.get(k) ?? { key: label, currency: r.currency, expectedMinor: 0, receivedMinor: 0, adjustmentsMinor: 0, netMinor: 0, varianceMinor: 0, open: 0, overdue: 0, disputed: 0 };
    const s = receivableState(r, row.events, now);
    g.expectedMinor += r.expectedMinor;
    g.receivedMinor += s.received;
    g.adjustmentsMinor += s.adjustments;
    g.netMinor += s.net;
    g.varianceMinor += s.variance;
    if (s.status !== "settled") g.open++;
    if (s.status === "overdue") g.overdue++;
    if (s.status === "disputed") g.disputed++;
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency));
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string | Date) => Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / DAY));

export interface DelayStat {
  party: string;
  count: number;
  late: number;
  avgDaysLate: number;
  maxDaysLate: number;
  stillOpen: number;
}

function summarizeDelays(entries: { party: string; daysLate: number; open: boolean }[]): DelayStat[] {
  const m = new Map<string, { n: number; late: number; total: number; max: number; open: number }>();
  for (const e of entries) {
    const g = m.get(e.party) ?? { n: 0, late: 0, total: 0, max: 0, open: 0 };
    g.n++;
    if (e.daysLate > 0) g.late++;
    g.total += e.daysLate;
    g.max = Math.max(g.max, e.daysLate);
    if (e.open) g.open++;
    m.set(e.party, g);
  }
  return [...m]
    .map(([party, g]) => ({ party, count: g.n, late: g.late, avgDaysLate: Math.round((g.total / g.n) * 10) / 10, maxDaysLate: g.max, stillOpen: g.open }))
    .sort((a, b) => b.avgDaysLate - a.avgDaysLate || a.party.localeCompare(b.party));
}

/**
 * Reputation inputs, kept apart: suppliers are late when commission arrives
 * after it was expected; advisors are late when a settlement instruction they
 * were given sits unpaid. A late supplier must never count against an advisor.
 */
export function paymentDelays(
  input: {
    receivables: readonly { supplierName: string | null; expectedBy: string | null; firstReceivedAt: string | null }[];
    instructions: readonly { payerName: string; issuedAt: string; settledAt: string | null; status: string }[];
  },
  now: Date,
  advisorGraceDays = 7,
): { suppliers: DelayStat[]; advisors: DelayStat[] } {
  const suppliers = input.receivables
    .filter((r) => r.expectedBy && (r.firstReceivedAt || new Date(r.expectedBy) < now))
    .map((r) => ({ party: r.supplierName ?? "Unknown supplier", daysLate: daysBetween(r.expectedBy!, r.firstReceivedAt ?? now), open: !r.firstReceivedAt }));
  const advisors = input.instructions
    .filter((i) => i.status !== "canceled")
    .map((i) => ({ party: i.payerName, daysLate: Math.max(0, daysBetween(i.issuedAt, i.settledAt ?? now) - advisorGraceDays), open: i.status === "issued" }));
  return { suppliers: summarizeDelays(suppliers), advisors: summarizeDelays(advisors) };
}

export interface EarningsLine {
  recipientId: Id;
  recipientName: string;
  status: LineStatus;
  amountMinor: number;
  reversedMinor: number;
  currency: string;
}

/** Per-payee earnings: settled (net of transfer reversals) vs still pending; retained shares shown separately. */
export function earnings(lines: readonly EarningsLine[]) {
  const m = new Map<string, { recipientId: Id; name: string; currency: string; settledMinor: number; pendingMinor: number; retainedMinor: number; reversedMinor: number }>();
  for (const l of lines) {
    if (l.status === "canceled") continue;
    const k = `${l.recipientId}\u0000${l.currency}`;
    const g = m.get(k) ?? { recipientId: l.recipientId, name: l.recipientName, currency: l.currency, settledMinor: 0, pendingMinor: 0, retainedMinor: 0, reversedMinor: 0 };
    if (l.status === "retained") g.retainedMinor += l.amountMinor;
    else if (l.status === "settled" || l.status === "reversed") {
      g.settledMinor += l.amountMinor - l.reversedMinor;
      g.reversedMinor += l.reversedMinor;
    } else if (l.status !== "failed") g.pendingMinor += l.amountMinor;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Host-agency deductions, per host and currency. */
export function hostDeductions(rows: readonly LedgerRow[]) {
  const m = new Map<string, { hostAgency: string; currency: string; deductedMinor: number; receivedMinor: number; count: number }>();
  for (const row of rows) {
    const host = row.receivable.hostAgency ?? "No host agency";
    const k = `${host}\u0000${row.receivable.currency}`;
    const g = m.get(k) ?? { hostAgency: host, currency: row.receivable.currency, deductedMinor: 0, receivedMinor: 0, count: 0 };
    for (const e of row.events) {
      if (e.receivableId !== row.receivable.id) continue;
      if (e.kind === "host_deduction") {
        g.deductedMinor += -e.amountMinor;
        g.count++;
      }
      if (e.kind === "received") g.receivedMinor += e.amountMinor;
    }
    m.set(k, g);
  }
  return [...m.values()]
    .filter((g) => g.receivedMinor > 0 || g.deductedMinor > 0)
    .map((g) => ({ ...g, effectiveBps: g.receivedMinor > 0 ? Math.round((g.deductedMinor / g.receivedMinor) * 10_000) : 0 }))
    .sort((a, b) => a.hostAgency.localeCompare(b.hostAgency));
}
