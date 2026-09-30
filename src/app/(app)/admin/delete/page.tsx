import { getDb, requireMember } from "@/lib/server";
import { getSettings } from "@/modules/ops/admin";
import { deleteWorkspaceAction } from "../actions";
import { AdminNav } from "../AdminNav";

export const metadata = { title: "Delete workspace" };
export const dynamic = "force-dynamic";

export default async function DeletePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { tenant, member } = await requireMember(["owner", "admin"]);
  const s = await getSettings(await getDb(), tenant);

  return (
    <main>
      <h1>Delete workspace</h1>
      <AdminNav current="/admin/delete" />
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      <div className="card narrow">
        <p>Deleting the workspace:</p>
        <ul className="small">
          <li>destroys its encryption keys, so every encrypted note, transcript, token and stored file becomes permanently unreadable;</li>
          <li>deletes its stored exports;</li>
          <li>removes every member&apos;s access and signs them out of it;</li>
          <li>stops its background work.</li>
        </ul>
        <p className="small muted">Take a data export first if you need one. This can&apos;t be undone.</p>
        {s.deletionRequestedAt ? (
          <p className="notice error">Deletion was requested {s.deletionRequestedAt.slice(0, 16).replace("T", " ")} UTC and is in progress.</p>
        ) : member.role !== "owner" ? (
          <p className="notice">Only an owner can delete the workspace.</p>
        ) : (
          <form action={deleteWorkspaceAction}>
            <label htmlFor="confirmName">
              Type <b>{s.name}</b> to confirm
            </label>
            <input id="confirmName" name="confirmName" type="text" required autoComplete="off" />
            <div className="actions">
              <button className="btn primary" style={{ background: "var(--alert)", borderColor: "var(--alert)" }}>
                Delete this workspace
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
