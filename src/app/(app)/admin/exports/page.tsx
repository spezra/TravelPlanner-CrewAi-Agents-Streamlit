import { getDb, requireMember } from "@/lib/server";
import { listMyExports } from "@/modules/ops/exports";
import { requestExportAction } from "../actions";
import { AdminNav } from "../AdminNav";

export const metadata = { title: "Data export" };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { ready: "ok", queued: "warn", failed: "alert" };

export default async function ExportsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { tenant } = await requireMember(["owner", "admin"]);
  const exports = await listMyExports(await getDb(), tenant);
  const now = new Date();

  return (
    <main>
      <h1>Data export</h1>
      <AdminNav current="/admin/exports" />
      <p className="lede">
        A JSON file of everything in this workspace that you can see, with encrypted fields decrypted for you. Only you can download it, once; it is deleted
        after download or after 7 days.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      <form action={requestExportAction} className="card row">
        <span className="grow small">Prepares in the background; refresh this page to check.</span>
        <button className="btn primary">Prepare export</button>
      </form>
      <div className="card table-wrap">
        {exports.length === 0 ? (
          <p className="empty">No exports.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Scope</th>
                <th>Status</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {exports.map((e) => (
                <tr key={e.id}>
                  <td className="small">{e.createdAt.slice(0, 16).replace("T", " ")}</td>
                  <td className="small">{e.subjectType ? `one ${e.subjectType.replace("_", " ")} (access request)` : "workspace"}</td>
                  <td>
                    <span className={`chip ${TONE[e.status] ?? ""}`}>{e.status}</span>
                    {e.error && <div className="small muted">{e.error}</div>}
                  </td>
                  <td className="small">{e.expiresAt.slice(0, 10)}</td>
                  <td>
                    {e.status === "ready" && new Date(e.expiresAt) > now && (
                      <a className="btn small primary" href={`/api/ops/exports/${e.id}`}>
                        Download{e.bytes ? ` (${Math.max(1, Math.round(e.bytes / 1024))} KB)` : ""}
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
