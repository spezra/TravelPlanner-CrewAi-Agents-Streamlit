import Link from "next/link";
import { listPeople, listTrips } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { currentRole } from "@/domain/crm";
import { getDb, requireMember } from "@/lib/server";
import { createTaskAction } from "../actions";

export const metadata = { title: "New call task" };
export const dynamic = "force-dynamic";

export default async function NewCallTask({ searchParams }: { searchParams: Promise<{ error?: string; trip?: string; person?: string }> }) {
  const { error, trip, person } = await searchParams;
  const me = await requireMember();
  const { trips, people } = await withTenant(await getDb(), me.tenant, async (q) => ({ trips: await listTrips(q), people: await listPeople(q) }));

  return (
    <main className="narrow">
      <p className="small">
        <Link href="/calls">← Calls</Link>
      </p>
      <h1>New call task</h1>
      <p className="lede">
        Prepare the ask, the leverage, the fallback and what counts as done. The system routes it: calls that spend relationship capital go to whoever holds the
        relationship.
      </p>
      {error && <p className="notice error">{error}</p>}
      <form action={createTaskAction} className="card">
        <label htmlFor="tripId">Trip</label>
        <select id="tripId" name="tripId" className="field" defaultValue={trips.some((t) => t.id === trip) ? trip : ""}>
          <option value="">No trip</option>
          {trips.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>

        <label htmlFor="personId">Supplier contact</label>
        <select id="personId" name="personId" className="field" defaultValue={people.some((p) => p.id === person) ? person : ""}>
          <option value="">Nobody in the relationship records</option>
          {people.map((p) => {
            const role = currentRole(p);
            return (
              <option key={p.id} value={p.id}>
                {p.name}
                {role ? ` — ${role.title}, ${role.organization}` : ""}
              </option>
            );
          })}
        </select>

        <label htmlFor="purpose">Purpose</label>
        <input id="purpose" name="purpose" type="text" required maxLength={300} placeholder="Secure the garden casita for the anniversary stay" />
        <label htmlFor="ask">The ask</label>
        <textarea id="ask" name="ask" required maxLength={2000} style={{ minHeight: 70 }} />
        <label htmlFor="leverage">Leverage</label>
        <textarea id="leverage" name="leverage" maxLength={2000} style={{ minHeight: 60 }} placeholder="Business sent, recognition given, why this matters to them" />
        <label htmlFor="fallback">Fallback</label>
        <textarea id="fallback" name="fallback" maxLength={2000} style={{ minHeight: 60 }} />
        <label htmlFor="doneWhen">What counts as done</label>
        <input id="doneWhen" name="doneWhen" type="text" required maxLength={1000} placeholder="Written confirmation of the room and rate" />

        <label htmlFor="importance">How much it matters to this trip</label>
        <select id="importance" name="importance" className="field" defaultValue="routine">
          <option value="routine">Routine</option>
          <option value="important">Important</option>
          <option value="critical">Critical</option>
        </select>
        <label className="row" style={{ color: "inherit" }}>
          <input type="checkbox" name="spendsRelationshipCapital" /> This ask spends relationship capital (a favor, an appeal). It stays with the relationship
          holder.
        </label>
        <label className="row" style={{ color: "inherit" }}>
          <input type="checkbox" name="automationPermitted" /> Routine confirmation: may be offered to disclosed automation
        </label>
        <label htmlFor="scope">Visibility</label>
        <select id="scope" name="scope" className="field" defaultValue="private">
          <option value="private">Private: the relationship holder, the assignee and members authorized on the trip</option>
          <option value="workspace">Workspace</option>
        </select>

        <h3 style={{ marginTop: 20 }}>Parties</h3>
        <p className="small muted">
          Jurisdiction codes like US-CA or FR. Leave blank if unknown: the stricter all-party rule applies. You can add people who join or take a transfer later.
        </p>
        {[
          { side: "ours", name: me.member.name, label: "Our side" },
          { side: "theirs", name: "", label: "Their side" },
          { side: "theirs", name: "", label: "Another party (optional)" },
        ].map((p, i) => (
          <div key={i} className="grid2">
            <div>
              <label htmlFor={`partyName${i}`}>{p.label}</label>
              <input id={`partyName${i}`} name="partyName" type="text" defaultValue={p.name} maxLength={200} />
              <input type="hidden" name="partySide" value={p.side} />
            </div>
            <div>
              <label htmlFor={`partyJurisdiction${i}`}>Jurisdiction</label>
              <input id={`partyJurisdiction${i}`} name="partyJurisdiction" type="text" maxLength={10} placeholder="US-CA" />
            </div>
          </div>
        ))}
        <div className="actions">
          <button className="btn primary">Create call task</button>
        </div>
      </form>
    </main>
  );
}
