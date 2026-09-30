import Link from "next/link";
import { notFound } from "next/navigation";
import { agentsConfigured } from "@/agents/llm";
import { getTrip, listItems } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import type { ReasonCategory } from "@/domain/judgment";
import { getDb, requireMember } from "@/lib/server";
import { listTripDecisions, REASON_LABEL, TARGET_LABEL } from "@/modules/ops/judgment";
import { recordDecisionAction } from "../../actions";
import { AnswerForm } from "../../AnswerForm";

export const metadata = { title: "Decisions" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, [string, string]> = {
  learned: ["learned", "ok"],
  classifying: ["reading the conversation", "warn"],
  awaiting_answer: ["question for you", "warn"],
  unexplained: ["no reason recorded", ""],
  failed: ["couldn't classify", "alert"],
  recorded: ["recorded", ""],
};

function ReasonFields({ id, agents }: { id: string; agents: boolean }) {
  return (
    <details className="small">
      <summary className="muted">Why (optional)</summary>
      <label htmlFor={`cat-${id}`}>Reason</label>
      <select id={`cat-${id}`} name="category" className="field" defaultValue="">
        <option value="">Not saying now</option>
        {(Object.keys(REASON_LABEL) as ReasonCategory[]).map((c) => (
          <option key={c} value={c}>
            {REASON_LABEL[c]}
          </option>
        ))}
      </select>
      <label htmlFor={`rt-${id}`}>In your words</label>
      <input id={`rt-${id}`} name="reasonText" type="text" maxLength={500} />
      <label htmlFor={`vu-${id}`}>Supplier condition lasts until</label>
      <input id={`vu-${id}`} name="validUntil" type="date" />
      <label htmlFor={`cv-${id}`}>
        {agents ? "Or paste the conversation it happened in; the agent will find the reason" : "Conversation or notes (kept, encrypted, for context)"}
      </label>
      <textarea id={`cv-${id}`} name="conversation" maxLength={50_000} style={{ minHeight: 70 }} />
    </details>
  );
}

export default async function TripDecisionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const { tenant, member } = await requireMember();
  const db = await getDb();
  const data = await withTenant(db, tenant, async (q) => {
    const trip = await getTrip(q, id);
    return trip ? { trip, items: await listItems(q, id) } : null;
  });
  if (!data) notFound();
  const decisions = await listTripDecisions(db, tenant, id);
  const agents = agentsConfigured();
  const back = `/judgment/trips/${id}`;

  return (
    <main>
      <p className="small">
        <Link href="/judgment">← Taste model</Link> · <Link href={`/trips/${id}`}>Trip</Link>
      </p>
      <h1>Decisions: {data.trip.title}</h1>
      <p className="lede">
        Record what you chose, passed on or changed. A reason already in the conversation is picked up; otherwise you&apos;ll get one short question only when the
        answer would improve future drafts.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <h2>Trip items</h2>
      {data.items.map((it) => (
        <form key={it.id} action={recordDecisionAction} className="card">
          <input type="hidden" name="tripId" value={id} />
          <input type="hidden" name="itemId" value={it.id} />
          <input type="hidden" name="back" value={back} />
          <div className="row">
            <b className="grow">{it.title}</b>
            <span className="small muted">{it.supplierName ?? ""}</span>
          </div>
          <div className="row small">
            <label style={{ margin: 0 }}>
              <input type="radio" name="kind" value="select" defaultChecked /> Select
            </label>
            <label style={{ margin: 0 }}>
              <input type="radio" name="kind" value="reject" /> Reject
            </label>
            <label style={{ margin: 0 }}>
              <input type="radio" name="kind" value="edit" /> Edit
            </label>
            <input name="after" type="text" placeholder="For an edit: what it became" aria-label="Edited to" style={{ flex: 1 }} maxLength={500} />
          </div>
          <ReasonFields id={it.id} agents={agents} />
          <div className="actions">
            <button className="btn small primary">Record</button>
          </div>
        </form>
      ))}

      <h2>A proposal option</h2>
      <form action={recordDecisionAction} className="card">
        <input type="hidden" name="tripId" value={id} />
        <input type="hidden" name="back" value={back} />
        <div className="grid2">
          <div>
            <label htmlFor="subject">Option</label>
            <input id="subject" name="subject" type="text" required maxLength={300} placeholder="Hotel Esencia, garden suite" />
          </div>
          <div>
            <label htmlFor="supplier">Supplier</label>
            <input id="supplier" name="supplierName" type="text" maxLength={300} />
          </div>
        </div>
        <label htmlFor="optionRef">Proposal option reference (if any)</label>
        <input id="optionRef" name="optionRef" type="text" maxLength={200} />
        <label htmlFor="kind">Decision</label>
        <select id="kind" name="kind" className="field">
          <option value="select">Selected</option>
          <option value="reject">Rejected</option>
          <option value="edit">Edited</option>
        </select>
        <label htmlFor="before">For an edit: before → after</label>
        <div className="row">
          <input name="before" type="text" aria-label="Before" style={{ flex: 1 }} maxLength={500} />
          <input name="after" type="text" aria-label="After" style={{ flex: 1 }} maxLength={500} />
        </div>
        <ReasonFields id="option" agents={agents} />
        <div className="actions">
          <button className="btn primary">Record</button>
        </div>
      </form>

      <h2>Recorded</h2>
      {decisions.length === 0 && <p className="empty">No decisions recorded on this trip yet.</p>}
      {decisions.map((d) => {
        const [label, tone] = STATUS[d.status] ?? [d.status, ""];
        return (
          <section key={d.id} className="card">
            <div className="row">
              <span className={`chip ${d.kind === "reject" ? "alert" : d.kind === "select" ? "ok" : "warn"}`}>{d.kind}</span>
              <b className="grow">{d.subject}</b>
              <span className={`chip ${tone}`}>{label}</span>
            </div>
            {d.after && (
              <div className="small">
                {d.before ? `${d.before} → ` : "→ "}
                {d.after}
              </div>
            )}
            {d.reason && d.status === "learned" && (
              <div className="small muted">
                Why: {d.reason.text}
                {d.learningTarget && ` · filed in ${TARGET_LABEL[d.learningTarget]}`}
                {d.reason.origin === "inferred" && " (agent's inference)"}
              </div>
            )}
            {d.status === "awaiting_answer" && d.expertId === member.id && (
              <div style={{ marginTop: 8 }}>
                <AnswerForm decisionId={d.id} question={d.question ?? "Why?"} guess={d.reason?.text ?? null} back={back} />
              </div>
            )}
            <div className="small muted">{d.decidedAt.slice(0, 16).replace("T", " ")}</div>
          </section>
        );
      })}
    </main>
  );
}
