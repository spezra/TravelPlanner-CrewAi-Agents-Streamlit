import Link from "next/link";
import { withTenant } from "@/db/tenant";
import type { TrustTier } from "@/domain/knowledge";
import { getDb, requireMember } from "@/lib/server";
import { listObservations, listSuppliers, supplierView } from "@/modules/network/observations";
import { createObservationAction } from "../actions";
import { ObservationForm } from "../observationForm";
import { Flash, KnowledgeNav } from "../subnav";

export const metadata = { title: "Suppliers" };
export const dynamic = "force-dynamic";

const TIER: Record<TrustTier, { label: string; tone: string }> = {
  retain: { label: "noted only: not enough to recommend", tone: "chip" },
  recommend: { label: "can back a recommendation", tone: "chip ok" },
  commit: { label: "can be told to the traveler", tone: "chip ok" },
};

type Search = { s?: string; q?: string; program?: string; room?: string; season?: string; rel?: string; error?: string; ok?: string };

export default async function Suppliers({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const me = await requireMember();
  const now = new Date();
  const supplier = sp.s?.trim() || null;
  const { suppliers, observations } = await withTenant(await getDb(), me.tenant, async (q) => ({
    suppliers: supplier ? [] : await listSuppliers(q, sp.q),
    observations: supplier ? await listObservations(q, supplier) : [],
  }));
  const filter = {
    program: sp.program || null,
    roomCategory: sp.room || null,
    season: sp.season || null,
    relationshipInvolved: sp.rel === "yes" ? true : sp.rel === "no" ? false : null,
  };
  const view = supplier ? supplierView(observations, now, filter) : null;
  const today = now.toISOString().slice(0, 10);
  const back = supplier ? `/knowledge/suppliers?s=${encodeURIComponent(supplier)}` : "/knowledge/suppliers";

  return (
    <main>
      <h1>{supplier ?? "Suppliers"}</h1>
      <p className="lede">
        Dated observations, each with its source and what was actually validated. “Not personally inspected” is an honest status, not a defect; a
        supplier claim is kept, but never becomes a promise to a traveler.
      </p>
      <KnowledgeNav current="/knowledge/suppliers" />
      <Flash error={sp.error} ok={sp.ok} />

      {!supplier && (
        <>
          <form className="row" action="/knowledge/suppliers">
            <input type="text" name="q" defaultValue={sp.q ?? ""} placeholder="Find a supplier" className="grow" style={{ width: "auto" }} />
            <button className="btn">Search</button>
          </form>
          {suppliers.length === 0 ? (
            <p className="empty">No observations yet.</p>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th>Observations</th>
                    <th>Failed requests</th>
                    <th>Latest</th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => (
                    <tr key={s.supplierName}>
                      <td>
                        <Link href={`/knowledge/suppliers?s=${encodeURIComponent(s.supplierName)}`}>{s.supplierName}</Link>
                      </td>
                      <td>{s.count}</td>
                      <td>{s.failures}</td>
                      <td>{s.lastObservedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {view && supplier && (
        <>
          <p className="small">
            <Link href="/knowledge/suppliers">← All suppliers</Link>
            {" · "}
            {view.inspected ? "Personally inspected by your team" : <b>Not personally inspected</b>}
            {view.lastObservedAt && ` · latest observation ${view.lastObservedAt}`}
          </p>

          <h2>Request track record</h2>
          <form className="row small" action="/knowledge/suppliers">
            <input type="hidden" name="s" value={supplier} />
            <select name="program" defaultValue={filter.program ?? ""} aria-label="Program">
              <option value="">Any program</option>
              {view.options.programs.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select name="room" defaultValue={filter.roomCategory ?? ""} aria-label="Room category">
              <option value="">Any room category</option>
              {view.options.roomCategories.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select name="season" defaultValue={filter.season ?? ""} aria-label="Season">
              <option value="">Any season</option>
              {view.options.seasons.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select name="rel" defaultValue={sp.rel ?? ""} aria-label="Relationship involvement">
              <option value="">With or without a relationship</option>
              <option value="no">Without a relationship</option>
              <option value="yes">Through a relationship</option>
            </select>
            <button className="btn small">Apply</button>
          </form>
          {view.trackRecords.length === 0 ? (
            <p className="empty">No requests recorded.</p>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Granted</th>
                    <th>Partial</th>
                    <th>Denied</th>
                    <th>Through a relationship</th>
                  </tr>
                </thead>
                <tbody>
                  {view.trackRecords.map((t) => (
                    <tr key={t.request}>
                      <td>{t.request.replace(/_/g, " ")}</td>
                      <td>{t.granted}</td>
                      <td>{t.partial}</td>
                      <td>{t.denied}</td>
                      <td>
                        {t.relationshipDependent} of {t.total}
                        {t.total > 0 && t.relationshipDependent === t.total && <span className="chip warn">may not transfer</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>Observations</h2>
          {view.observations.length === 0 && <p className="empty">No observations visible to you.</p>}
          {view.observations.map((o) => (
            <section key={o.id} className="card">
              <div className="row">
                <span className="small">{o.provenance}</span>
                <span className={TIER[o.tier].tone}>
                  {TIER[o.tier].label}
                  {o.tier === "commit" && o.bookingRef ? ` (booking ${o.bookingRef})` : ""}
                </span>
                <span className="grow" />
                {o.ownerId === me.tenant.memberId && (
                  <Link className="small" href={`/knowledge/observations/${o.id}`}>
                    Edit
                  </Link>
                )}
              </div>
              <p>{o.statement}</p>
              <div className="small muted">
                {[
                  o.applicability.program && `program ${o.applicability.program}`,
                  o.applicability.roomCategory && `room ${o.applicability.roomCategory}`,
                  o.applicability.season && `season ${o.applicability.season}`,
                  o.applicability.relationshipInvolved && "through a relationship",
                  o.request && `asked for ${o.request.replace(/_/g, " ")}: ${o.outcome ?? "no outcome yet"}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {` · recorded by ${o.ownerName}${o.scope === "private" ? " (private)" : ""}`}
              </div>
              {o.hasPhoto && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/knowledge/photos/${o.id}`} alt={`Photo: ${o.statement.slice(0, 80)}`} style={{ maxWidth: "100%", maxHeight: 320, marginTop: 8, borderRadius: 6 }} />
              )}
            </section>
          ))}
        </>
      )}

      <h2>Record an observation</h2>
      <ObservationForm action={createObservationAction} submitLabel="Save observation" back={back} supplier={supplier ?? undefined} today={today} />
    </main>
  );
}
