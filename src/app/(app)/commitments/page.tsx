import Link from "next/link";
import { listItems, listTrips } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { reminderKind, type CommitmentFilter } from "@/domain/callTasks";
import { COMMITMENT_TRANSITIONS, evidenceLabel } from "@/domain/commitments";
import { getDb, requireMember } from "@/lib/server";
import { listCommitmentsFiltered } from "@/modules/calls/commitments";
import type { CommitmentView } from "@/modules/calls/repo";
import { addCommitmentAction } from "../calls/actions";
import { confirmCheckedAction, deliveredAction, transitionAction } from "./actions";

export const metadata = { title: "Commitments" };
export const dynamic = "force-dynamic";

const FILTERS: { key: CommitmentFilter; label: string }[] = [
  { key: "needs_review", label: "Needs review" },
  { key: "overdue", label: "Overdue" },
  { key: "pending", label: "Pending" },
  { key: "disputed", label: "Disputed" },
  { key: "all", label: "All" },
];
const STATE_TONE: Record<string, string> = { pending: "warn", fulfilled: "ok", disputed: "alert", superseded: "", canceled: "" };

function source(c: CommitmentView): { href: string; label: string } | null {
  const transcript = /^call_transcript:([0-9a-f-]{36})$/.exec(c.evidenceRef ?? "");
  if (c.callTaskId && transcript) return { href: `/calls/${c.callTaskId}/transcripts/${transcript[1]}`, label: "Transcript" };
  if (c.callTaskId) return { href: `/calls/${c.callTaskId}`, label: c.taskPurpose ?? "Call" };
  if (c.tripId) return { href: `/trips/${c.tripId}`, label: "Trip" };
  return null;
}

