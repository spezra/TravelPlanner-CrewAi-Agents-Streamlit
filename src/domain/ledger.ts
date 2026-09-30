/**
 * Receivables ledger. Verifies commission actually received and allocates it
 * to booking lines. Host-agency deductions, short payments, FX, reversals and
 * disputes adjust the amount before any split. Payouts need funding: automatic
 * payout is offered only where that funding path is supported; elsewhere the
 * platform issues settlement instructions.
 */
import { DomainError, type Id } from "./common";

export interface Receivable {
  id: Id;
  itemId: Id;
  expectedMinor: number;
  currency: string;
  expectedBy: string | null;
}

export type ReceiptAdjustmentKind = "host_deduction" | "short_payment" | "fx" | "reversal" | "dispute_hold";

export interface ReceiptEvent {
  receivableId: Id;
  kind: "received" | ReceiptAdjustmentKind;
  /** Positive for received, negative for deductions/reversals/holds. */
  amountMinor: number;
  at: string;
  note: string | null;
}

export function receivableStatus(r: Receivable, events: readonly ReceiptEvent[], now: Date) {
  const mine = events.filter((e) => e.receivableId === r.id);
  const received = mine.filter((e) => e.kind === "received").reduce((s, e) => s + e.amountMinor, 0);
  const adjustments = mine.filter((e) => e.kind !== "received").reduce((s, e) => s + e.amountMinor, 0);
  const net = received + adjustments;
  const held = mine.some((e) => e.kind === "dispute_hold");
  let status: "expected" | "overdue" | "short" | "settled" | "disputed";
  if (held) status = "disputed";
  else if (received === 0) status = r.expectedBy && new Date(r.expectedBy) < now ? "overdue" : "expected";
  else status = net < r.expectedMinor ? "short" : "settled";
  return { received, adjustments, net, status, variance: net - r.expectedMinor };
}

export interface SplitShare {
  memberId: Id;
  bps: number; // basis points
}

/**
 * Allocate a net amount by basis points with largest-remainder rounding, so
 * the parts always sum exactly to the whole. No AI-suggested "fair" splits:
 * shares come from agreed terms.
 */
export function allocate(netMinor: number, shares: readonly SplitShare[]): { memberId: Id; amountMinor: number }[] {
  const total = shares.reduce((s, x) => s + x.bps, 0);
  if (total !== 10_000) throw new DomainError("bad_split", `Shares must total 10000 bps, got ${total}`);
  if (netMinor < 0) throw new DomainError("negative_net", "Cannot split a negative net amount");
  const raw = shares.map((s) => ({ memberId: s.memberId, exact: (netMinor * s.bps) / 10_000 }));
  const floored = raw.map((r) => ({ memberId: r.memberId, amountMinor: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }));
  let leftover = netMinor - floored.reduce((s, x) => s + x.amountMinor, 0);
  const order = floored.map((_, i) => i).sort((a, b) => floored[b]!.rem - floored[a]!.rem || a - b);
  for (const i of order) {
    if (leftover <= 0) break;
    floored[i]!.amountMinor += 1;
    leftover -= 1;
  }
  return floored.map(({ memberId, amountMinor }) => ({ memberId, amountMinor }));
}

export type PayoutMethod = "platform_transfer" | "settlement_instruction";

/**
 * Transfers move money from a funded platform balance, so commission paid into
 * someone else's bank account must be collected or instructed first.
 */
export function payoutMethod(p: { commissionLandsInPlatformBalance: boolean; recipientOnboarded: boolean }): PayoutMethod {
  return p.commissionLandsInPlatformBalance && p.recipientOnboarded ? "platform_transfer" : "settlement_instruction";
}
