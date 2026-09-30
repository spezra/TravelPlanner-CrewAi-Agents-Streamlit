import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { ledgerView, reconciliation } from "@/modules/money/reports";
import type { ReconGroup } from "@/domain/money";
import { recordReceiptAction } from "./actions";
import { Flash, fmtDate, label, money, MoneyNav, STATUS_TONE } from "./ui";

export const metadata = { title: "Money · Receivables" };
export const dynamic = "force-dynamic";

const KINDS = [
  ["received", "Received"],
  ["host_deduction", "Host-agency deduction"],
  ["short_payment", "Short payment (supplier correction)"],
  ["fx", "FX adjustment"],
  ["reversal", "Reversal / clawback"],
  ["dispute_hold", "Dispute: hold"],
  ["dispute_release", "Dispute: release"],
] as const;

function ReconTable({ title, groups }: { title: string; groups: (ReconGroup & { currency: string })[] }) {
  return (
    <div className="card table-wrap">
      <h3>{title}</h3>
      {groups.length === 0 ? (
        <p className="empty">Nothing yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th />
              <th>Expected</th>
              <th>Received</th>
              <th>Adjustments</th>
              <th>Net</th>
              <th>Variance</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={`${g.key}-${g.currency}`}>
                <td>{g.key}</td>
                <td>{money(g.expectedMinor, g.currency)}</td>
                <td>{money(g.receivedMinor, g.currency)}</td>
                <td>{money(g.adjustmentsMinor, g.currency)}</td>
                <td>{money(g.netMinor, g.currency)}</td>
                <td className={g.varianceMinor < 0 ? "chip warn" : ""}>{money(g.varianceMinor, g.currency)}</td>
                <td className="small">
                  {g.open}
                  {g.overdue ? ` · ${g.overdue} overdue` : ""}
                  {g.disputed ? ` · ${g.disputed} disputed` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function Receivables({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { member, tenant } = await requireMember();
  const now = new Date();
  const canWrite = member.role !== "assistant";
  const { views, recon } = await withTenant(await getDb(), tenant, async (q) => ({ views: await ledgerView(q, now), recon: await reconciliation(q, now) }));
  const today = now.toISOString().slice(0, 10);

  return (
    <main>
      <h1>Money</h1>
      <MoneyNav current="/money" />
      <p className="lede">
        Commission expected on every confirmed booking line, and what actually arrived. Host deductions, short payments, FX, reversals and disputes adjust the
        amount here, before anything is split.
      </p>
      <Flash error={error} ok={ok} />

      <h2>Receivables</h2>
      {views.length === 0 && <p className="empty">No receivables yet. Add commission terms to a booking line; confirmed lines get one automatically.</p>}
      {views.map(({ receivable: r, events, state }) => (
        <section key={r.id} className="card">
          <div className="row">
            <span className={`chip ${STATUS_TONE[state.status]}`}>{state.status}</span>
            <h3 className="grow">
              {r.itemTitle}
              <span className="small muted"> · {r.tripTitle}</span>
            </h3>
            <span>
              {money(state.net, r.currency)} <span className="muted small">of {money(r.expectedMinor, r.currency)}</span>
            </span>
          </div>
          <div className="small muted">
            {r.supplierName ?? "Supplier not set"} · conf. {r.confirmationRef ?? "—"} · host {r.hostAgency ?? "—"} · expected by {fmtDate(r.expectedBy)}
            {r.basis === "rate" && r.rateBps != null ? ` · ${(r.rateBps / 100).toFixed(2)}%` : " · fixed amount"}
            {r.commissionRecipient ? ` · pays: ${r.commissionRecipient}` : ""}
          </div>
          {events.length > 0 && (
            <div className="table-wrap">
              <table>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td className="small">{fmtDate(e.at)}</td>
                      <td>
                        <span className="chip">{label(e.kind)}</span>
                        {e.landedIn && <span className="small muted"> · {label(e.landedIn)}</span>}
                      </td>
                      <td>{money(e.amountMinor, r.currency)}</td>
                      <td className="small muted">
                        {e.originalCurrency ? `${money(e.originalAmountMinor ?? 0, e.originalCurrency)} @ ${e.fxRate} · ` : ""}
                        {e.note ?? ""} {e.source !== "manual" ? `(${e.source})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canWrite && (
            <details>
              <summary className="small">Record money received or an adjustment</summary>
              <form action={recordReceiptAction} className="grid2">
                <input type="hidden" name="receivableId" value={r.id} />
                <div>
                  <label htmlFor={`kind-${r.id}`}>What happened</label>
                  <select id={`kind-${r.id}`} name="kind" className="field" defaultValue="received">
                    {KINDS.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={`amount-${r.id}`}>Amount (as a positive number; FX adjustments may be negative)</label>
                  <input id={`amount-${r.id}`} name="amount" type="text" inputMode="decimal" required />
                </div>
                <div>
                  <label htmlFor={`cur-${r.id}`}>Currency paid</label>
                  <input id={`cur-${r.id}`} name="currency" type="text" defaultValue={r.currency} maxLength={3} required />
                </div>
                <div>
                  <label htmlFor={`fx-${r.id}`}>FX rate applied ({r.currency} per unit), if paid in another currency</label>
                  <input id={`fx-${r.id}`} name="fxRate" type="text" inputMode="decimal" />
                </div>
                <div>
                  <label htmlFor={`landed-${r.id}`}>Where the money landed (receipts)</label>
                  <select id={`landed-${r.id}`} name="landedIn" className="field" defaultValue="external_account">
                    <option value="external_account">An advisor or host bank account</option>
                    <option value="platform_balance">The platform&apos;s Stripe balance</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`at-${r.id}`}>Date</label>
                  <input id={`at-${r.id}`} name="at" type="date" defaultValue={today} required />
                </div>
                <div>
                  <label htmlFor={`note-${r.id}`}>Note</label>
                  <input id={`note-${r.id}`} name="note" type="text" />
                </div>
                <div className="actions">
                  <button className="btn primary">Record</button>
                </div>
              </form>
            </details>
          )}
        </section>
      ))}

      <h2>Reconciliation</h2>
      <ReconTable title="By trip" groups={recon.byTrip} />
      <ReconTable title="By supplier" groups={recon.bySupplier} />
      <ReconTable title="By host agency" groups={recon.byHost} />
    </main>
  );
}
