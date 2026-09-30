import Link from "next/link";
import { notFound } from "next/navigation";
import { agentsConfigured } from "@/agents/llm";
import { withTenant } from "@/db/tenant";
import { briefForTrip, type BriefDimension } from "@/domain/brief";
import { canManageClient, canPromote, clientScopeRules, DIMENSION_LABEL, OUTCOME_KINDS, OUTCOME_LABEL } from "@/domain/clientBook";
import { getDb, requireMember } from "@/lib/server";
import { getSettings } from "@/modules/ops/admin";
import { DIMENSIONS, getClientDetail, type ClientDetail } from "@/modules/ops/clients";
import {
  acceptSuggestionAction,
  addPartyAction,
  addStatementAction,
  deleteClientAction,
  dismissSuggestionAction,
  extractBriefAction,
  promoteStatementAction,
  reassignClientAction,
  recordOutcomeAction,
  removePartyAction,
  supersedeStatementAction,
  updateClientAction,
} from "../actions";

export const metadata = { title: "Client" };
export const dynamic = "force-dynamic";

const EVIDENCE: Record<string, [string, string]> = {
  client_said: ["client said", "ok"],
  expert_inferred: ["expert inferred", ""],
  agent_inferred: ["agent inferred, unconfirmed", "warn"],
};

type Statement = ClientDetail["statements"][number];

function EvidenceChip({ evidence }: { evidence: string }) {
  const [label, tone] = EVIDENCE[evidence] ?? [evidence, ""];
  return <span className={`chip ${tone}`}>{label}</span>;
}

