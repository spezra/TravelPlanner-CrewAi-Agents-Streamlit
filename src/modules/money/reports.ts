/**
 * Read models for the Money pages: the ledger with statuses, reconciliation
 * groups, earnings, payment delays and host deductions. All run inside the
 * caller's tenant transaction, so RLS scopes every number.
 */
import type { Queryable } from "@/db/client";
import { earnings, hostDeductions, paymentDelays, receivableState, reconcile, type LedgerEvent, type LedgerRow } from "@/domain/money";
import * as repo from "./repo";

export interface LedgerView {
  receivable: repo.ReceivableRow;
  events: LedgerEvent[];
  state: ReturnType<typeof receivableState>;
}

export async function ledgerView(q: Queryable, now: Date): Promise<LedgerView[]> {
  const [receivables, events] = await Promise.all([repo.listReceivables(q), repo.listEvents(q)]);
  return receivables.map((r) => {
    const mine = events.filter((e) => e.receivableId === r.id);
    return { receivable: r, events: mine, state: receivableState(r, mine, now) };
  });
}

const asLedgerRows = (views: readonly LedgerView[]): LedgerRow[] => views.map((v) => ({ receivable: v.receivable, events: v.events }));

export async function reconciliation(q: Queryable, now: Date) {
  const rows = asLedgerRows(await ledgerView(q, now));
  return { byTrip: reconcile(rows, "trip", now), bySupplier: reconcile(rows, "supplier", now), byHost: reconcile(rows, "host_agency", now) };
}

export async function reports(q: Queryable, now: Date) {
  const views = await ledgerView(q, now);
  const [lines, instructions] = await Promise.all([repo.listLines(q), repo.listInstructions(q)]);
  return {
    earnings: earnings(lines.map((l) => ({ recipientId: l.recipientId, recipientName: l.recipientName, status: l.status, amountMinor: l.amountMinor, reversedMinor: l.reversedMinor, currency: l.currency }))),
    delays: paymentDelays(
      {
        receivables: views.map((v) => ({ supplierName: v.receivable.supplierName, expectedBy: v.receivable.expectedBy, firstReceivedAt: v.state.firstReceivedAt })),
        instructions: instructions.map((i) => ({ payerName: i.payerName, issuedAt: i.issuedAt, settledAt: i.settledAt, status: i.status })),
      },
      now,
    ),
    deductions: hostDeductions(asLedgerRows(views)),
  };
}
