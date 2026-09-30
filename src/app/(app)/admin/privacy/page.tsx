import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { listRequests, subjectOptions } from "@/modules/ops/privacy";
import { fulfilAccessAction, fulfilDeletionAction, recordRequestAction, rejectRequestAction } from "../actions";
import { AdminNav } from "../AdminNav";

export const metadata = { title: "Data-subject requests" };
export const dynamic = "force-dynamic";

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { tenant } = await requireMember(["owner", "admin"]);
  const db = await getDb();
  const [requests, options, members] = await Promise.all([
    listRequests(db, tenant),
    subjectOptions(db, tenant),
    withTenant(db, tenant, async (q) => (await q.query<{ id: string; name: string }>("select id, name from members")).rows),
  ]);
  const name = (id: string | null) => members.find((m) => m.id === id)?.name ?? "—";
  const today = new Date().toISOString().slice(0, 10);
  const open = requests.filter((r) => r.status === "open" || r.status === "in_progress");
  const closed = requests.filter((r) => r.status === "completed" || r.status === "rejected");

  return (
    <main>
      <h1>Data-subject requests</h1>
      <AdminNav current="/admin/privacy" />
      <p className="lede">
        Access and deletion requests from clients, their party, or supplier contacts. Deletion erases personal details and encrypted notes and keeps a tombstone;
        bookings, amounts and ledger history stay so totals never change. None of this is legal advice.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <h2>Open</h2>
      {open.length === 0 && <p className="empty">No open requests.</p>}
      {open.map((r) => (
        <section key={r.id} className="card">
          <div className="row">
            <span className={`chip ${r.kind === "deletion" ? "alert" : "warn"}`}>{r.kind}</span>
            <h3 className="grow">{options.find((o) => o.id === r.subjectId && o.type === r.subjectType)?.label ?? r.subjectRef}</h3>
            <span className="small muted">received {r.receivedAt.slice(0, 10)}</span>
          </div>
          {r.note && <div className="small muted">{r.note}</div>}
          {r.status === "in_progress" ? (
            <p className="small">
              Export being prepared. <Link href="/admin/exports">Download it from Data export</Link> to send to the requester.
            </p>
          ) : (
            <div className="actions">
              {r.kind === "access" ? (
                <form action={fulfilAccessAction}>
                  <input type="hidden" name="requestId" value={r.id} />
                  <button className="btn primary">Prepare their data</button>
                </form>
              ) : (
                <form action={fulfilDeletionAction} className="row">
                  <input type="hidden" name="requestId" value={r.id} />
                  <label className="small" style={{ margin: 0 }}>
                    <input type="checkbox" name="confirm" required /> I understand this can&apos;t be undone
                  </label>
                  <button className="btn primary">Erase</button>
                </form>
              )}
              <details>
                <summary className="btn small">Decline</summary>
                <form action={rejectRequestAction}>
                  <input type="hidden" name="requestId" value={r.id} />
                  <label htmlFor={`r-${r.id}`}>Reason (recorded)</label>
                  <input id={`r-${r.id}`} name="reason" type="text" required minLength={3} maxLength={1000} />
                  <div className="actions">
                    <button className="btn small">Decline request</button>
                  </div>
                </form>
              </details>
            </div>
          )}
        </section>
      ))}

      <h2>Record a request</h2>
      <form action={recordRequestAction} className="card narrow">
        <label htmlFor="subject">About</label>
        <select id="subject" name="subject" className="field" required defaultValue="">
          <option value="" disabled>
            Choose a person or client
          </option>
          {options.map((o) => (
            <option key={`${o.type}:${o.id}`} value={`${o.type}:${o.id}`}>
              {o.label}
            </option>
          ))}
        </select>
        <label htmlFor="kind">Request</label>
        <select id="kind" name="kind" className="field">
          <option value="access">Access: a copy of their data</option>
          <option value="deletion">Deletion: erase their personal data</option>
        </select>
        <label htmlFor="received">Received on</label>
        <input id="received" name="receivedAt" type="date" defaultValue={today} required />
        <label htmlFor="note">How it arrived / identity check</label>
        <input id="note" name="note" type="text" maxLength={1000} />
        <div className="actions">
          <button className="btn primary">Record</button>
        </div>
      </form>

      {closed.length > 0 && (
        <>
          <h2>Closed</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Request</th>
                  <th>Outcome</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{r.subjectRef}</td>
                    <td>{r.kind}</td>
                    <td>
                      <span className={`chip ${r.status === "completed" ? "ok" : ""}`}>{r.status}</span> <span className="small muted">{r.completedAt?.slice(0, 10)}</span>
                    </td>
                    <td className="small">{name(r.completedBy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
