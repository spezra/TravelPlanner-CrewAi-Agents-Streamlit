import Link from "next/link";
import { notFound } from "next/navigation";
import { agentsConfigured } from "@/agents/llm";
import { getTrip } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import type { ScoutedOption } from "@/agents/optionScout";
import { listProposals, listShortlists, reviewFor } from "@/modules/proposals/service";
import { blankAction, draftAction, saveAction, scoutAction, sendAction, styleSampleAction } from "./actions";

export const metadata = { title: "Proposal" };
export const dynamic = "force-dynamic";

export default async function ProposalPage({ params, searchParams }: { params: Promise<{ tripId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { tripId } = await params;
  const { error, ok } = await searchParams;
  const { tenant } = await requireMember();
  const data = await withTenant(await getDb(), tenant, async (q) => {
    const trip = await getTrip(q, tripId);
    if (!trip) return null;
    const proposals = await listProposals(q, tripId);
    const current = proposals[0] ?? null;
    return { trip, proposals, current, issues: current ? await reviewFor(q, current) : [], shortlists: await listShortlists(q, tripId) };
  });
  if (!data) notFound();
  const { trip, proposals, current, issues, shortlists } = data;
  const isOwner = trip.ownerId === tenant.memberId;

  return (
    <main>
      <h1>Proposal · {trip.title}</h1>
      <p className="lede">
        Agents draft from your own taste notes, observations and the client brief; you edit and send. <Link href={`/trips/${trip.id}`}>Back to trip</Link>
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <div className="actions">
        {agentsConfigured() && (
          <form action={draftAction}>
            <input type="hidden" name="tripId" value={trip.id} />
            <button className="btn primary">Draft with agent</button>
          </form>
        )}
        <form action={blankAction}>
          <input type="hidden" name="tripId" value={trip.id} />
          <button className="btn">Start from trip items</button>
        </form>
      </div>

      {!current ? (
        <p className="empty" style={{ marginTop: 16 }}>
          No proposal yet.
        </p>
      ) : (
        <>
          <h2>
            Version {current.version} <span className="chip">{current.status}</span> {current.createdBy === "agent:proposals" && !current.editedByExpert && <span className="chip warn">agent draft, unedited</span>}
          </h2>
          {issues.length > 0 && (
            <div className="card">
              {issues.map((i, n) => (
                <div key={n} className={`small ${i.severity === "block" ? "chip alert" : "muted"}`} style={{ display: "block", marginBottom: 4 }}>
                  {i.severity === "block" ? "Must fix" : "Check"} · {i.section}: {i.message}
                </div>
              ))}
            </div>
          )}
          <form action={saveAction} className="card">
            <input type="hidden" name="tripId" value={trip.id} />
            <input type="hidden" name="proposalId" value={current.id} />
            <label htmlFor="title">Title</label>
            <input id="title" type="text" name="title" defaultValue={current.title} />
            <label htmlFor="intro">Introduction</label>
            <textarea id="intro" name="intro" defaultValue={current.intro} />
            {current.sections.map((s) => (
              <fieldset key={s.key} style={{ border: 0, padding: 0, marginTop: 16 }}>
                <label htmlFor={`${s.key}.h`}>Section heading</label>
                <input id={`${s.key}.h`} type="text" name={`section.${s.key}.heading`} defaultValue={s.heading} />
                <label htmlFor={`${s.key}.b`}>Section text</label>
                <textarea id={`${s.key}.b`} name={`section.${s.key}.body`} defaultValue={s.body} />
                {s.recommendations.map((r) => (
                  <div key={r.subject} className="small muted">
                    <b>{r.subject}</b> — {r.why} · evidence: {r.evidence ? r.evidence.provenance : "none recorded"}
                    {r.alternatives.length > 0 && <> · considered: {r.alternatives.map((a) => `${a.subject} (${a.whyNot})`).join("; ")}</>}
                  </div>
                ))}
              </fieldset>
            ))}
            <label htmlFor="closing">Closing</label>
            <textarea id="closing" name="closing" defaultValue={current.closing} />
            <div className="actions">
              <button className="btn">Save</button>
            </div>
          </form>
          {isOwner && (current.status === "draft" || current.status === "ready") && (
            <form action={sendAction}>
              <input type="hidden" name="tripId" value={trip.id} />
              <input type="hidden" name="proposalId" value={current.id} />
              <button className="btn primary">Send to client portal</button>
            </form>
          )}
          {proposals.length > 1 && (
            <p className="small muted">
              Earlier versions: {proposals.slice(1).map((p) => `v${p.version} (${p.status})`).join(", ")}
            </p>
          )}
        </>
      )}

      {agentsConfigured() && (
        <>
          <h2>Options from your knowledge</h2>
          <form action={scoutAction} className="card">
            <input type="hidden" name="tripId" value={trip.id} />
            <label htmlFor="need">What do you need options for?</label>
            <input id="need" type="text" name="need" placeholder="Quiet hotel in Oaxaca for 5 nights, walkable to the centre" />
            <div className="actions">
              <button className="btn">Prepare shortlist</button>
            </div>
          </form>
          {shortlists.map((s) => {
            const r = s.result as { options: ScoutedOption[]; gap: string | null; suggestNetwork: boolean } | null;
            return (
              <section key={s.id} className="card">
                <div className="row">
                  <b className="grow">{s.need}</b>
                  <span className="chip">{s.status}</span>
                </div>
                {r?.options.map((o) => (
                  <div key={o.supplier} className="small" style={{ marginTop: 6 }}>
                    <b>{o.supplier}</b> <span className={`chip ${o.bestTier === "retain" ? "warn" : "ok"}`}>{o.bestTier}</span> — {o.fit}
                    {o.concerns && <span className="muted"> · {o.concerns}</span>}
                    <div className="muted">{o.evidence.map((e) => e.provenance).join("; ") || "no linked observation"}</div>
                  </div>
                ))}
                {r?.gap && <p className="small muted">Gap: {r.gap}</p>}
                {r?.suggestNetwork && <p className="small">Your own records are thin here — consider asking a network specialist.</p>}
              </section>
            );
          })}
        </>
      )}

      <h2>Your writing</h2>
      <form action={styleSampleAction} className="card">
        <input type="hidden" name="tripId" value={trip.id} />
        <label htmlFor="body">Paste a past proposal or client email so drafts sound like you (private to you)</label>
        <textarea id="body" name="body" />
        <div className="actions">
          <button className="btn">Save sample</button>
        </div>
      </form>
    </main>
  );
}
