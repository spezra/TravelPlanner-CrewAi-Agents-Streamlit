import Link from "next/link";
import { notFound } from "next/navigation";
import { getResponsePlan, getTrip, listApprovals, listCommitments, listItems } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { describePerksForTraveler, missingCredentialFields, summarizeTrip, type TripItem } from "@/domain/bookings";
import { briefForTrip, type BriefStatement } from "@/domain/brief";
import { evidenceLabel } from "@/domain/commitments";
import { approvalExpired, formatAmount } from "@/domain/tripPlanning";
import { currentResponder } from "@/domain/responsePlan";
import { getDb, requireMember } from "@/lib/server";
import { STALE_ATTEMPT_MINUTES } from "@/modules/trips/execution";
import { providerForItem } from "@/modules/trips/providers";
import * as trips from "@/modules/trips/repo";
import { confirmCommitment } from "../../actions";
import {
  bookAction,
  cancelBookingAction,
  decideApprovalAction,
  moveItemAction,
  reconcileAction,
  recordManualAction,
  withdrawApprovalAction,
} from "../actions";
import { fmtWhen, Notices, STATE_TONE, stateLabel } from "../ui";

export const metadata = { title: "Trip" };
export const dynamic = "force-dynamic";

function channelOf(item: TripItem): "duffel" | "manual" {
  try {
    return providerForItem(item);
  } catch {
    return "manual";
  }
}

