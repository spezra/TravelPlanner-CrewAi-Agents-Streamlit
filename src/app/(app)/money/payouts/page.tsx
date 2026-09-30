import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import * as repo from "@/modules/money/repo";
import { approveBatchAction, cancelBatchAction, markSettledAction, prepareBatchesAction, reverseTransferAction } from "../actions";
import { Flash, fmtDate, label, LINE_TONE, money, MoneyNav } from "../ui";

export const metadata = { title: "Money · Payouts" };
export const dynamic = "force-dynamic";

export default async function Payouts({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { member, tenant } = await requireMember();
  const isOwner = member.role === "owner";
  const { batches, lines, instructions, adjustments } = await withTenant(await getDb(), tenant, async (q) => ({
    batches: await repo.listBatches(q),
    lines: await repo.listLines(q),
    instructions: await repo.listInstructions(q),
    adjustments: (
      await q.query<{ id: string; kind: string; amount_minor: number; currency: string; borne_by: string; note: string | null; at: string }>(
        "select id, kind, amount_minor, currency, borne_by, note, at from money_adjustments order by at desc limit 50",
      )
    ).rows,
  }));
  const unbatched = lines.filter((l) => !l.batchId && l.status === "pending" && l.amountMinor !== 0);

  return (
    <main>
      <h1>Payouts</h1>
      <MoneyNav current="/money/payouts" />
      <p className="lede">
        Anyone can prepare a batch from verified commission and agreed fees. Only a workspace owner approves it. Shares funded through the platform&apos;s Stripe
        balance go to onboarded payees by transfer; everything else gets a settlement instruction saying exactly what to send to whom.
      </p>
      <Flash error={error} ok={ok} />

      <form action={prepareBatchesAction} className="card row">
        <span className="grow small">
          Allocate verified commission under agreed terms and gather unpaid fees into draft batches.
          {unbatched.length > 0 && ` ${unbatched.length} line${unbatched.length === 1 ? "" : "s"} already waiting.`}
        </span>
        <button className="btn primary">Prepare payouts</button>
      </form>

      <h2>Batches</h2>
      {batches.length === 0 && <p className="empty">No batches yet.</p>}
      {batches.map((b) => {
        const mine = lines.filter((l) => l.batchId === b.id);
        return (
          <section key={b.id} className="card">
            <div className="row">
              <span className={`chip ${b.status === "draft" ? "warn" : b.status === "completed" ? "ok" : ""}`}>{b.status}</span>
              <h3 className="grow">
                {money(b.totalMinor, b.currency)} <span className="small muted">in {b.lineCount} lines</span>
              </h3>
              <span className="small muted">
                prepared {fmtDate(b.preparedAt)} by {b.preparedByName}
                {b.approvedByName ? ` · approved by ${b.approvedByName}` : ""}
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Payee</th>
                    <th>For</th>
                    <th>Amount</th>
                    <th>How</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((l) => (
                    <tr key={l.id}>
                      <td>{l.recipientName}</td>
                      <td className="small">
                        {label(l.kind)}
                        <div className="muted">{[l.itemTitle, l.tripTitle].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td>
                        {money(l.amountMinor, l.currency)}
                        {l.reversedMinor > 0 && <div className="small chip alert">reversed {money(l.reversedMinor, l.currency)}</div>}
                      </td>
                      <td className="small">{l.method ? label(l.method) : "decided when paid"}</td>
                      <td>
                        <span className={`chip ${LINE_TONE[l.status] ?? ""}`}>{label(l.status)}</span>
                        {l.failure && <div className="small muted">{l.failure}</div>}
                        {isOwner && l.status === "settled" && l.stripeTransferId && (
                          <details>
                            <summary className="small">Reverse transfer</summary>
                            <form action={reverseTransferAction} className="row">
                              <input type="hidden" name="lineId" value={l.id} />
                              <input type="hidden" name="currency" value={l.currency} />
                              <input name="amount" type="text" inputMode="decimal" placeholder="All" aria-label="Amount to reverse" style={{ maxWidth: 100 }} />
                              <button className="btn small">Reverse</button>
                            </form>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {b.status === "draft" && (
              <div className="actions">
                {isOwner && (
                  <form action={approveBatchAction}>
                    <input type="hidden" name="batchId" value={b.id} />
                    <button className="btn primary">Approve and pay {money(b.totalMinor, b.currency)}</button>
                  </form>
                )}
                <form action={cancelBatchAction}>
                  <input type="hidden" name="batchId" value={b.id} />
                  <button className="btn">Cancel draft</button>
                </form>
                {!isOwner && <span className="small muted">Waiting for an owner to approve.</span>}
              </div>
            )}
          </section>
        );
      })}

      <h2>Settlement instructions</h2>
      {instructions.length === 0 ? (
        <p className="empty">None issued.</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>From → to</th>
                <th>Amount</th>
                <th>Issued</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {instructions.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/money/instructions/${i.id}`}>{i.reference}</Link>
                  </td>
                  <td className="small">
                    {i.payerName} → {i.payeeName}
                    <div className="muted">{i.purpose}</div>
                  </td>
                  <td>{money(i.amountMinor, i.currency)}</td>
                  <td className="small">{fmtDate(i.issuedAt)}</td>
                  <td>
                    <span className={`chip ${i.status === "settled" ? "ok" : "warn"}`}>{i.status}</span>
                    {isOwner && i.status === "issued" && (
                      <form action={markSettledAction}>
                        <input type="hidden" name="instructionId" value={i.id} />
                        <button className="btn small">Mark settled</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Adjustments</h2>
      {adjustments.length === 0 ? (
        <p className="empty">No reversals or re-allocations.</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.id}>
                  <td className="small">{fmtDate(String(a.at))}</td>
                  <td>{label(a.kind)}</td>
                  <td>{money(Number(a.amount_minor), a.currency)}</td>
                  <td className="small">borne by {label(a.borne_by)}</td>
                  <td className="small muted">{a.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
