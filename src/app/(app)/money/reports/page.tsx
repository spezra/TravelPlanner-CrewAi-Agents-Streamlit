import { withTenant } from "@/db/tenant";
import type { DelayStat } from "@/domain/money";
import { getDb, requireMember } from "@/lib/server";
import { reports } from "@/modules/money/reports";
import { money, MoneyNav } from "../ui";

export const metadata = { title: "Money · Reports" };
export const dynamic = "force-dynamic";

function Delays({ title, note, rows }: { title: string; note: string; rows: DelayStat[] }) {
  return (
    <div className="card table-wrap">
      <h3>{title}</h3>
      <p className="small muted">{note}</p>
      {rows.length === 0 ? (
        <p className="empty">Nothing to measure yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th />
              <th>Payments</th>
              <th>Late</th>
              <th>Avg days late</th>
              <th>Worst</th>
              <th>Still open</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.party}>
                <td>{d.party}</td>
                <td>{d.count}</td>
                <td>{d.late}</td>
                <td>{d.avgDaysLate}</td>
                <td>{d.maxDaysLate}</td>
                <td>{d.stillOpen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function Reports() {
  const { tenant } = await requireMember();
  const r = await withTenant(await getDb(), tenant, (q) => reports(q, new Date()));

  return (
    <main>
      <h1>Money reports</h1>
      <MoneyNav current="/money/reports" />

      <h2>Earnings by payee</h2>
      <div className="card table-wrap">
        {r.earnings.length === 0 ? (
          <p className="empty">Nothing allocated yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Payee</th>
                <th>Settled</th>
                <th>Pending</th>
                <th>Retained by workspace</th>
                <th>Reversed</th>
              </tr>
            </thead>
            <tbody>
              {r.earnings.map((e) => (
                <tr key={`${e.recipientId}-${e.currency}`}>
                  <td>{e.name}</td>
                  <td>{money(e.settledMinor, e.currency)}</td>
                  <td>{money(e.pendingMinor, e.currency)}</td>
                  <td>{e.retainedMinor ? money(e.retainedMinor, e.currency) : "—"}</td>
                  <td>{e.reversedMinor ? money(e.reversedMinor, e.currency) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Payment delays</h2>
      <p className="lede">Kept apart on purpose: a supplier paying commission late never counts against the advisor who then pays a collaborator.</p>
      <div className="grid2">
        <Delays title="Suppliers" note="Commission received after its expected-by date." rows={r.delays.suppliers} />
        <Delays title="Advisors" note="Settlement instructions paid more than 7 days after they were issued." rows={r.delays.advisors} />
      </div>

      <h2>Host-agency deductions</h2>
      <div className="card table-wrap">
        {r.deductions.length === 0 ? (
          <p className="empty">No host deductions recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Host agency</th>
                <th>Commission received</th>
                <th>Deducted</th>
                <th>Effective rate</th>
                <th>Deductions</th>
              </tr>
            </thead>
            <tbody>
              {r.deductions.map((d) => (
                <tr key={`${d.hostAgency}-${d.currency}`}>
                  <td>{d.hostAgency}</td>
                  <td>{money(d.receivedMinor, d.currency)}</td>
                  <td>{money(d.deductedMinor, d.currency)}</td>
                  <td>{(d.effectiveBps / 100).toFixed(1)}%</td>
                  <td>{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
