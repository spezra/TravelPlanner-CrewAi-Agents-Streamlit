import { notFound } from "next/navigation";
import { z } from "zod";
import { withTenant } from "@/db/tenant";
import { normalizeRef } from "@/domain/money";
import { getDb, requireMember } from "@/lib/server";
import * as repo from "@/modules/money/repo";
import { ignoreRowAction, matchRowAction } from "../../actions";
import { Flash, fmtDate, label, money, MoneyNav } from "../../ui";

export const metadata = { title: "Money · Statement" };
export const dynamic = "force-dynamic";

export default async function Statement({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const { member, tenant } = await requireMember();
  const data = await withTenant(await getDb(), tenant, async (q) => {
    const imp = (await repo.listImports(q, id))[0];
    if (!imp) return null;
    return { imp, rows: await repo.listStatementRows(q, id), receivables: await repo.listReceivables(q) };
  });
  if (!data) notFound();
  const { imp, rows, receivables } = data;
  const canWrite = member.role !== "assistant";
  const back = `/money/statements/${id}`;

  return (
    <main>
      <h1>{imp.fileName}</h1>
      <MoneyNav current="/money/statements" />
      <p className="lede">
        {imp.hostAgency ?? "Host not named"} · imported {fmtDate(imp.importedAt)} by {imp.importedByName} · {imp.matchedCount} of {imp.rowCount} rows matched
      </p>
      <Flash error={error} ok={ok} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Row</th>
              <th>Confirmation</th>
              <th>Supplier / guest</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const matched = receivables.find((x) => x.id === r.receivableId);
              // Suggest same-currency receivables, likeliest (similar reference or supplier) first. A person decides.
              const candidates = receivables
                .filter((x) => x.currency === r.currency)
                .sort((a, b) => score(b, r) - score(a, r));
              return (
                <tr key={r.id}>
                  <td>{r.rowNo}</td>
                  <td>{r.confirmationRef ?? "—"}</td>
                  <td className="small">
                    {r.supplier ?? "—"}
                    <div className="muted">{r.guest ?? ""}</div>
                  </td>
                  <td>
                    {r.currency ? money(r.amountMinor, r.currency) : "—"}
                    {r.deductionMinor !== 0 && <div className="small muted">host fee {money(-r.deductionMinor, r.currency)}</div>}
                  </td>
                  <td>
                    <span className={`chip ${r.status === "unmatched" ? "warn" : r.status === "ignored" ? "" : "ok"}`}>{label(r.status)}</span>
                    {matched && <div className="small muted">→ {matched.itemTitle}</div>}
                    {r.reason && <div className="small muted">{r.reason}</div>}
                    {canWrite && r.status === "unmatched" && (
                      <>
                        <form action={matchRowAction} className="row" style={{ marginTop: 6 }}>
                          <input type="hidden" name="rowId" value={r.id} />
                          <input type="hidden" name="back" value={back} />
                          <select name="receivableId" className="field grow" required aria-label="Receivable">
                            <option value="">Match to…</option>
                            {candidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.itemTitle} · {c.confirmationRef ?? "no conf."} · {money(c.expectedMinor, c.currency)}
                              </option>
                            ))}
                          </select>
                          <button className="btn small">Match</button>
                        </form>
                        <form action={ignoreRowAction} className="row" style={{ marginTop: 6 }}>
                          <input type="hidden" name="rowId" value={r.id} />
                          <input type="hidden" name="back" value={back} />
                          <input name="reason" type="text" placeholder="Why set aside" aria-label="Reason" className="grow" />
                          <button className="btn small">Set aside</button>
                        </form>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function score(r: repo.ReceivableRow, row: repo.StatementLineRow): number {
  let s = 0;
  const a = normalizeRef(r.confirmationRef);
  const b = normalizeRef(row.confirmationRef);
  if (a && b && (a.includes(b) || b.includes(a))) s += 2;
  if (row.supplier && r.supplierName && r.supplierName.toLowerCase().includes(row.supplier.toLowerCase().slice(0, 6))) s += 1;
  return s;
}
