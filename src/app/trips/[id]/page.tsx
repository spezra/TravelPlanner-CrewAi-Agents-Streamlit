import { notFound } from "next/navigation";
import { getResponsePlan, getTrip, listApprovals, listCommitments, listItems } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { describePerksForTraveler, missingCredentialFields, summarizeTrip, type ItemState } from "@/domain/bookings";
import { briefForTrip, type BriefStatement } from "@/domain/brief";
import { evidenceLabel } from "@/domain/commitments";
import { formatMoney } from "@/domain/common";
import { currentResponder } from "@/domain/responsePlan";
import { currentTenant, getDb } from "@/lib/server";
import { confirmCommitment, decideApproval } from "../../actions";

export const dynamic = "force-dynamic";

const STATE_TONE: Partial<Record<ItemState, "ok" | "warn" | "alert">> = {
  confirmed: "ok",
  awaiting_approval: "warn",
  approved: "warn",
  booking: "warn",
  outcome_unknown: "alert",
  disrupted: "alert",
  failed: "alert",
};

export default async function TripPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const me = await currentTenant();
  const now = new Date();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const trip = await getTrip(q, id);
    if (!trip) return null;
    const [items, approvals, commitments, plan] = await Promise.all([listItems(q, id), listApprovals(q, { tripId: id }), listCommitments(q, id), getResponsePlan(q, id)]);
    const members = (await q.query<{ id: string; name: string }>("select id, name from members")).rows;
    const statements = trip.clientId
      ? (
          await q.query<Record<string, unknown>>("select * from brief_statements where client_id = $1", [trip.clientId])
        ).rows.map(
          (r): BriefStatement => ({
            id: String(r.id),
            clientId: String(r.client_id),
            tripId: r.trip_id ? String(r.trip_id) : null,
            dimension: r.dimension as BriefStatement["dimension"],
            text: String(r.text),
            evidence: r.evidence as BriefStatement["evidence"],
            source: String(r.source),
            recordedAt: String(r.recorded_at),
            supersededBy: r.superseded_by ? String(r.superseded_by) : null,
          }),
        )
      : [];
    return { trip, items, approvals, commitments, plan, members, statements };
  });
  if (!data) notFound();
  const { trip, items, approvals, commitments, plan, members, statements } = data;
  const name = (mid: string) => members.find((m) => m.id === mid)?.name ?? "—";
  const summary = summarizeTrip(items);
  const brief = trip.clientId ? briefForTrip(statements, trip.clientId, trip.id) : null;
  const back = `/trips/${trip.id}`;

  return (
    <main>
      <h1>{trip.title}</h1>
      <p className="lede">
        {trip.clientName ?? "No client"} · {trip.startsOn} → {trip.endsOn} · owner {trip.ownerName} · stage <b>{summary.stage}</b>
      </p>
      {error && <div className="card chip alert">{error}</div>}

      <h2>Bookings</h2>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>State</th>
              <th>Price</th>
              <th>Booked through</th>
              <th>Perks as told to the traveler</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const missing = missingCredentialFields(it);
              return (
                <tr key={it.id}>
                  <td>
                    {it.title}
                    {it.confirmationRef && <div className="small muted">Conf. {it.confirmationRef}</div>}
                  </td>
                  <td>
                    <span className={`chip ${STATE_TONE[it.state] ?? ""}`}>{it.state.replace("_", " ")}</span>
                  </td>
                  <td>{it.price ? formatMoney(it.price) : "—"}</td>
                  <td className="small">
                    {it.credentials ? (
                      <>
                        {it.credentials.bookingEntity}
                        <div className="muted">
                          {it.credentials.permittedChannel}
                          {it.credentials.program ? ` · ${it.credentials.program}` : ""} · services: {it.credentials.servicingOwner}
                        </div>
                      </>
                    ) : null}
                    {missing.length > 0 && <div className="chip warn">missing: {missing.join(", ")}</div>}
                  </td>
                  <td className="small">
                    {it.credentials?.perks.length ? (
                      <ul className="plain">
                        {describePerksForTraveler(it.credentials.perks).map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Approvals</h2>
      {approvals.length === 0 && <p className="empty">None.</p>}
      {approvals.map((a) => (
        <section key={a.id} className="card">
          <div className="row">
            <span className={`chip ${a.status === "pending" ? "warn" : a.status === "approved" ? "ok" : ""}`}>{a.status}</span>
            <h3 className="grow">
              {a.actions.map((x) => `${x.kind} ${items.find((i) => i.id === x.itemId)?.title ?? x.itemId}`).join(" + ")}
            </h3>
            <b>{formatMoney(a.terms.price)}</b>
          </div>
          <ul className="plain small">
            <li>Offer expires {new Date(a.terms.offerExpiresAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</li>
            <li>Cancellation: {a.terms.cancellationPolicy}</li>
            {a.terms.downstreamChanges.map((c) => (
              <li key={c}>Also changes: {c}</li>
            ))}
            <li>Who will act: {a.terms.actor}</li>
            {a.decidedBy && (
              <li className="muted">
                Decided by {name(a.decidedBy)} {a.decidedAt ? new Date(a.decidedAt).toLocaleString() : ""}
              </li>
            )}
          </ul>
          {a.status === "pending" && (
            <form action={decideApproval} className="actions">
              <input type="hidden" name="approvalId" value={a.id} />
              <input type="hidden" name="back" value={back} />
              <button className="btn primary" name="decision" value="approved">
                Approve all {a.actions.length} actions
              </button>
              <button className="btn" name="decision" value="rejected">
                Reject
              </button>
            </form>
          )}
        </section>
      ))}

      <h2>Commitments</h2>
      <div className="card table-wrap">
        {commitments.length === 0 ? (
          <p className="empty">None recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>Promise</th>
                <th>Evidence</th>
                <th>State</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {commitments.map((c) => (
                <tr key={c.id}>
                  <td>{c.promisor}</td>
                  <td>
                    {c.promise}
                    {c.conditions && <div className="small muted">Condition: {c.conditions}</div>}
                  </td>
                  <td className="small">{evidenceLabel(c)}</td>
                  <td>
                    <span className="chip">{c.state}</span>{" "}
                    {c.reviewStatus === "needs_review" && (
                      <form action={confirmCommitment} style={{ display: "inline" }}>
                        <input type="hidden" name="commitmentId" value={c.id} />
                        <input type="hidden" name="back" value={back} />
                        <button className="btn small">Confirm checked</button>
                      </form>
                    )}
                  </td>
                  <td className="small">{c.dueBy ? c.dueBy.slice(0, 10) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid2">
        <section>
          <h2>Client brief</h2>
          <div className="card">
            {!brief ? (
              <p className="empty">No client on this trip.</p>
            ) : (
              <>
                <h3>Enduring</h3>
                <ul className="plain small">
                  {brief.enduring.map((s) => (
                    <li key={s.id}>
                      {s.text} <span className="chip">{s.evidence.replace("_", " ")}</span>
                    </li>
                  ))}
                </ul>
                <h3 style={{ marginTop: 12 }}>This trip</h3>
                <ul className="plain small">
                  {brief.thisTrip.map((s) => (
                    <li key={s.id}>
                      {s.text} <span className="chip">{s.evidence.replace("_", " ")}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>
        <section>
          <h2>Response plan</h2>
          <div className="card small">
            {!plan ? (
              <p className="empty">No response plan. An always-on agent needs a named human for every trip.</p>
            ) : (
              <ul className="plain">
                <li>
                  Primary: <b>{name(plan.primary.memberId)}</b> ({plan.primary.timeZone})
                </li>
                <li>Backup: {plan.backup ? `${name(plan.backup.memberId)} (${plan.backup.timeZone})` : "none"}</li>
                <li>Acknowledge within {plan.ackDeadlineMinutes} min, then escalate to {plan.escalation.map(name).join(", ") || "—"}</li>
                <li>Right now: {name(currentResponder(plan, now).memberId)}</li>
                <li className="muted">{plan.clientContactPolicy}</li>
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
