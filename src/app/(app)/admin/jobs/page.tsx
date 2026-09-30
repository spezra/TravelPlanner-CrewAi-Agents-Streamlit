import { getDb, requireMember } from "@/lib/server";
import { failedJobs } from "@/modules/ops/admin";
import { retryJobAction } from "../actions";
import { AdminNav } from "../AdminNav";

export const metadata = { title: "Failed jobs" };
export const dynamic = "force-dynamic";

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { tenant } = await requireMember(["owner", "admin"]);
  const jobs = await failedJobs(await getDb(), tenant);

  return (
    <main>
      <h1>Failed background work</h1>
      <AdminNav current="/admin/jobs" />
      <p className="lede">Work for this workspace that ran out of retries or failed permanently. Retrying runs it again from the start; every job is safe to repeat.</p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      <div className="card table-wrap">
        {jobs.length === 0 ? (
          <p className="empty">Nothing has failed.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Failed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    {j.kind} <span className="chip alert">{j.status}</span>
                    <div className="small muted">#{j.id}</div>
                  </td>
                  <td>
                    {j.attempts}/{j.maxAttempts}
                  </td>
                  <td className="small" style={{ maxWidth: 380, overflowWrap: "anywhere" }}>
                    {j.lastError ?? "—"}
                  </td>
                  <td className="small">{(j.finishedAt ?? j.createdAt).slice(0, 16).replace("T", " ")}</td>
                  <td>
                    <form action={retryJobAction}>
                      <input type="hidden" name="jobId" value={j.id} />
                      <button className="btn small">Retry</button>
                    </form>
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
