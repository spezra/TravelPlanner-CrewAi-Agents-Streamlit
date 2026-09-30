import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { invite, removeMember, signOutEverywhere } from "./actions";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { member, tenant } = await requireMember();
  const canManage = member.role === "owner" || member.role === "admin";
  const { members, invitations, workspace } = await withTenant(await getDb(), tenant, async (q) => ({
    members: (
      await q.query<{ id: string; name: string; email: string; role: string; disabled_at: string | null }>(
        "select id, name, email, role, disabled_at from members order by disabled_at nulls first, name",
      )
    ).rows,
    invitations: (
      await q.query<{ email: string; role: string; expires_at: string }>(
        "select email, role, expires_at from invitations where accepted_at is null and revoked_at is null and expires_at > now() order by created_at desc",
      )
    ).rows,
    workspace: (await q.query<{ name: string; book_portability: string; data_region: string }>("select name, book_portability, data_region from workspaces")).rows[0],
  }));

  return (
    <main>
      <h1>Settings</h1>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <h2>Workspace</h2>
      <div className="card small">
        <div>{workspace?.name}</div>
        <div className="muted">
          Book portability: {workspace?.book_portability.replace("_", " ")} · data region: {workspace?.data_region.toUpperCase()}
        </div>
      </div>

      <h2>Team</h2>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>
                  <span className="chip">{m.disabled_at ? "removed" : m.role}</span>
                </td>
                <td>
                  {member.role === "owner" && m.id !== member.id && !m.disabled_at && (
                    <form action={removeMember}>
                      <input type="hidden" name="memberId" value={m.id} />
                      <button className="btn small">Remove</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <>
          <h3>Invite</h3>
          <form action={invite} className="card">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" name="email" required />
            <label htmlFor="role">Role</label>
            <select id="role" name="role" className="field" defaultValue="assistant">
              <option value="advisor">Advisor</option>
              <option value="assistant">Assistant (prepares; can't approve spend)</option>
              <option value="admin">Admin</option>
              {member.role === "owner" && <option value="owner">Owner</option>}
            </select>
            <div className="actions">
              <button className="btn primary">Send invitation</button>
            </div>
          </form>
          {invitations.length > 0 && (
            <div className="card small">
              <b>Pending</b>
              <ul className="plain">
                {invitations.map((i) => (
                  <li key={i.email}>
                    {i.email} · {i.role} · expires {String(i.expires_at).slice(0, 10)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <h2>Security</h2>
      <form action={signOutEverywhere} className="card row">
        <span className="grow small">Sign out of every device, including this one.</span>
        <button className="btn">Sign out everywhere</button>
      </form>
    </main>
  );
}
