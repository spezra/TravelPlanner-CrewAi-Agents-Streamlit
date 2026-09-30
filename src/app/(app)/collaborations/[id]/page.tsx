import Link from "next/link";
import { notFound } from "next/navigation";
import { getTrip, listItems } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { listRecipients } from "@/modules/money/repo";
import { CONTRIBUTION_LABEL, currentVersion, mayDo, type CollaborationTerms, type Side } from "@/domain/collaborationTerms";
import { formatMoney } from "@/domain/common";
import { getDb, requireMember } from "@/lib/server";
import * as collab from "@/modules/network/collaborations";
import { FEE_ROWS, minorDigits } from "@/modules/network/forms";
import {
  acceptTermsAction,
  recordSplitAction,
  activationDecideAction,
  activationRequestAction,
  completeAction,
  endorseAction,
  logAction,
  proposeTermsAction,
  refreshShareAction,
  respondAction,
  revokeShareAction,
  shareAction,
  startAction,
  withdrawAction,
} from "../actions";
import { STATE_LABEL } from "../labels";

export const metadata = { title: "Collaboration" };
export const dynamic = "force-dynamic";

const FEE_LABEL = { commission_split: "Commission split", advisory: "Advisory fee", design: "Design fee", referral: "Referral fee", execution: "Execution fee" } as const;

function Hidden({ id }: { id: string }) {
  return <input type="hidden" name="id" value={id} />;
}

function TermsView({ t, name }: { t: CollaborationTerms; name: (memberId: string) => string }) {
  const a = t.authority;
  return (
    <ul className="plain small">
      <li>
        <b>Client brief:</b> {name(a.briefOwner)} · <b>Final recommendation:</b> {name(a.finalRecommendationOwner)}
      </li>
      {a.delegatedDecisions.length > 0 && (
        <li>
          <b>Delegated to the specialist:</b> {a.delegatedDecisions.join("; ")}
        </li>
      )}
      {a.changesRequiringSpecialistReview.length > 0 && (
        <li>
          <b>Needs renewed specialist review:</b> {a.changesRequiringSpecialistReview.join("; ")}
        </li>
      )}
      {Object.keys(a.deliveryOwners).length > 0 && (
        <li>
          <b>Delivery and recovery:</b>{" "}
          {Object.entries(a.deliveryOwners)
            .map(([service, owner]) => `${service}: ${name(owner)}`)
            .join("; ")}
        </li>
      )}
      <li>
        <b>Specialist visible to the client:</b> {a.specialistVisibleToClient ? "yes" : "no, behind the scenes"} · <b>Name attached:</b>{" "}
        {a.attributionRule === "with_endorsement" ? "only while their endorsement holds" : a.attributionRule}
      </li>
      {t.fees.map((f, i) => (
        <li key={i}>
          <b>{FEE_LABEL[f.kind]}</b> to the {f.payee}:{" "}
          {f.kind === "commission_split" ? `${((f.commissionShareBps ?? 0) / 100).toFixed(2)}% of commission received on ${f.bookingItemLabels.join(", ")}` : f.amount ? formatMoney(f.amount) : "—"}
        </li>
      ))}
      <li>
        <b>Non-solicit:</b> {t.nonSolicit ? "yes" : "no"} · <b>Client-detail access ends:</b> {t.clientAccessExpiresAt.slice(0, 10)} · <b>Reversed payout loss:</b>{" "}
        {t.reversalLossBearer === "shared_pro_rata" ? "shared pro rata" : `borne by the ${t.reversalLossBearer}`}
      </li>
      {t.notes && <li>{t.notes}</li>}
    </ul>
  );
}