function StatementItem({ s, back, clientId, promote }: { s: Statement; back: string; clientId: string; promote: boolean }) {
  return (
    <li>
      {s.outcomeKind && <b>{OUTCOME_LABEL[s.outcomeKind as keyof typeof OUTCOME_LABEL]}: </b>}
      {s.text} <EvidenceChip evidence={s.evidence} />
      <div className="small muted">
        {s.source} · {s.recordedAt.slice(0, 10)}
      </div>
      <details className="small">
        <summary className="muted">Correct{promote && s.tripId && s.dimension !== "outcomes" ? " or make enduring" : ""}</summary>
        <form action={supersedeStatementAction}>
          <input type="hidden" name="statementId" value={s.id} />
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="clientId" value={clientId} />
          <label htmlFor={`t-${s.id}`}>Corrected statement (the original is kept in history)</label>
          <input id={`t-${s.id}`} name="text" type="text" defaultValue={s.text} required minLength={3} />
          <select name="evidence" className="field" defaultValue={s.evidence === "client_said" ? "client_said" : "expert_inferred"} aria-label="Evidence">
            <option value="client_said">The client said it</option>
            <option value="expert_inferred">I infer it</option>
          </select>
          <div className="actions">
            <button className="btn small">Save correction</button>
          </div>
        </form>
        {promote && s.tripId && s.dimension !== "outcomes" && (
          <form action={promoteStatementAction} className="actions">
            <input type="hidden" name="statementId" value={s.id} />
            <input type="hidden" name="back" value={back} />
            <button className="btn small">Make enduring (applies to every future trip)</button>
          </form>
        )}
      </details>
    </li>
  );
}

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string; trip?: string }> }) {
  const { id } = await params;
  const { error, ok, trip: tripParam } = await searchParams;
  const { tenant, member } = await requireMember();
  const db = await getDb();
  const client = await getClientDetail(db, tenant, id).catch(() => null);
  if (!client) notFound();
  const [settings, members] = await Promise.all([
    getSettings(db, tenant),
    withTenant(db, tenant, async (q) => (await q.query<{ id: string; name: string }>("select id, name from members where disabled_at is null order by name")).rows),
  ]);
  const trip = client.trips.find((t) => t.id === tripParam) ?? client.trips.at(-1) ?? null;
  const back = `/clients/${id}${trip ? `?trip=${trip.id}` : ""}`;
  const brief = trip ? briefForTrip(client.statements, id, trip.id) : null;
  const live = client.statements.filter((s) => !s.supersededBy);
  const enduring = live.filter((s) => s.tripId === null);
  const history = client.statements.filter((s) => s.supersededBy);
  const manage = canManageClient(settings.bookPortability, member, client.ownerId);
  const promote = canPromote(member.role);
  const scopes = clientScopeRules(settings.bookPortability).allowed;
  const tripName = (tid: string | null) => client.trips.find((t) => t.id === tid)?.title ?? "—";

  return (
    <main>
      <p className="small">
        <Link href="/clients">← Clients</Link>
      </p>
      <h1>{client.name}</h1>
      <p className="lede">
        Held by {client.ownerId === member.id ? "you" : client.ownerName} · {client.scope === "private" ? "private to the holder and delegates" : "shared with the workspace"}
        {client.email ? ` · ${client.email}` : ""}
        {client.phone ? ` · ${client.phone}` : ""}
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {client.erased && <p className="notice">This client&apos;s personal data was erased under a deletion request. Bookings and ledger history remain.</p>}

      {!client.erased && (
        <>
          <h2>Brief</h2>
          <p className="small muted">
            Enduring preferences apply to every trip; trip needs stay with their trip, so one trip&apos;s assumptions don&apos;t follow the client to the next.
          </p>
          {client.trips.length > 0 && (
            <form className="row small" method="get">
              <label htmlFor="trip" style={{ margin: 0 }}>
                Showing needs for
              </label>
              <select id="trip" name="trip" defaultValue={trip?.id}>
                {client.trips.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
              <button className="btn small">Show</button>
            </form>
          )}
          <div className="grid2" style={{ marginTop: 12 }}>
            {DIMENSIONS.filter((d) => d !== "outcomes").map((dim: BriefDimension) => {
              const e = enduring.filter((s) => s.dimension === dim);
              // Exactly briefForTrip's view of this trip, with the row details the page shows.
              const ids = new Set(brief ? brief.thisTrip.filter((s) => s.dimension === dim).map((s) => s.id) : []);
              const t = live.filter((s) => ids.has(s.id));
              return (
                <section key={dim} className="card">
                  <h3>{DIMENSION_LABEL[dim]}</h3>
                  <div className="small muted">Enduring</div>
                  {e.length === 0 ? (
                    <p className="empty small">Nothing yet.</p>
                  ) : (
                    <ul className="plain small">
                      {e.map((s) => (
                        <StatementItem key={s.id} s={s} back={back} clientId={id} promote={promote} />
                      ))}
                    </ul>
                  )}
                  {trip && (
                    <>
                      <div className="small muted" style={{ marginTop: 8 }}>
                        This trip: {trip.title}
                      </div>
                      {t.length === 0 ? (
                        <p className="empty small">Nothing yet.</p>
                      ) : (
                        <ul className="plain small">
                          {t.map((s) => (
                            <StatementItem key={s.id} s={s} back={back} clientId={id} promote={promote} />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </section>
              );
            })}
          </div>

          <details className="card">
            <summary>Add to the brief</summary>
            <form action={addStatementAction}>
              <input type="hidden" name="clientId" value={id} />
              <input type="hidden" name="back" value={back} />
              <label htmlFor="dimension">Dimension</label>
              <select id="dimension" name="dimension" className="field">
                {DIMENSIONS.filter((d) => d !== "outcomes").map((d) => (
                  <option key={d} value={d}>
                    {DIMENSION_LABEL[d]}
                  </option>
                ))}
              </select>
              <label htmlFor="applies">Applies to</label>
              <select id="applies" name="tripId" className="field" defaultValue={trip?.id ?? ""}>
                <option value="">Every trip (enduring)</option>
                {client.trips.map((t) => (
                  <option key={t.id} value={t.id}>
                    Only {t.title}
                  </option>
                ))}
              </select>
              <label htmlFor="text">Statement: specific beats generic (&quot;dislikes visibly formal service&quot;, not &quot;likes luxury&quot;)</label>
              <input id="text" name="text" type="text" required minLength={3} maxLength={2000} />
              <label htmlFor="evidence">Evidence</label>
              <select id="evidence" name="evidence" className="field">
                <option value="client_said">The client said it</option>
                <option value="expert_inferred">I infer it</option>
              </select>
              <label htmlFor="source">Source</label>
              <input id="source" name="source" type="text" placeholder="call 2026-09-30" maxLength={200} />
              <div className="actions">
                <button className="btn primary">Add</button>
              </div>
            </form>
          </details>

          <h2>From call notes or email</h2>
          {client.suggestions.length > 0 && (
            <div className="card">
              <h3>Suggestions to review</h3>
              <p className="small muted">Nothing is added until you accept it. Anything the client didn&apos;t say stays marked as the agent&apos;s inference.</p>
              <ul className="plain">
                {client.suggestions.map((s) => (
                  <li key={s.id} className="row">
                    <span className="grow small">
                      <b>{DIMENSION_LABEL[s.dimension]}:</b> {s.text} <EvidenceChip evidence={s.evidence} />{" "}
                      <span className="chip">{s.tripId ? tripName(s.tripId) : s.tripSpecific ? "one trip" : "enduring"}</span>
                    </span>
                    <form action={acceptSuggestionAction} className="row">
                      <input type="hidden" name="suggestionId" value={s.id} />
                      <input type="hidden" name="back" value={back} />
                      {s.tripSpecific && !s.tripId && (
                        <select name="tripId" aria-label="Trip" required defaultValue={trip?.id}>
                          {client.trips.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.title}
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="btn small primary" disabled={s.tripSpecific && !s.tripId && client.trips.length === 0}>
                        Accept
                      </button>
                    </form>
                    <form action={dismissSuggestionAction}>
                      <input type="hidden" name="suggestionId" value={s.id} />
                      <input type="hidden" name="back" value={back} />
                      <button className="btn small">Dismiss</button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {agentsConfigured() ? (
            <form action={extractBriefAction} className="card">
              <input type="hidden" name="clientId" value={id} />
              <input type="hidden" name="back" value={back} />
              <label htmlFor="src">Paste call notes or an email. The agent proposes brief statements; you choose what to keep.</label>
              <textarea id="src" name="text" required maxLength={100_000} />
              <div className="row">
                <div className="grow">
                  <label htmlFor="sl">Source label</label>
                  <input id="sl" name="sourceLabel" type="text" placeholder="call 2026-09-30" maxLength={200} />
                </div>
                <div className="grow">
                  <label htmlFor="xt">About</label>
                  <select id="xt" name="tripId" className="field" defaultValue={trip?.id ?? ""}>
                    <option value="">No specific trip</option>
                    {client.trips.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="actions">
                <button className="btn primary">Extract suggestions</button>
              </div>
            </form>
          ) : (
            <p className="notice small">The extraction agent isn&apos;t configured in this environment. Add statements by hand above.</p>
          )}
          {client.extractions.length > 0 && (
            <ul className="plain small muted">
              {client.extractions.slice(0, 5).map((e) => (
                <li key={e.id}>
                  {e.sourceLabel} · {e.createdAt.slice(0, 16).replace("T", " ")} · <span className={`chip ${e.status === "failed" ? "alert" : e.status === "done" ? "ok" : "warn"}`}>{e.status}</span>
                  {e.error && ` ${e.error}`}
                </li>
              ))}
            </ul>
          )}

          <h2>Outcomes</h2>
          {client.trips.length === 0 ? (
            <p className="empty">Outcomes are recorded after a trip.</p>
          ) : (
            client.trips.map((t) => {
              const outcomes = live.filter((s) => s.dimension === "outcomes" && s.tripId === t.id);
              return (
                <section key={t.id} className="card">
                  <h3>{t.title}</h3>
                  {OUTCOME_KINDS.map((k) => {
                    const list = outcomes.filter((s) => s.outcomeKind === k);
                    return list.length ? (
                      <ul key={k} className="plain small">
                        {list.map((s) => (
                          <StatementItem key={s.id} s={s} back={back} clientId={id} promote={false} />
                        ))}
                      </ul>
                    ) : null;
                  })}
                  {outcomes.length === 0 && <p className="empty small">Nothing recorded yet.</p>}
                  <details className="small">
                    <summary className="muted">Record an outcome</summary>
                    <form action={recordOutcomeAction}>
                      <input type="hidden" name="clientId" value={id} />
                      <input type="hidden" name="tripId" value={t.id} />
                      <input type="hidden" name="back" value={back} />
                      <select name="kind" className="field" aria-label="Kind">
                        {OUTCOME_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {OUTCOME_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      <input name="text" type="text" required minLength={3} aria-label="What" placeholder="The chef's counter in Oaxaca" />
                      <select name="evidence" className="field" aria-label="Evidence">
                        <option value="client_said">The client said it</option>
                        <option value="expert_inferred">I infer it</option>
                      </select>
                      <div className="actions">
                        <button className="btn small primary">Record</button>
                      </div>
                    </form>
                  </details>
                </section>
              );
            })
          )}

          <h2>Party</h2>
          <div className="card">
            {client.party.length === 0 ? (
              <p className="empty">No party members recorded.</p>
            ) : (
              <ul className="plain">
                {client.party.map((p) => (
                  <li key={p.id} className="row">
                    <span className="grow">
                      {p.name}
                      {p.relation && <span className="muted"> · {p.relation}</span>}
                      {p.notes && <div className="small muted">{p.notes}</div>}
                    </span>
                    {!p.erased && (
                      <form action={removePartyAction}>
                        <input type="hidden" name="partyMemberId" value={p.id} />
                        <input type="hidden" name="back" value={back} />
                        <button className="btn small">Remove</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="small muted">Add someone</summary>
              <form action={addPartyAction}>
                <input type="hidden" name="clientId" value={id} />
                <label htmlFor="pn">Name</label>
                <input id="pn" name="name" type="text" required maxLength={200} />
                <label htmlFor="pr">Role in the party</label>
                <input id="pr" name="relation" type="text" placeholder="decides on hotels" maxLength={200} />
                <label htmlFor="pnotes">Notes (encrypted)</label>
                <input id="pnotes" name="notes" type="text" />
                <div className="actions">
                  <button className="btn small primary">Add</button>
                </div>
              </form>
            </details>
          </div>

          <h2>Details</h2>
          <div className="grid2">
            <form action={updateClientAction} className="card">
              <input type="hidden" name="clientId" value={id} />
              <label htmlFor="cn">Name</label>
              <input id="cn" name="name" type="text" defaultValue={client.name} required minLength={2} />
              <label htmlFor="ce">Email</label>
              <input id="ce" name="email" type="email" defaultValue={client.email ?? ""} />
              <label htmlFor="cp">Phone</label>
              <input id="cp" name="phone" type="text" defaultValue={client.phone ?? ""} />
              <label htmlFor="cno">Private notes (encrypted)</label>
              <textarea id="cno" name="notes" defaultValue={client.notes ?? ""} />
              <div className="actions">
                <button className="btn primary">Save</button>
              </div>
            </form>
            {manage && (
              <div>
                <form action={reassignClientAction} className="card">
                  <input type="hidden" name="clientId" value={id} />
                  <label htmlFor="own">Held by</label>
                  <select id="own" name="ownerId" className="field" defaultValue={client.ownerId}>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="sc">Visible to</label>
                  <select id="sc" name="scope" className="field" defaultValue={client.scope}>
                    {scopes.map((s) => (
                      <option key={s} value={s}>
                        {s === "private" ? "The holder and their delegates" : "Everyone in the workspace"}
                      </option>
                    ))}
                  </select>
                  <div className="actions">
                    <button className="btn">Move client</button>
                  </div>
                </form>
                {client.trips.length === 0 && (
                  <form action={deleteClientAction} className="card row">
                    <input type="hidden" name="clientId" value={id} />
                    <span className="grow small muted">No trips yet, so this client can be deleted outright.</span>
                    <button className="btn">Delete client</button>
                  </form>
                )}
              </div>
            )}
          </div>

          {history.length > 0 && (
            <details className="card small">
              <summary>History ({history.length} replaced statements)</summary>
              <ul className="plain">
                {history.map((s) => (
                  <li key={s.id} className="muted">
                    <s>{s.text}</s> · {s.tripId ? tripName(s.tripId) : "enduring"} · {s.recordedAt.slice(0, 10)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </main>
  );
}
