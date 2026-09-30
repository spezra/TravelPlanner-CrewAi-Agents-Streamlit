import Link from "next/link";
import { listPeople } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { CATEGORY_LABEL, listMyItems, listWorkspaceKnowledge } from "@/modules/network/knowledge";
import { listObservations } from "@/modules/network/observations";
import { createItemAction } from "./actions";
import { ItemForm } from "./itemForm";
import { Flash, KnowledgeNav, statusChip } from "./subnav";

export const metadata = { title: "Knowledge" };
export const dynamic = "force-dynamic";

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const { items, shared, observations, people } = await withTenant(await getDb(), me.tenant, async (q) => ({
    items: await listMyItems(q),
    shared: await listWorkspaceKnowledge(q),
    observations: (await listObservations(q)).filter((o) => o.ownerId === me.tenant.memberId).slice(0, 40),
    people: (await listPeople(q)).filter((p) => p.ownerId === me.tenant.memberId),
  }));
  const pending = items.filter((i) => i.publicationStatus === "awaiting_owner").length;
  const fromColleagues = shared.filter((s) => !items.some((i) => i.id === s.itemId));

  return (
    <main>
      <h1>Knowledge</h1>
      <p className="lede">
        Your knowledge is part of your livelihood. It stays yours unless you publish it: permission first, then redaction, then your approval (or a
        standing rule you set).
      </p>
      <KnowledgeNav current="/knowledge" pending={pending} />
      <Flash error={error} ok={ok} />

      <h2>My items</h2>
      {items.length === 0 ? (
        <p className="empty">Nothing recorded yet.</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Permission · confidentiality · confidence</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((k) => (
                <tr key={k.id}>
                  <td>
                    <Link href={`/knowledge/${k.id}`}>{k.body.length > 90 ? `${k.body.slice(0, 90)}…` : k.body}</Link>
                    {k.destination && <div className="small muted">{k.destination}</div>}
                  </td>
                  <td className="small">{CATEGORY_LABEL[k.category]}</td>
                  <td className="small">
                    {k.sharingPermission} · {k.confidentiality} · {k.confidence}
                  </td>
                  <td>{statusChip(k)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Record something you know</h2>
      <ItemForm
        action={createItemAction}
        submitLabel="Save privately"
        observations={observations.map((o) => ({ id: o.id, label: `${o.supplierName}, ${o.observedAt}: ${o.statement.slice(0, 60)}` }))}
        people={people.map((p) => ({ id: p.id, name: p.name }))}
      />

      <h2>Shared by colleagues</h2>
      {fromColleagues.length === 0 ? (
        <p className="empty">Nothing published inside the workspace yet.</p>
      ) : (
        <div className="grid2">
          {fromColleagues.map((k) => (
            <section key={k.id} className="card small">
              <div className="row">
                <span className="chip">{CATEGORY_LABEL[k.category]}</span>
                {k.destination && <span className="muted">{k.destination}</span>}
                <span className="grow" />
                <span className="muted">confidence {k.confidence}</span>
              </div>
              <p>{k.body}</p>
              <div className="muted">
                {k.author} · {k.publishedAt.slice(0, 10)} · {k.scope}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
