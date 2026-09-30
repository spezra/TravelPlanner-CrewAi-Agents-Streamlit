import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { auditLog } from "@/modules/ops/admin";
import { AdminNav } from "../AdminNav";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

type Params = { actor?: string; action?: string; from?: string; to?: string; before?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const { tenant } = await requireMember(["owner", "admin"]);
  const db = await getDb();
  const before = p.before && /^\d+$/.test(p.before) ? Number(p.before) : null;
  const [page, members] = await Promise.all([
    auditLog(db, tenant, { actor: p.actor || null, action: p.action || null, from: p.from || null, to: p.to || null, before }),
    withTenant(db, tenant, async (q) => (await q.query<{ id: string; name: string }>("select id, name from members order by name")).rows),
  ]);
  const next = new URLSearchParams(Object.entries({ ...p, before: String(page.nextBefore ?? "") }).filter(([, v]) => v) as [string, string][]);

  return (
    <main>
      <h1>Audit log</h1>
      <AdminNav current="/admin/audit" />
      <form method="get" className="card row small">
        <label style={{ margin: 0 }}>
          Actor{" "}
          <select name="actor" defaultValue={p.actor ?? ""}>
            <option value="">Anyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            <option value="system:escalation">System: escalation</option>
            <option value="system:retention">System: retention</option>
            <option value="system:export">System: export</option>
            <option value="agent:judgment">Agent: judgment</option>
            <option value="agent:brief">Agent: brief</option>
            <option value="agent:booking">Agent: booking</option>
          </select>
        </label>
        <label style={{ margin: 0 }}>
          Action{" "}
          <select name="action" defaultValue={p.action ?? ""}>
            <option value="">Any</option>
            {page.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label style={{ margin: 0 }}>
          From <input type="date" name="from" defaultValue={p.from ?? ""} />
        </label>
        <label style={{ margin: 0 }}>
          To <input type="date" name="to" defaultValue={p.to ?? ""} />
        </label>
        <button className="btn small">Filter</button>
        <Link href="/admin/audit" className="small muted">
          Clear
        </Link>
      </form>
      <div className="card table-wrap">
        {page.rows.length === 0 ? (
          <p className="empty">No matching events.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When (UTC)</th>
                <th>Who</th>
                <th>Action</th>
                <th>Subject</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((r) => (
                <tr key={r.id}>
                  <td className="small">{r.at.slice(0, 19).replace("T", " ")}</td>
                  <td className="small">{r.actorName ?? r.actor}</td>
                  <td>
                    <span className="chip">{r.action}</span>
                  </td>
                  <td className="small muted">{r.subject}</td>
                  <td className="small muted" style={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                    {r.data && Object.keys(r.data as object).length ? JSON.stringify(r.data) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="actions">
        {before && (
          <Link className="btn" href="/admin/audit">
            Newest
          </Link>
        )}
        {page.nextBefore && (
          <Link className="btn" href={`/admin/audit?${next.toString()}`}>
            Older →
          </Link>
        )}
      </div>
    </main>
  );
}
