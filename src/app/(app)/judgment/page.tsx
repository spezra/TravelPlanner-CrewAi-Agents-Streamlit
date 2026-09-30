import Link from "next/link";
import { listTrips } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { listOpenQuestions, tasteModel, type Learning } from "@/modules/ops/judgment";
import { recordDraftOutcomeAction, reviewLearningAction } from "./actions";
import { AnswerForm } from "./AnswerForm";

export const metadata = { title: "Taste model" };
export const dynamic = "force-dynamic";


function LearningList({ items, actions }: { items: Learning[]; actions: ("endorse" | "retract")[] }) {
  if (items.length === 0) return <p className="empty small">None.</p>;
  return (
    <ul className="plain">
      {items.map((l) => (
        <li key={l.id} className="row">
          <span className="grow small">
            <span className={`chip ${l.kind === "reject" ? "alert" : l.kind === "select" ? "ok" : "warn"}`}>{l.kind}</span> {l.summary}
            <span className="muted"> · {l.observedAt.slice(0, 10)}</span>
          </span>
          {actions.map((a) => (
            <form key={a} action={reviewLearningAction}>
              <input type="hidden" name="learningId" value={l.id} />
              <button className={`btn small ${a === "endorse" ? "primary" : ""}`} name="verdict" value={a}>
                {a === "endorse" ? "Endorse" : "Retract"}
              </button>
            </form>
          ))}
        </li>
      ))}
    </ul>
  );
}

export default async function JudgmentPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { tenant } = await requireMember();
  const db = await getDb();
  const now = new Date();
  const [model, questions, trips] = await Promise.all([tasteModel(db, tenant, now), listOpenQuestions(db, tenant), withTenant(db, tenant, (q) => listTrips(q))]);
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <main>
      <h1>Your taste model</h1>
      <p className="lede">
        What agents have learned from your selections, rejections and edits, kept apart from client preferences, supplier conditions and one trip&apos;s constraints.
        Anything an agent inferred stays provisional until you endorse it.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      {questions.length > 0 && (
        <>
          <h2>Quick questions</h2>
          {questions.map((d) => (
            <section key={d.id} className="card">
              <div className="small muted">
                {d.kind} · {d.subject} · <Link href={`/judgment/trips/${d.tripId}`}>{d.tripTitle}</Link>
              </div>
              <AnswerForm decisionId={d.id} question={d.question ?? "Why?"} guess={d.reason?.text ?? null} back="/judgment" />
            </section>
          ))}
        </>
      )}

      <h2>Endorsement</h2>
      <div className="card">
        <p className="small muted">The test isn&apos;t whether drafts resemble past work but whether you endorse them for a new client and situation.</p>
        {model.endorsement.total === 0 ? (
          <p className="empty">No draft outcomes recorded yet.</p>
        ) : (
          <div className="row">
            <span>
              <b style={{ fontSize: 24 }}>{pct(model.endorsement.rate)}</b> endorsed unchanged
            </span>
            <span className="chip ok">{model.endorsement.endorsedUnchanged} unchanged</span>
            <span className="chip warn">{model.endorsement.endorsedWithEdits} with edits</span>
            <span className="chip alert">{model.endorsement.rejected} rejected</span>
            <span className="small muted">of {model.endorsement.total} drafts</span>
          </div>
        )}
        <details className="small">
          <summary className="muted">Record a draft outcome</summary>
          <form action={recordDraftOutcomeAction}>
            <label htmlFor="dr">Draft</label>
            <input id="dr" name="draftRef" type="text" required maxLength={300} placeholder="Oaxaca hotel shortlist" />
            <label htmlFor="dt">Trip</label>
            <select id="dt" name="tripId" className="field" defaultValue="">
              <option value="">—</option>
              {trips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <label htmlFor="do">Outcome</label>
            <select id="do" name="outcome" className="field">
              <option value="endorsed_unchanged">Endorsed as drafted</option>
              <option value="endorsed_with_edits">Endorsed with material edits</option>
              <option value="rejected">Rejected</option>
            </select>
            <label htmlFor="dn">Note</label>
            <input id="dn" name="note" type="text" maxLength={500} />
            <div className="actions">
              <button className="btn primary">Record</button>
            </div>
          </form>
        </details>
        {model.recentOutcomes.length > 0 && (
          <ul className="plain small muted">
            {model.recentOutcomes.slice(0, 5).map((o) => (
              <li key={o.id}>
                {o.recordedAt.slice(0, 10)} · {o.draftRef} · {o.outcome.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>Provisional</h2>
      <div className="card">
        <LearningList items={model.provisional} actions={["endorse", "retract"]} />
      </div>
      <h2>Endorsed</h2>
      <div className="card">
        <LearningList items={model.endorsed} actions={["retract"]} />
      </div>
      {model.retracted.length > 0 && (
        <details className="card">
          <summary>Retracted ({model.retracted.length})</summary>
          <LearningList items={model.retracted} actions={[]} />
        </details>
      )}

      <h2>Supplier conditions you recorded</h2>
      <div className="card table-wrap">
        {model.supplierConditions.length === 0 ? (
          <p className="empty">None.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Condition</th>
                <th>Observed</th>
                <th>Until</th>
              </tr>
            </thead>
            <tbody>
              {model.supplierConditions.map((c) => (
                <tr key={c.id} className={c.current ? "" : "muted"}>
                  <td>{c.supplierName}</td>
                  <td>
                    {c.condition} {c.provisional && <span className="chip warn">agent inferred</span>}
                  </td>
                  <td>{c.observedAt.slice(0, 10)}</td>
                  <td>{c.validUntil ?? "—"}{!c.current && " (lapsed)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Record decisions</h2>
      <ul className="plain">
        {trips.map((t) => (
          <li key={t.id}>
            <Link href={`/judgment/trips/${t.id}`}>{t.title}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