export default async function TripPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const now = new Date();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const trip = await getTrip(q, id);
    if (!trip) return null;
    const [items, approvals, commitments, plan, members, extras, manual, attempts, acceptances, meta, activity] = await Promise.all([
      listItems(q, id),
      listApprovals(q, { tripId: id }),
      listCommitments(q, id),
      getResponsePlan(q, id),
      trips.listMembers(q),
      trips.listItemExtras(q, id),
      trips.listManualForTrip(q, id),
      trips.listAttemptsForTrip(q, id),
      trips.listAcceptances(q, id),
      trips.approvalMeta(q, id),
      trips.tripActivity(q, id),
    ]);
    const statements = trip.clientId
      ? (await q.query<Record<string, unknown>>("select * from brief_statements where client_id = $1", [trip.clientId])).rows.map(
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
    return { trip, items, approvals, commitments, plan, members, extras, manual, attempts, acceptances, meta, activity, statements };
  });
  if (!data) notFound();
  const { trip, items, approvals, commitments, plan, members, extras, manual, attempts, acceptances, meta, activity, statements } = data;
  const tz = members.find((m) => m.id === me.member.id)?.timeZone ?? "UTC";
  const name = (mid: string | null) => (mid ? (members.find((m) => m.id === mid)?.name ?? (mid.startsWith("agent:") ? "an agent" : "—")) : "—");
  const summary = summarizeTrip(items);
  const brief = trip.clientId ? briefForTrip(statements, trip.clientId, trip.id) : null;
  const isOwner = trip.ownerId === me.member.id;
  const canDecide = isOwner || me.member.role === "owner";
  const title = (itemId: string) => items.find((i) => i.id === itemId)?.title ?? "item";
  const approvedCancel = (itemId: string) => approvals.some((a) => a.status === "approved" && a.actions.some((x) => x.kind === "cancel" && x.itemId === itemId));
  const pendingTasks = manual.filter((t) => t.status === "pending");
  const hidden = (itemId: string) => (
    <>
      <input type="hidden" name="tripId" value={trip.id} />
      <input type="hidden" name="itemId" value={itemId} />
    </>
  );
  const recheck = (
    <label className="small" style={{ margin: "6px 0 0" }}>
      <input type="checkbox" name="termsRechecked" value="yes" required /> I re-checked price, availability and cancellation terms with the supplier just now
    </label>
  );

  return (
    <main>
      <div className="row">
        <h1 className="grow">{trip.title}</h1>
        <Link className="btn" href={`/trips/${trip.id}/edit`}>
          Edit
        </Link>
        <Link className="btn" href={`/trips/${trip.id}/access`}>
          Access & client link
        </Link>
      </div>
      <p className="lede">
        {trip.clientName ?? "No client"} · {trip.startsOn ?? "dates open"}
        {trip.endsOn ? ` → ${trip.endsOn}` : ""} · owner {trip.ownerName} · {trip.scope} · stage <b>{summary.stage}</b>
      </p>
      <nav className="subnav" aria-label="Trip" style={{ margin: "0 0 var(--space-4)" }}>
        <Link href={`/proposals/${trip.id}`}>Proposal</Link>
        <Link href={`/trips/${trip.id}/plan`}>Response plan</Link>
        <Link href={`/judgment/trips/${trip.id}`}>Decisions</Link>
        <Link href={`/calls/new?trip=${trip.id}`}>New call</Link>
        {trip.clientId && <Link href={`/clients/${trip.clientId}`}>Client brief</Link>}
      </nav>
      <Notices error={error} ok={ok} />

      <div className="row">
        <h2 className="grow">Bookings</h2>
        <Link className="btn" href={`/trips/${trip.id}/items/new`}>
          Add item
        </Link>
        <Link className="btn" href={`/trips/${trip.id}/approvals/new`}>
          Request approval
        </Link>
      </div>
      <div className="card table-wrap">
        {items.length === 0 ? (
          <p className="empty">No items yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>State</th>
                <th>Price</th>
                <th>Booked through</th>
                <th>Perks as told to the traveler</th>
                <th>Next step</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const missing = missingCredentialFields(it);
                const ex = extras.get(it.id);
                const queued = Boolean(ex?.executionRequestedAt);
                const channel = channelOf(it);
                const lastAttempt = attempts.find((a) => a.itemId === it.id);
                const staleBooking = it.state === "booking" && lastAttempt && now.getTime() - new Date(lastAttempt.updatedAt).getTime() > STALE_ATTEMPT_MINUTES * 60_000;
                return (
                  <tr key={it.id}>
                    <td>
                      <Link href={`/trips/${trip.id}/items/${it.id}`}>{it.title}</Link>
                      <div className="small muted">
                        {it.kind} · {fmtWhen(it.startsAt, tz, false)}
                        {it.confirmationRef ? ` · Conf. ${it.confirmationRef}` : ""}
                      </div>
                      {ex?.lastExecutionNote && <div className="small chip alert">{ex.lastExecutionNote}</div>}
                    </td>
                    <td>
                      <span className={`chip ${STATE_TONE[it.state] ?? ""}`}>{stateLabel(it.state)}</span>
                      {queued && <div className="chip warn">queued</div>}
                    </td>
                    <td>{it.price ? formatAmount(it.price) : "—"}</td>
                    <td className="small">
                      {it.credentials ? (
                        <>
                          {it.credentials.bookingEntity}
                          <div className="muted">
                            {it.credentials.permittedChannel}
                            {it.credentials.program ? ` · ${it.credentials.program}` : ""} · {it.credentials.rate}
                          </div>
                          <div className="muted">
                            Services: {it.credentials.servicingOwner} ({it.credentials.servicingActions.join(", ").replace(/_/g, " ")}) · Paid to: {it.credentials.commissionRecipient}
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
                    <td className="small">
                      {it.state === "approved" && !queued && (
                        <form action={bookAction}>
                          {hidden(it.id)}
                          {channel === "manual" && recheck}
                          <button className="btn primary" style={{ marginTop: 6 }}>
                            Book {channel === "duffel" ? "via Duffel" : "with supplier"}
                          </button>
                        </form>
                      )}
                      {(it.state === "outcome_unknown" || it.state === "cancel_requested" || staleBooking) && !queued && (
                        <form action={reconcileAction}>
                          {hidden(it.id)}
                          <button className="btn">Reconcile with supplier</button>
                        </form>
                      )}
                      {it.state === "booking" && !staleBooking && <span className="muted">Contacting the supplier…</span>}
                      {(it.state === "confirmed" || it.state === "disrupted") &&
                        !queued &&
                        (approvedCancel(it.id) ? (
                          <form action={cancelBookingAction}>
                            {hidden(it.id)}
                            {(ex?.provider ?? channel) === "manual" && recheck}
                            <button className="btn" style={{ marginTop: 6 }}>
                              Cancel booking (approved)
                            </button>
                          </form>
                        ) : (
                          <Link href={`/trips/${trip.id}/approvals/new?cancel=${it.id}`}>Request cancellation…</Link>
                        ))}
                      {it.state === "disrupted" && (
                        <div className="actions" style={{ marginTop: 6 }}>
                          <form action={moveItemAction}>
                            {hidden(it.id)}
                            <button className="btn" name="move" value="accept_change">
                              Accept change
                            </button>
                          </form>
                          <form action={moveItemAction}>
                            {hidden(it.id)}
                            <button className="btn" name="move" value="to_design">
                              Rebook
                            </button>
                          </form>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {pendingTasks.length > 0 && (
        <>
          <h2>Awaiting supplier confirmation</h2>
          <p className="small muted">
            These suppliers have no booking API. The request is outcome-unknown until you record what the supplier said: nothing is marked
            booked on hope, and nothing is resent blind.
          </p>
          {pendingTasks.map((t) => (
            <section key={t.id} className="card">
              <div className="row">
                <span className="chip alert">{t.action === "book" ? "reservation" : "cancellation"}</span>
                <h3 className="grow">{title(t.itemId)}</h3>
                <span className="small muted">
                  requested {fmtWhen(t.createdAt, tz)}
                  {t.rounds > 1 ? ` · round ${t.rounds}` : ""}
                </span>
              </div>
              <div className="small muted">
                {t.supplierName ?? "Supplier"} · via {t.channel} · reference for the supplier: {t.attemptKey}
              </div>
              <div className="grid2" style={{ marginTop: 8 }}>
                <form action={recordManualAction}>
                  <input type="hidden" name="tripId" value={trip.id} />
                  <input type="hidden" name="taskId" value={t.id} />
                  <input type="hidden" name="outcome" value="confirmed" />
                  <label htmlFor={`ref_${t.id}`}>Supplier&apos;s confirmation number</label>
                  <input id={`ref_${t.id}`} name="confirmationRef" type="text" required maxLength={100} />
                  <label htmlFor={`note_${t.id}`}>Note (who confirmed, how)</label>
                  <input id={`note_${t.id}`} name="note" type="text" maxLength={1000} />
                  <div className="actions">
                    <button className="btn primary">Record {t.action === "book" ? "confirmation" : "cancellation"}</button>
                  </div>
                </form>
                <form action={recordManualAction}>
                  <input type="hidden" name="tripId" value={trip.id} />
                  <input type="hidden" name="taskId" value={t.id} />
                  <input type="hidden" name="outcome" value="not_found" />
                  <label htmlFor={`nf_${t.id}`}>Or: the supplier says {t.action === "book" ? "there is no reservation" : "it was not cancelled"}</label>
                  <input id={`nf_${t.id}`} name="note" type="text" maxLength={1000} placeholder="Who said so, when" />
                  <div className="actions">
                    <button className="btn">{t.action === "book" ? "Supplier has no reservation" : "Supplier did not cancel"}</button>
                  </div>
                </form>
              </div>
            </section>
          ))}
        </>
      )}

      <h2>Approvals</h2>
      {approvals.length === 0 && <p className="empty">None.</p>}
      {[...approvals].reverse().map((a) => {
        const m = meta.get(a.id);
        const expired = approvalExpired(a, now);
        const acc = acceptances.find((x) => x.approvalId === a.id);
        const accCurrent = acc && acc.termsFingerprint === a.termsFingerprint && acc.priceMinor === a.terms.price.amountMinor;
        const requester = m?.requestedByMember ?? a.requestedBy;
        const canWithdraw = a.status === "pending" && (requester === me.member.id || canDecide);
        if (a.status === "withdrawn" || a.status === "rejected") {
          return (
            <section key={a.id} className="card small muted">
              <span className="chip">{a.status}</span> {a.actions.map((x) => `${x.kind} ${title(x.itemId)}`).join(" + ")} · {formatAmount(a.terms.price)}
              {m?.supersededBy ? " · re-quoted" : ""}
              {a.note ? ` · ${a.note}` : ""}
            </section>
          );
        }
        return (
          <section key={a.id} className="card">
            <div className="row">
              <span className={`chip ${a.status === "pending" ? (expired ? "alert" : "warn") : "ok"}`}>{a.status === "pending" && expired ? "expired" : a.status}</span>
              <h3 className="grow">{a.actions.map((x) => `${x.kind} ${title(x.itemId)}`).join(" + ")}</h3>
              <b>{formatAmount(a.terms.price)}</b>
            </div>
            <ul className="plain small">
              <li>
                Offer {expired ? "expired" : "expires"} {fmtWhen(a.terms.offerExpiresAt, tz)}
              </li>
              <li>Cancellation: {a.terms.cancellationPolicy}</li>
              {a.terms.downstreamChanges.map((c) => (
                <li key={c}>Also changes: {c}</li>
              ))}
              <li>Who will act: {a.terms.actor}</li>
              <li className="muted">Requested by {name(requester)}</li>
              {acc && (
                <li>
                  <span className={`chip ${accCurrent ? "ok" : "warn"}`}>client accepted</span> {acc.acceptedName} on {fmtWhen(acc.acceptedAt, tz)}
                  {accCurrent ? "" : " (for different terms)"}. Your approval is still required.
                </li>
              )}
              {a.decidedBy && (
                <li className="muted">
                  Decided by {name(a.decidedBy)} {a.decidedAt ? fmtWhen(a.decidedAt, tz) : ""}
                </li>
              )}
            </ul>
            <div className="actions">
              {a.status === "pending" && !expired && canDecide && (
                <form action={decideApprovalAction} className="actions" style={{ marginTop: 0 }}>
                  <input type="hidden" name="approvalId" value={a.id} />
                  <input type="hidden" name="tripId" value={trip.id} />
                  <button className="btn primary" name="decision" value="approved">
                    Approve all {a.actions.length} action{a.actions.length > 1 ? "s" : ""}
                  </button>
                  <button className="btn" name="decision" value="rejected">
                    Reject
                  </button>
                </form>
              )}
              {a.status === "pending" && !canDecide && <span className="small muted">Waiting for {trip.ownerName} to decide.</span>}
              {(expired || a.status === "approved") && (
                <Link className="btn" href={`/trips/${trip.id}/approvals/new?requote=${a.id}`}>
                  Re-quote
                </Link>
              )}
              {canWithdraw && (
                <form action={withdrawApprovalAction}>
                  <input type="hidden" name="approvalId" value={a.id} />
                  <input type="hidden" name="tripId" value={trip.id} />
                  <button className="btn">Withdraw</button>
                </form>
              )}
            </div>
          </section>
        );
      })}

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
                        <input type="hidden" name="back" value={`/trips/${trip.id}`} />
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
                      {s.text} <span className="chip">{s.evidence.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                </ul>
                <h3 style={{ marginTop: 12 }}>This trip</h3>
                <ul className="plain small">
                  {brief.thisTrip.map((s) => (
                    <li key={s.id}>
                      {s.text} <span className="chip">{s.evidence.replace(/_/g, " ")}</span>
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

      <h2>Execution</h2>
      <div className="card table-wrap">
        {attempts.length === 0 ? (
          <p className="empty">Nothing has been sent to a supplier yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Action</th>
                <th>Rail</th>
                <th>State</th>
                <th>Tries</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td>{title(a.itemId)}</td>
                  <td>{a.action}</td>
                  <td>{a.provider}</td>
                  <td>
                    <span className={`chip ${a.state === "succeeded" ? "ok" : a.state === "outcome_unknown" ? "alert" : ""}`}>{a.state.replace(/_/g, " ")}</span>
                    {a.lastError && <div className="small muted">{a.lastError}</div>}
                  </td>
                  <td>{a.attempts}</td>
                  <td className="small">{fmtWhen(a.updatedAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Activity</h2>
      <div className="card">
        {activity.length === 0 ? (
          <p className="empty">No activity yet.</p>
        ) : (
          <ul className="plain small">
            {activity.map((e, i) => (
              <li key={i}>
                <span className="muted">{fmtWhen(e.at, tz)}</span> · {name(e.actor) === "—" ? e.actor : name(e.actor)} · {e.action.replace(/[._]/g, " ")}
                {items.some((it) => it.id === e.subject) ? ` · ${title(e.subject)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
