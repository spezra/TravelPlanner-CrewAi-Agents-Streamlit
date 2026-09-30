import { listLedger, listPeople } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { currentRole, nudges, warmthEvidence } from "@/domain/crm";
import { getDb, requireMember } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function People() {
  const me = await requireMember();
  const now = new Date();
  const { people, ledger } = await withTenant(await getDb(), me.tenant, async (q) => ({ people: await listPeople(q), ledger: await listLedger(q) }));

  return (
    <main>
      <h1>Relationships</h1>
      <p className="lede">
        People, not properties: the relationship follows the person when they move. Warmth is shown as evidence, not a score. The agent drafts; you send
        under your own name.
      </p>
      {people.length === 0 && <p className="empty">No relationships visible to you.</p>}
      <div className="grid2">
        {people.map((p) => {
          const mine = ledger.filter((e) => e.personId === p.id);
          const w = warmthEvidence(mine, now);
          const role = currentRole(p);
          const ns = p.ownerId === me.tenant.memberId ? nudges(p, mine, now) : [];
          return (
            <section key={p.id} className="card">
              <h3>{p.name}</h3>
              <div className="small muted">
                {role ? `${role.title}, ${role.organization}` : "No current role"}
                {role?.measuredOn ? ` · measured on ${role.measuredOn}` : ""}
              </div>
              {p.roles.length > 1 && (
                <div className="small muted">
                  Previously:{" "}
                  {p.roles
                    .filter((r) => r.to !== null)
                    .map((r) => `${r.title}, ${r.organization}`)
                    .join("; ")}
                </div>
              )}
              <ul className="plain small" style={{ marginTop: 8 }}>
                <li>
                  Reach via {p.approach.channel ?? "—"} · {p.approach.language ?? "—"} · {p.approach.timeZone ?? "—"}
                  {p.approach.goingOverTheirHeadAcceptable ? "" : " · never go over their head"}
                </li>
                <li>
                  Last touch {w.lastTouch ? w.lastTouch.slice(0, 10) : "never"} · {w.favorsAsked} asks / {w.favorsGranted} granted · {w.businessSent} bookings (
                  {w.roomNights} nights) · {w.recognitionGiven} recognition
                </li>
                {p.texture.map((t) => (
                  <li key={t} className="muted">
                    “{t}”
                  </li>
                ))}
              </ul>
              {ns.map((n) => (
                <div key={n.kind} className="rec">
                  <b>Nudge:</b> {n.message}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </main>
  );
}
