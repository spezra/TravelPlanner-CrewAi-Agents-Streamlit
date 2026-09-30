import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { listCallTasks, type TaskStatus } from "@/modules/calls/repo";

export const metadata = { title: "Calls" };
export const dynamic = "force-dynamic";

const ROUTE_LABEL = { relationship_holder: "relationship holder", delegate: "delegate", automated: "automation (disclosed)" } as const;

export default async function Calls({ searchParams }: { searchParams: Promise<{ status?: string; error?: string }> }) {
  const { status: raw, error } = await searchParams;
  const status: TaskStatus | undefined = raw === "done" || raw === "canceled" ? raw : raw === "all" ? undefined : "open";
  const me = await requireMember();
  const tasks = await withTenant(await getDb(), me.tenant, (q) => listCallTasks(q, status ? { status } : {}));
  const mine = tasks.filter((t) => t.assigneeId === me.member.id || (t.route !== "automated" && t.ownerId === me.member.id && !t.assigneeId));
  const others = tasks.filter((t) => !mine.includes(t));

  const table = (rows: typeof tasks) => (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>Call</th>
            <th>With</th>
            <th>Trip</th>
            <th>Goes to</th>
            <th>Capture</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                <Link href={`/calls/${t.id}`}>{t.purpose}</Link>
                {t.spendsRelationshipCapital && <div className="small muted">Spends relationship capital</div>}
              </td>
              <td>{t.personName ?? "—"}</td>
              <td className="small">{t.tripTitle ?? "—"}</td>
              <td className="small">
                {t.assigneeName ?? "—"}
                <div className="muted">{ROUTE_LABEL[t.route]}</div>
              </td>
              <td>
                <span className={`chip ${t.captureMode === "recorded" ? "warn" : ""}`}>{t.captureMode}</span>
              </td>
              <td>
                <span className={`chip ${t.status === "open" ? "warn" : t.status === "done" ? "ok" : ""}`}>{t.status}</span>
                {t.scope === "private" && <div className="small muted">private</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <main>
      <div className="row">
        <h1 className="grow">Calls</h1>
        <Link className="btn" href="/calls/settings">
          Consent &amp; retention
        </Link>
        <Link className="btn primary" href="/calls/new">
          New call task
        </Link>
      </div>
      <p className="lede">
        Calls that spend relationship capital go to the person who holds the relationship; routine confirmations can go to a delegate. Every call ends as a
        commitment record, recorded or not.
      </p>
      {error && <p className="notice error">{error}</p>}
      <div className="row small">
        {(["open", "done", "canceled", "all"] as const).map((s) => (
          <Link key={s} href={`/calls?status=${s}`} className={`chip ${(status ?? "all") === s ? "ok" : ""}`}>
            {s}
          </Link>
        ))}
      </div>

      <h2>For you</h2>
      {mine.length ? table(mine) : <p className="empty">Nothing assigned to you.</p>}
      <h2>Others you can see</h2>
      {others.length ? table(others) : <p className="empty">None.</p>}
    </main>
  );
}