export default async function CollaborationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const me = await requireMember();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const now = new Date();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const c = await collab.getCollaboration(q, id);
    if (!c) return null;
    const side = collab.sideOf(c, me.tenant);
    const terms = await collab.listTerms(q, id);
    const shares = await collab.listShares(q, id);
    const endorsements = await collab.endorsementStatuses(q, c, side);
    const activations = await collab.listActivations(q, id);
    const log = await collab.listLog(q, id);
    let trip: Awaited<ReturnType<typeof getTrip>> = null;
    let items: Awaited<ReturnType<typeof listItems>> = [];
    let statements: { id: string; dimension: string; text: string }[] = [];
    if (side === "requester" && c.tripId) {
      trip = await getTrip(q, c.tripId);
      items = trip ? await listItems(q, c.tripId) : [];
      if (trip?.clientId) {
        statements = (
          await q.query<{ id: string; dimension: string; text: string }>(
            "select id, dimension, text from brief_statements where client_id = $1 and superseded_by is null and (trip_id is null or trip_id = $2) order by recorded_at",
            [trip.clientId, c.tripId],
          )
        ).rows;
      }
    }
    const recipients = side === "requester" && c.agreedTermsVersion !== null ? (await listRecipients(q)).filter((r) => r.kind !== "workspace") : [];
    return { c, side, terms, shares, endorsements, activations, log, trip, items, statements, recipients };
  });
  if (!data) notFound();
  const { c, side, terms, shares, endorsements, activations, log, trip, items, statements, recipients } = data;
  const may = (a: Parameters<typeof mayDo>[0]) => side !== null && mayDo(a, side, c.state);
  const name = (memberId: string | null) =>
    memberId === c.requesterMemberId ? c.requesterName : memberId === c.specialistMemberId ? c.specialistName : memberId ? "A colleague" : "The platform";
  const latest = currentVersion(terms);
  const agreed = terms.find((t) => t.version === c.agreedTermsVersion) ?? null;
  const accessOpen = (c.state === "terms_agreed" || c.state === "active") && c.clientAccessExpiresAt !== null && new Date(c.clientAccessExpiresAt) > now;
  const draft = latest?.terms ?? agreed?.terms ?? null;
  const itemLabels = new Map<string, string>();
  if (side === "requester") for (const it of items) itemLabels.set(it.id, it.title);
  for (const v of terms) for (const f of v.terms.fees) f.bookingItemIds.forEach((bid, i) => itemLabels.set(bid, itemLabels.get(bid) ?? f.bookingItemLabels[i] ?? "Booking line"));
  const sideOfMember = (m: string): Side => (m === c.specialistMemberId ? "specialist" : "requester");
  const sharedKeys = new Set(shares.filter((s) => !s.revokedAt).map((s) => `${s.kind}:${s.sourceId}`));
  const endorsedShares = new Map(endorsements.map((e) => [e.shareId, e]));

  return (
    <main>
      <p className="small">
        <Link href="/collaborations">← Collaborations</Link>
      </p>
      <h1>
        {CONTRIBUTION_LABEL[c.contribution]}
        {c.destination ? `: ${c.destination}` : ""}
      </h1>
      <p className="row small">
        <span className="chip">{STATE_LABEL[c.state]}</span>
        <span className="muted">
          {c.requesterName} asked {c.specialistName} · {c.createdAt.slice(0, 10)}
          {side === null && " · you can see this because you can see its trip"}
        </span>
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <h2>Brief</h2>
      <div className="card">
        <p>{c.brief.text}</p>
        <div className="small muted">
          Party of {c.brief.partySize}
          {c.brief.budgetBand && ` · ${c.brief.budgetBand}`}
          {c.brief.dates && ` · ${c.brief.dates}`}
          {c.brief.redactions > 0 && ` · ${c.brief.redactions} identifying detail(s) removed before sending`}
        </div>
        {c.declineReason && <p className="small">Declined: {c.declineReason}</p>}
      </div>

      {(may("accept_request") || may("decline_request") || may("start_work") || may("complete") || may("withdraw")) && (
        <div className="row">
          {may("accept_request") && (
            <form action={respondAction}>
              <Hidden id={c.id} />
              <input type="hidden" name="decision" value="accept" />
              <button className="btn primary">Accept and discuss terms</button>
            </form>
          )}
          {may("decline_request") && (
            <form action={respondAction} className="row">
              <Hidden id={c.id} />
              <input type="hidden" name="decision" value="decline" />
              <input type="text" name="reason" placeholder="Reason (optional)" style={{ width: "auto" }} />
              <button className="btn">Decline</button>
            </form>
          )}
          {may("start_work") && (
            <form action={startAction}>
              <Hidden id={c.id} />
              <button className="btn primary">Start the work</button>
            </form>
          )}
          {may("complete") && (
            <form action={completeAction}>
              <Hidden id={c.id} />
              <button className="btn primary">Mark complete (ends client-detail access)</button>
            </form>
          )}
          {may("withdraw") && (
            <form action={withdrawAction}>
              <Hidden id={c.id} />
              <button className="btn">Withdraw</button>
            </form>
          )}
        </div>
      )}

      <h2>Terms</h2>
      <p className="small muted">
        Compensation says who gets paid; authority says who decides. Proposing a version accepts it on your side; it becomes binding when the other side
        accepts the same version. An agreed version stays in force until both accept an amendment.
      </p>
      {terms.length === 0 && <p className="empty">No terms proposed yet.</p>}
      {[...terms].reverse().map((t) => {
        const mine = side === "requester" ? t.requesterAcceptedAt : side === "specialist" ? t.specialistAcceptedAt : null;
        const isLatest = latest?.version === t.version;
        return (
          <section key={t.id} className="card">
            <div className="row">
              <b>v{t.version}</b>
              <span className="small muted">
                proposed by {t.proposedBySide} {t.createdAt.slice(0, 10)}
              </span>
              <span className="grow" />
              {t.version === c.agreedTermsVersion ? (
                <span className="chip ok">agreed</span>
              ) : t.supersededAt ? (
                <span className="chip">superseded</span>
              ) : (
                <span className="chip warn">
                  {t.requesterAcceptedAt ? "requester accepted" : "requester to accept"} · {t.specialistAcceptedAt ? "specialist accepted" : "specialist to accept"}
                </span>
              )}
            </div>
            <TermsView t={t.terms} name={name} />
            {side && isLatest && !mine && !t.supersededAt && may("accept_terms") && (
              <form action={acceptTermsAction}>
                <Hidden id={c.id} />
                <input type="hidden" name="version" value={t.version} />
                <input type="hidden" name="fingerprint" value={t.fingerprint} />
                <div className="actions">
                  <button className="btn primary">Accept v{t.version}</button>
                </div>
              </form>
            )}
          </section>
        );
      })}

      {may("propose_terms") && (
        <details className="card">
          <summary>{terms.length ? "Propose different terms" : "Propose terms"}</summary>
          <form action={proposeTermsAction}>
            <Hidden id={c.id} />
            <div className="grid2">
              <div>
                <label htmlFor="finalRecommendationOwner">Owns the final recommendation</label>
                <select id="finalRecommendationOwner" name="finalRecommendationOwner" className="field" defaultValue={draft ? sideOfMember(draft.authority.finalRecommendationOwner) : "requester"}>
                  <option value="requester">{c.requesterName} (requester)</option>
                  <option value="specialist">{c.specialistName} (specialist)</option>
                </select>
              </div>
              <div>
                <label htmlFor="clientAccessExpiresAt">Client-detail access ends</label>
                <input
                  id="clientAccessExpiresAt"
                  type="date"
                  name="clientAccessExpiresAt"
                  required
                  min={now.toISOString().slice(0, 10)}
                  defaultValue={(draft?.clientAccessExpiresAt ?? new Date(now.getTime() + 60 * 86_400_000).toISOString()).slice(0, 10)}
                />
              </div>
            </div>
            <label htmlFor="delegatedDecisions">Decisions delegated to the specialist (one per line)</label>
            <textarea id="delegatedDecisions" name="delegatedDecisions" style={{ minHeight: 60 }} defaultValue={draft?.authority.delegatedDecisions.join("\n") ?? ""} />
            <label htmlFor="changesRequiringSpecialistReview">Changes that need the specialist's renewed review (one per line)</label>
            <textarea
              id="changesRequiringSpecialistReview"
              name="changesRequiringSpecialistReview"
              style={{ minHeight: 60 }}
              defaultValue={draft?.authority.changesRequiringSpecialistReview.join("\n") ?? ""}
            />
            <label htmlFor="deliveryOwners">Who owns delivery and recovery, per service (e.g. “Paris hotel: requester”)</label>
            <textarea
              id="deliveryOwners"
              name="deliveryOwners"
              style={{ minHeight: 60 }}
              defaultValue={draft ? Object.entries(draft.authority.deliveryOwners).map(([s, m]) => `${s}: ${sideOfMember(m)}`).join("\n") : ""}
            />
            <div className="grid2">
              <div>
                <label htmlFor="attributionRule">When the specialist's name may be attached</label>
                <select id="attributionRule" name="attributionRule" className="field" defaultValue={draft?.authority.attributionRule ?? "with_endorsement"}>
                  <option value="with_endorsement">Only while their endorsement holds</option>
                  <option value="never">Never</option>
                  <option value="always">Always</option>
                </select>
              </div>
              <div>
                <label htmlFor="reversalLossBearer">If a payout is later reversed, the loss is borne by</label>
                <select id="reversalLossBearer" name="reversalLossBearer" className="field" defaultValue={draft?.reversalLossBearer ?? "shared_pro_rata"}>
                  <option value="shared_pro_rata">Both, pro rata</option>
                  <option value="requester">The requester</option>
                  <option value="specialist">The specialist</option>
                </select>
              </div>
            </div>
            <label style={{ color: "inherit" }}>
              <input type="checkbox" name="specialistVisibleToClient" defaultChecked={draft?.authority.specialistVisibleToClient ?? false} /> The client sees the
              specialist (otherwise behind the scenes)
            </label>
            <label style={{ color: "inherit" }}>
              <input type="checkbox" name="nonSolicit" defaultChecked={draft?.nonSolicit ?? true} /> Non-solicit: the specialist won't approach this client
            </label>
            <h3 style={{ marginTop: 16 }}>Compensation</h3>
            <p className="small muted">
              Commission splits apply to commission actually received on specific booking lines, after adjustments; fixed fees pay for advice, design, referral
              or execution without a booking. No suggested “fair” split: you agree it.
            </p>
            {Array.from({ length: FEE_ROWS }, (_, i) => {
              const f = draft?.fees[i];
              return (
                <div key={i} className="card small">
                  <div className="grid2">
                    <div>
                      <label htmlFor={`fee_kind_${i}`}>Fee {i + 1}</label>
                      <select id={`fee_kind_${i}`} name={`fee_kind_${i}`} className="field" defaultValue={f?.kind ?? ""}>
                        <option value="">—</option>
                        {Object.entries(FEE_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`fee_payee_${i}`}>Paid to</label>
                      <select id={`fee_payee_${i}`} name={`fee_payee_${i}`} className="field" defaultValue={f?.payee ?? "specialist"}>
                        <option value="specialist">Specialist</option>
                        <option value="requester">Requester</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`fee_amount_${i}`}>Fixed amount</label>
                      <input
                        id={`fee_amount_${i}`}
                        type="text"
                        name={`fee_amount_${i}`}
                        inputMode="decimal"
                        defaultValue={f?.amount ? String(f.amount.amountMinor / 10 ** minorDigits(f.amount.currency)) : ""}
                        placeholder="e.g. 500"
                      />
                    </div>
                    <div>
                      <label htmlFor={`fee_currency_${i}`}>Currency</label>
                      <input id={`fee_currency_${i}`} type="text" name={`fee_currency_${i}`} maxLength={3} defaultValue={f?.amount?.currency ?? "USD"} />
                    </div>
                    <div>
                      <label htmlFor={`fee_pct_${i}`}>Commission share (%)</label>
                      <input
                        id={`fee_pct_${i}`}
                        type="text"
                        name={`fee_pct_${i}`}
                        inputMode="decimal"
                        defaultValue={f?.commissionShareBps != null ? String(f.commissionShareBps / 100) : ""}
                        placeholder="e.g. 20"
                      />
                    </div>
                    <div>
                      <label>On booking lines</label>
                      {itemLabels.size === 0 ? (
                        <span className="small muted">{side === "requester" ? "Link a trip to split commission" : "None offered yet"}</span>
                      ) : (
                        [...itemLabels].map(([bid, label]) => (
                          <label key={bid} style={{ display: "block", color: "inherit" }}>
                            <input type="checkbox" name={`fee_items_${i}`} value={bid} defaultChecked={f?.bookingItemIds.includes(bid) ?? false} /> {label}
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <label htmlFor="notes">Notes</label>
            <textarea id="notes" name="notes" style={{ minHeight: 60 }} defaultValue={draft?.notes ?? ""} />
            <div className="actions">
              <button className="btn primary">Propose and accept on my side</button>
            </div>
          </form>
        </details>
      )}

      {side === "requester" && agreed && (
        <>
          <h2>Money</h2>
          {(() => {
            const billable = items.filter((i) => agreed.terms.fees.some((f) => f.bookingItemIds.includes(i.id)));
            if (billable.length === 0) return <p className="empty">The agreed terms have no fees tied to a booking on this trip.</p>;
            if (recipients.length === 0)
              return (
                <p className="small muted">
                  Add the specialist as a payee in <Link href="/money/recipients">Money → Payees</Link> to record how commission on these bookings is split.
                </p>
              );
            return (
              <form action={recordSplitAction} className="card">
                <input type="hidden" name="collaborationId" value={c.id} />
                <p className="small muted">Records the agreed fee lines as this booking&apos;s split terms (a draft you agree in Money before anything is paid).</p>
                <label htmlFor="itemId">Booking</label>
                <select id="itemId" name="itemId" className="field">
                  {billable.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title}
                    </option>
                  ))}
                </select>
                <label htmlFor="recipientId">Pay the specialist as</label>
                <select id="recipientId" name="recipientId" className="field">
                  {recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <label htmlFor="hostRulesOurs">Our host agreement allows sharing commission</label>
                <select id="hostRulesOurs" name="hostRulesOurs" className="field" defaultValue="unknown">
                  <option value="unknown">Not checked yet</option>
                  <option value="permitted">Yes</option>
                  <option value="not_permitted">No</option>
                </select>
                <label htmlFor="hostRulesTheirs">Their host agreement allows receiving it</label>
                <select id="hostRulesTheirs" name="hostRulesTheirs" className="field" defaultValue="unknown">
                  <option value="unknown">Not checked yet</option>
                  <option value="permitted">Yes</option>
                  <option value="not_permitted">No</option>
                </select>
                <div className="actions">
                  <button className="btn">Record split</button>
                </div>
              </form>
            );
          })()}
        </>
      )}

      <h2>Client details</h2>
      {side === "specialist" && !accessOpen && (
        <p className="empty">
          {c.state === "requested" || c.state === "brief_shared"
            ? "Client details open once you and the requester accept the same terms."
            : "Your access to client details has ended."}
        </p>
      )}
      {side === "specialist" && accessOpen && <p className="small muted">Visible to you until {c.clientAccessExpiresAt?.slice(0, 10)} or until the work ends.</p>}
      {side === "requester" && (
        <p className="small muted">
          The specialist sees these only while agreed terms are in force and until {c.clientAccessExpiresAt?.slice(0, 10) ?? "the agreed expiry"}. Share only what
          the work needs.
        </p>
      )}
      {shares.map((s) => {
        const e = endorsedShares.get(s.id);
        return (
          <section key={s.id} className="card small">
            <div className="row">
              <b>{s.label}</b>
              <span className="muted">{s.kind.replace("_", " ")}</span>
              {s.revokedAt && <span className="chip">revoked</span>}
              {e && (
                <span className={e.holds === true ? "chip ok" : e.holds === false ? "chip alert" : "chip"}>
                  {e.holds === true ? "endorsed" : e.holds === false ? "endorsement lapsed: needs review" : "endorsed (can't check now)"}
                </span>
              )}
              <span className="grow" />
              {side === "requester" && !s.revokedAt && s.kind !== "note" && (
                <form action={refreshShareAction}>
                  <Hidden id={c.id} />
                  <input type="hidden" name="shareId" value={s.id} />
                  <button className="btn small">Update from source</button>
                </form>
              )}
              {side === "requester" && !s.revokedAt && (
                <form action={revokeShareAction}>
                  <Hidden id={c.id} />
                  <input type="hidden" name="shareId" value={s.id} />
                  <button className="btn small">Revoke</button>
                </form>
              )}
            </div>
            <ul className="plain">
              {Object.entries(s.content)
                .filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
                .map(([k, v]) => (
                  <li key={k}>
                    <span className="muted">{k}:</span>{" "}
                    {typeof v === "object" && v && "amountMinor" in v ? formatMoney(v as { amountMinor: number; currency: string }) : Array.isArray(v) ? v.join(", ") : String(v)}
                  </li>
                ))}
            </ul>
            {side === "specialist" && s.kind === "trip_item" && may("endorse") && (!e || e.holds !== true) && (
              <form action={endorseAction} className="row">
                <Hidden id={c.id} />
                <input type="hidden" name="shareId" value={s.id} />
                <input type="text" name="note" placeholder="Note (optional)" className="grow" style={{ width: "auto" }} />
                <button className="btn">Endorse this recommendation</button>
              </form>
            )}
          </section>
        );
      })}
      {side === "requester" && may("share") && trip && (
        <form action={shareAction} className="card row">
          <Hidden id={c.id} />
          <select name="source" aria-label="Detail to share" className="grow">
            {trip.clientId && !sharedKeys.has(`client:${trip.clientId}`) && <option value={`client:${trip.clientId}`}>Client name: {trip.clientName}</option>}
            {items
              .filter((it) => !sharedKeys.has(`trip_item:${it.id}`))
              .map((it) => (
                <option key={it.id} value={`trip_item:${it.id}`}>
                  Recommendation: {it.title}
                </option>
              ))}
            {statements
              .filter((s) => !sharedKeys.has(`brief_statement:${s.id}`))
              .map((s) => (
                <option key={s.id} value={`brief_statement:${s.id}`}>
                  Brief: {s.text.slice(0, 70)}
                </option>
              ))}
          </select>
          <button className="btn">Share</button>
        </form>
      )}
      {side === "requester" && may("share") && (
        <form action={shareAction} className="card row">
          <Hidden id={c.id} />
          <input type="hidden" name="source" value="note" />
          <input type="text" name="text" placeholder="Share a note the work needs" className="grow" style={{ width: "auto" }} maxLength={4000} />
          <button className="btn">Share note</button>
        </form>
      )}
      {endorsements.some((e) => e.holds !== null) && (
        <p className="small muted">
          {endorsements.some((e) => e.nameMayAppear) ? `${c.specialistName}'s name may appear on endorsed recommendations.` : `${c.specialistName}'s name isn't attached to the result under these terms.`}
        </p>
      )}

      <h2>Relationship activations</h2>
      <p className="small muted">An intro or an ask on another member's behalf. The relationship holder answers every one; a past yes never answers a new ask.</p>
      {activations.length === 0 && <p className="empty">None.</p>}
      {activations.map((a) => (
        <section key={a.id} className="card small">
          <div className="row">
            <b className="grow">{a.relationshipHint}</b>
            <span className={a.decision === "yes" ? "chip ok" : a.decision === "no" ? "chip alert" : "chip warn"}>
              {a.decision === "pending" ? `waiting for ${c.specialistName}` : a.decision}
            </span>
          </div>
          <p>{a.ask}</p>
          {a.decisionNote && <p className="muted">“{a.decisionNote}”</p>}
          {a.decision === "pending" && a.holderMemberId === me.tenant.memberId && (
            <form action={activationDecideAction} className="row">
              <Hidden id={c.id} />
              <input type="hidden" name="activationId" value={a.id} />
              <input type="text" name="note" placeholder="Note (optional)" className="grow" style={{ width: "auto" }} />
              <button className="btn primary" name="decision" value="yes">
                Yes
              </button>
              <button className="btn" name="decision" value="no">
                No
              </button>
            </form>
          )}
        </section>
      ))}
      {may("request_activation") && (
        <form action={activationRequestAction} className="card">
          <Hidden id={c.id} />
          <label htmlFor="relationshipHint">Whose relationship</label>
          <input id="relationshipHint" type="text" name="relationshipHint" required maxLength={300} placeholder="e.g. the GM you know at a Marais hotel" />
          <label htmlFor="ask">The ask</label>
          <textarea id="ask" name="ask" required maxLength={2000} style={{ minHeight: 60 }} />
          <div className="actions">
            <button className="btn">Ask {c.specialistName}</button>
          </div>
        </form>
      )}

      <h2>Contribution log</h2>
      <div className="card table-wrap">
        <table>
          <tbody>
            {log.map((l) => (
              <tr key={l.id}>
                <td className="small muted">{l.at.slice(0, 16).replace("T", " ")}</td>
                <td className="small">{l.actorSide === "system" ? "Platform" : name(l.actorMemberId)}</td>
                <td className="small">
                  {l.kind.replace(/_/g, " ")}
                  {typeof l.detail.text === "string" && `: ${l.detail.text}`}
                  {typeof l.detail.version === "number" && ` v${l.detail.version}`}
                  {typeof l.detail.label === "string" && ` (${l.detail.label})`}
                  {typeof l.detail.decision === "string" && `: ${l.detail.decision}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {side && (
        <form action={logAction} className="card row">
          <Hidden id={c.id} />
          <select name="kind" aria-label="Entry type">
            <option value="note">Note</option>
            <option value="amendment">Amendment</option>
            <option value="dispute">Dispute</option>
          </select>
          <input type="text" name="text" required maxLength={4000} className="grow" style={{ width: "auto" }} placeholder="What happened, for the record" />
          <button className="btn">Add</button>
        </form>
      )}
    </main>
  );
}
