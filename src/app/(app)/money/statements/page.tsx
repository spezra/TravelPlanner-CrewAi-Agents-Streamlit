import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import * as repo from "@/modules/money/repo";
import { importStatementAction } from "../actions";
import { Flash, fmtDate, MoneyNav } from "../ui";

export const metadata = { title: "Money · Statements" };
export const dynamic = "force-dynamic";

export default async function Statements({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { member, tenant } = await requireMember();
  const imports = await withTenant(await getDb(), tenant, (q) => repo.listImports(q));

  return (
    <main>
      <h1>Commission statements</h1>
      <MoneyNav current="/money/statements" />
      <p className="lede">
        Import a host agency&apos;s commission statement (CSV). Rows are matched to receivables by confirmation number; anything uncertain waits for you. Importing
        the same file twice changes nothing.
      </p>
      <Flash error={error} ok={ok} />

      {member.role !== "assistant" && (
        <form action={importStatementAction} className="card">
          <label htmlFor="file">Statement file (CSV with columns for confirmation number, supplier, guest, amount, currency; optional host fee)</label>
          <input id="file" name="file" type="file" accept=".csv,text/csv" required />
          <div className="grid2">
            <div>
              <label htmlFor="hostAgency">Host agency</label>
              <input id="hostAgency" name="hostAgency" type="text" />
            </div>
            <div>
              <label htmlFor="defaultCurrency">Currency, if the file has no currency column</label>
              <input id="defaultCurrency" name="defaultCurrency" type="text" maxLength={3} placeholder="USD" />
            </div>
          </div>
          <div className="actions">
            <button className="btn primary">Import</button>
          </div>
        </form>
      )}

      <h2>Imported</h2>
      {imports.length === 0 ? (
        <p className="empty">No statements imported yet.</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Host</th>
                <th>Imported</th>
                <th>Rows</th>
                <th>Matched</th>
                <th>To match</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/money/statements/${i.id}`}>{i.fileName}</Link>
                  </td>
                  <td>{i.hostAgency ?? "—"}</td>
                  <td className="small">
                    {fmtDate(i.importedAt)} by {i.importedByName}
                  </td>
                  <td>{i.rowCount}</td>
                  <td>{i.matchedCount}</td>
                  <td>{i.openCount ? <span className="chip warn">{i.openCount}</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