export default async function CommitmentsPage({ searchParams }: { searchParams: Promise<{ filter?: string; error?: string; ok?: string }> }) {
  const sp = await searchParams;
  const filter: CommitmentFilter = FILTERS.some((f) => f.key === sp.filter) ? (sp.filter as CommitmentFilter) : "needs_review";
  const me = await requireMember();
  const now = new Date();
  const db = await getDb();
  const [commitments, { trips, items }] = await Promise.all([
    listCommitmentsFiltered(db, me.tenant, filter, now),
    withTenant(db, me.tenant, async (q) => ({ trips: await listTrips(q), items: await listItems(q) })),
  ]);
  const back = `/commitments?filter=${filter}`;
  const tripTitle = (id: string) => trips.find((t) => t.id === id)?.title ?? "";

  return (
    <main>
      <h1>Commitments</h1>
      <p className="lede">
        Who promised what, on what evidence, and what is happening with it. Evidence and state are separate: a verbal promise can be fulfilled, and a written
        confirmation can still go unfulfilled. Follow-through ends when the traveler receives it.
      </p>
      {sp.error && <p className="notice error">{sp.error}</p>}
      {sp.ok && <p className="notice">{sp.ok}</p>}
      <div className="row small">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/commitments?filter=${f.key}`} className={`chip ${f.key === filter ? "ok" : ""}`}>
            {f.label}
          </Link>
        ))}
      </div>

      <form id="recap-form" action="/commitments/recap" method="get" />
      <div className="card table-wrap" style={{ marginTop: 12 }}>
        {commitments.length === 0 ? (
          <p className="empty">Nothing here.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th aria-label="Select for recap" />
                <th>Who · promise</th>
                <th>Trip</th>
                <th>Due</th>
                <th>Evidence</th>
                <th>State</th>
                <th>Follow-through</th>
              </tr>
            </thead>
            <tbody>
              {commitments.map((c) => {
                const src = source(c);
                const due = reminderKind(c, now);
                return (
                  <tr key={c.id}>
                    <td>
                      <input type="checkbox" name="ids" value={c.id} form="recap-form" aria-label="Include in recap" />
                    </td>
                    <td>
                      <b>{c.promisor}</b>: {c.promise}
                      {c.conditions && <div className="small muted">Conditions: {c.conditions}</div>}
                      {src && (
                        <div className="small">
                          <Link href={src.href}>{src.label}</Link>
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {c.tripTitle ?? "—"}
                      {c.itemTitle && <div className="muted">{c.itemTitle}</div>}
                    </td>
                    <td className="small">
                      {c.dueBy ? c.dueBy.slice(0, 10) : "—"}
                      {due === "overdue" && <div className="chip alert">overdue</div>}
                      {due === "due_soon" && <div className="chip warn">due soon</div>}
                    </td>
                    <td className="small">
                      {evidenceLabel(c)}
                      {c.reviewStatus === "needs_review" ? (
                        <form action={confirmCheckedAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="back" value={back} />
                          <span className="chip warn">needs review</span>{" "}
                          <button className="btn small" title="I checked who promised what, the amounts and the dates">
                            Confirm checked
                          </button>
                        </form>
                      ) : (
                        <div className="muted">{c.reviewStatus === "reviewed" ? "reviewed" : "filed automatically"}</div>
                      )}
                    </td>
                    <td>
                      <span className={`chip ${STATE_TONE[c.state] ?? ""}`}>{c.state}</span>
                      {COMMITMENT_TRANSITIONS[c.state].length > 0 && (
                        <form action={transitionAction} className="row" style={{ marginTop: 6 }}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="back" value={back} />
                          <select name="to" aria-label="Change state" defaultValue="">
                            <option value="" disabled>
                              Change…
                            </option>
                            {COMMITMENT_TRANSITIONS[c.state].map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                          <button className="btn small">Save</button>
                        </form>
                      )}
                    </td>
                    <td className="small">
                      <div>{c.recapSentAt ? `Recap sent ${c.recapSentAt.slice(0, 10)}` : "No recap yet"}</div>
                      {c.deliveredToTravelerAt ? (
                        <span className="chip ok">delivered {c.deliveredToTravelerAt.slice(0, 10)}</span>
                      ) : (
                        (c.state === "pending" || c.state === "fulfilled") && (
                          <form action={deliveredAction}>
                            <input type="hidden" name="id" value={c.id} />
                            <input type="hidden" name="back" value={back} />
                            <button className="btn small">Traveler received it</button>
                          </form>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {commitments.length > 0 && (
          <div className="actions">
            <button className="btn primary" form="recap-form">
              Draft recap for selected
            </button>
          </div>
        )}
      </div>

      <details className="card">
        <summary>Enter a commitment by hand</summary>
        <form action={addCommitmentAction}>
          <label htmlFor="tripId">Trip</label>
          <select id="tripId" name="tripId" className="field" defaultValue="">
            <option value="">No trip</option>
            {trips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <label htmlFor="itemId">Booking (must be on that trip)</label>
          <select id="itemId" name="itemId" className="field" defaultValue="">
            <option value="">Not tied to a booking</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {tripTitle(i.tripId)} — {i.title}
              </option>
            ))}
          </select>
          <div className="grid2">
            <div>
              <label htmlFor="promisor">Who promised</label>
              <input id="promisor" name="promisor" type="text" required maxLength={200} />
            </div>
            <div>
              <label htmlFor="dueBy">Due by (UTC)</label>
              <input id="dueBy" name="dueBy" type="datetime-local" />
            </div>
          </div>
          <label htmlFor="promise">What was promised</label>
          <input id="promise" name="promise" type="text" required maxLength={2000} />
          <label htmlFor="conditions">Conditions</label>
          <input id="conditions" name="conditions" type="text" maxLength={2000} />
          <label htmlFor="evidence">How we know</label>
          <select id="evidence" name="evidence" className="field" defaultValue="written_confirmation">
            <option value="written_confirmation">Written confirmation</option>
            <option value="verbal_statement">Verbal statement</option>
            <option value="expert_notes">Expert&apos;s notes</option>
            <option value="machine_transcript">Machine transcript</option>
          </select>
          <label htmlFor="evidenceRef">Reference (email id, confirmation number)</label>
          <input id="evidenceRef" name="evidenceRef" type="text" maxLength={200} />
          <label className="row" style={{ color: "inherit" }}>
            <input type="checkbox" name="consequential" /> Affects money, something the traveler relies on, or the client relationship
          </label>
          <div className="actions">
            <button className="btn primary">Record commitment</button>
          </div>
        </form>
      </details>
    </main>
  );
}
