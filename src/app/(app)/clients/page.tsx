import Link from "next/link";
import { clientScopeRules } from "@/domain/clientBook";
import { getDb, requireMember } from "@/lib/server";
import { getSettings } from "@/modules/ops/admin";
import { listClients } from "@/modules/ops/clients";
import { createClientAction } from "./actions";

export const metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

const PORTABILITY: Record<string, string> = {
  advisor_owns: "Advisors own their book: new clients are private to you unless you share them.",
  agency_owns: "The agency owns the book: every client is visible across the workspace.",
  shared: "Shared book: clients are workspace-wide by default; you can keep one private.",
};

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { tenant, member } = await requireMember();
  const db = await getDb();
  const [clients, settings] = await Promise.all([listClients(db, tenant), getSettings(db, tenant)]);
  const rules = clientScopeRules(settings.bookPortability);

  return (
    <main>
      <h1>Clients</h1>
      <p className="lede">{PORTABILITY[settings.bookPortability]}</p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <div className="card table-wrap">
        {clients.length === 0 ? (
          <p className="empty">No clients yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Held by</th>
                <th>Visible to</th>
                <th>Trips</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/clients/${c.id}`}>{c.name}</Link>
                    {c.erased && <span className="chip"> erased</span>}
                  </td>
                  <td>{c.ownerId === member.id ? "You" : c.ownerName}</td>
                  <td>
                    <span className="chip">{c.scope === "private" ? "holder and delegates" : "workspace"}</span>
                  </td>
                  <td>{c.tripCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>New client</h2>
      <form action={createClientAction} className="card narrow">
        <label htmlFor="name">Name (as you address them, e.g. "The Whitfields")</label>
        <input id="name" name="name" type="text" required minLength={2} maxLength={200} />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" />
        <label htmlFor="phone">Phone</label>
        <input id="phone" name="phone" type="text" />
        <label htmlFor="notes">Private notes (encrypted)</label>
        <textarea id="notes" name="notes" />
        {rules.allowed.length > 1 && (
          <>
            <label htmlFor="scope">Visible to</label>
            <select id="scope" name="scope" className="field" defaultValue={rules.defaultScope}>
              <option value="private">You and your named delegates</option>
              <option value="workspace">Everyone in the workspace</option>
            </select>
          </>
        )}
        <div className="actions">
          <button className="btn primary">Add client</button>
        </div>
      </form>
    </main>
  );
}
