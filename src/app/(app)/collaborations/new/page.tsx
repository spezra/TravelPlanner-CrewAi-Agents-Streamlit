import Link from "next/link";
import { notFound } from "next/navigation";
import { listTrips } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import type { ContributionType } from "@/domain/collaboration";
import { CONTRIBUTION_LABEL } from "@/domain/collaborationTerms";
import { getDb, requireMember } from "@/lib/server";
import { getNetworkProfile, membership } from "@/modules/network/membership";
import { requestAction } from "../actions";

export const metadata = { title: "Ask for help" };
export const dynamic = "force-dynamic";

export default async function NewCollaboration({ searchParams }: { searchParams: Promise<{ to?: string; need?: string; error?: string }> }) {
  const sp = await searchParams;
  const me = await requireMember(["owner", "advisor", "admin"]);
  if (!sp.to || !/^[0-9a-f-]{36}$/i.test(sp.to)) notFound();
  const data = await withTenant(await getDb(), me.tenant, async (q) => ({
    m: await membership(q),
    profile: await getNetworkProfile(q, sp.to!),
    trips: await listTrips(q),
  }));
  if (data.m.status !== "admitted" || !data.profile) notFound();
  const p = data.profile;
  const need = p.capabilities.includes(sp.need as ContributionType) ? (sp.need as ContributionType) : p.capabilities[0];

  return (
    <main className="narrow">
      <p className="small">
        <Link href="/network">← Network</Link>
      </p>
      <h1>Ask {p.displayName}</h1>
      <p className="lede">
        They'll see an anonymized brief: your client's name and every name, contact, room number, price and link your workspace knows are removed before it
        leaves. Client details are shared only after you both accept the same terms.
      </p>
      {sp.error && <p className="notice error">{sp.error}</p>}
      <form action={requestAction} className="card">
        <input type="hidden" name="to" value={p.memberId} />
        <label htmlFor="contribution">What you need</label>
        <select id="contribution" name="contribution" className="field" defaultValue={need}>
          {p.capabilities.map((c) => (
            <option key={c} value={c}>
              {CONTRIBUTION_LABEL[c]}
            </option>
          ))}
        </select>
        <label htmlFor="tripId">For trip (optional; its client's name is removed from the brief)</label>
        <select id="tripId" name="tripId" className="field" defaultValue="">
          <option value="">Not linked to a trip</option>
          {data.trips.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <label htmlFor="destination">Destination</label>
        <input id="destination" type="text" name="destination" maxLength={120} defaultValue={p.destinations[0] ?? ""} />
        <label htmlFor="text">Brief</label>
        <textarea id="text" name="text" required maxLength={6000} placeholder="What the trip should feel like, what you need from them, and by when" />
        <div className="grid2">
          <div>
            <label htmlFor="partySize">Party size</label>
            <input id="partySize" type="number" name="partySize" min={1} max={200} defaultValue={2} required />
          </div>
          <div>
            <label htmlFor="budgetBand">Budget band</label>
            <input id="budgetBand" type="text" name="budgetBand" maxLength={80} placeholder="e.g. Upper luxury" />
          </div>
        </div>
        <label htmlFor="dates">Timing</label>
        <input id="dates" type="text" name="dates" maxLength={80} placeholder="e.g. Late January, 3 nights" />
        <div className="actions">
          <button className="btn primary">Send request</button>
        </div>
      </form>
    </main>
  );
}
