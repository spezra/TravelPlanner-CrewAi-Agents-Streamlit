import Link from "next/link";
import { notFound } from "next/navigation";
import { agentsConfigured } from "@/agents/llm";
import { getTrip } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { listProposals, reviewFor } from "@/modules/proposals/service";
import { blankAction, draftAction, saveAction, sendAction, styleSampleAction } from "./actions";

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
    return { trip, proposals, current, issues: current ? await reviewFor(q, current) : [] };
  });
  if (!data) notFound();
  const { trip, proposals, current, issues } = data;
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
