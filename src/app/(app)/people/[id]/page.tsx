import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { formatMoney } from "@/domain/common";
import { chipAdvice, currentRole, type LedgerEntryKind } from "@/domain/crm";
import { preCallBrief, type AskImportance } from "@/domain/crmBrief";
import { getDb, requireMember } from "@/lib/server";
import { dependentKnowledge, getPerson, listDrafts, listLedger, nudgesFor, STORE_GUARDRAIL } from "@/modules/crm/people";
import {
  clientTieAction,
  deleteLedgerAction,
  deletePersonAction,
  discardDraftAction,
  draftNoteAction,
  logLedgerAction,
  recordMoveAction,
  updatePersonAction,
} from "../actions";
import { DraftComposer } from "./DraftComposer";

export const metadata = { title: "Relationship" };
export const dynamic = "force-dynamic";

const KIND_LABEL: Record<LedgerEntryKind, string> = {
  favor_asked: "Favor asked",
  favor_granted: "Favor granted",
  favor_declined: "Favor declined",
  business_sent: "Business sent",
  recognition_given: "Recognition given",
  touch: "Touch",
};

const ADVICE_TONE = { ask: "ok", save: "warn", give_first: "alert" } as const;
const IMPORTANCE: AskImportance[] = ["routine", "important", "critical"];

type Search = { error?: string; ok?: string; advice?: string; reason?: string; askType?: string; importance?: string; note?: string };

export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const me = await requireMember();
  const now = new Date();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const person = await getPerson(q, me.tenant, id);
    if (!person) return null;
    const [ledger, clients, knowledge, drafts] = await Promise.all([
      listLedger(q, id),
      q.query<{ id: string; name: string }>("select id, name from clients order by name").then((r) => r.rows),
      dependentKnowledge(q, id),
      person.ownerId === me.member.id ? listDrafts(q, me.tenant, id) : Promise.resolve([]),
    ]);
    return { person, ledger, clients, knowledge, drafts };
  });
  if (!data) notFound();
  const { person, ledger, clients, knowledge, drafts } = data;
  const isOwner = person.ownerId === me.member.id;
  const canEdit = isOwner || me.member.role === "owner" || me.member.role === "admin";
  const importance = (IMPORTANCE.includes(sp.importance as AskImportance) ? sp.importance : "routine") as AskImportance;
  const brief = preCallBrief(person, ledger, now, { texture: person.textureVisible, clientNames: person.clients.map((c) => c.name), importance });
  const role = currentRole(person);
  const nudges = nudgesFor(person, ledger, me.tenant, now);
  const untied = clients.filter((c) => !person.clients.some((t) => t.id === c.id));

  return (
    <main>
      <p className="small muted">
        <Link href="/people">Relationships</Link> /
      </p>
      <h1>{person.name}</h1>
      <p className="lede">
        {role ? `${role.title}, ${role.organization}` : "No current role"} · held by {isOwner ? "you" : person.ownerName} · {person.scope}
        {person.source !== "manual" ? ` · from ${person.source.replace("_", " ")}` : ""}
      </p>
      {sp.error && <p className="notice error">{sp.error}</p>}
      {sp.ok && <p className="notice">{sp.ok}</p>}

      <h2>Pre-call brief</h2>
      <section className="card">
        <div className="row">
          <b className="grow">{brief.headline}</b>
          <form method="get" className="row small">
            <label htmlFor="imp" style={{ margin: 0 }}>
              If I ask for something
            </label>
            <select id="imp" name="importance" defaultValue={importance}>
              {IMPORTANCE.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
            <button className="btn small">Check</button>
          </form>
        </div>
        <div className="rec">
          <b>Ask timing:</b>{" "}
          <span className={`chip ${brief.askTiming.tooSoon ? "warn" : "ok"}`}>{brief.askTiming.tooSoon ? "too soon" : "fine to ask"}</span>{" "}
          {brief.askTiming.reasons.join(" · ") || "Nothing open, nothing recent."}
        </div>
        {brief.measuredOn && (
          <div className="rec">
            <b>Measured on:</b> {brief.measuredOn}. Good asks help them hit their number.
          </div>
        )}
        {brief.approach.length > 0 && <div className="small muted" style={{ marginTop: 8 }}>{brief.approach.join(" · ")}</div>}
        <div className="grid2" style={{ marginTop: 12 }}>
          <div>
            <div className="small muted">Mention</div>
            <ul className="plain small">
              {brief.mention.length ? brief.mention.map((m) => <li key={m}>{m}</li>) : <li className="empty">Nothing noted</li>}
            </ul>
          </div>
          <div>
            <div className="small muted">Avoid</div>
            <ul className="plain small">
              {brief.avoid.length ? brief.avoid.map((m) => <li key={m}>{m}</li>) : <li className="empty">Nothing noted</li>}
            </ul>
          </div>
          <div>
            <div className="small muted">Open favors</div>
            <ul className="plain small">
              {brief.openFavors.length ? (
                brief.openFavors.map((o) => (
                  <li key={o.entry.id}>
                    {o.entry.note || o.entry.askType || "Favor"} · {o.ageDays} days
                  </li>
                ))
              ) : (
                <li className="empty">None</li>
              )}
            </ul>
          </div>
          <div>
            <div className="small muted">Recent</div>
            <ul className="plain small">
              {brief.recent.length ? (
                brief.recent.map((e) => (
                  <li key={e.id}>
                    {e.at.slice(0, 10)} · {KIND_LABEL[e.kind]} {e.note ? `· ${e.note}` : ""}
                  </li>
                ))
              ) : (
                <li className="empty">No interactions yet</li>
              )}
            </ul>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          Warmth: last touch {brief.warmth.lastTouch?.slice(0, 10) ?? "never"} · ledger balance {brief.warmth.balance >= 0 ? "+" : ""}
          {brief.warmth.balance} (given minus asked, 12 months) · {brief.warmth.favorsGranted} granted, {brief.warmth.favorsDeclined} declined ·{" "}
          {brief.warmth.roomNights} room nights sent
        </div>
      </section>

      {isOwner && (
        <>
          <h2 id="drafts">Notes to send</h2>
          {nudges.map((n) => (
            <form key={n.kind} action={draftNoteAction} className="card row">
              <input type="hidden" name="personId" value={person.id} />
              <input type="hidden" name="nudgeKind" value={n.kind} />
              <span className="grow">{n.message}</span>
              <button className="btn">Draft a note</button>
            </form>
          ))}
          {nudges.length === 0 && (
            <form action={draftNoteAction} className="card row">
              <input type="hidden" name="personId" value={person.id} />
              <input type="hidden" name="nudgeKind" value="going_cold" />
              <span className="grow small muted">No nudges right now. You can still draft a catch-up note.</span>
              <button className="btn">Draft a note</button>
            </form>
          )}
          {drafts.map((d) => (
            <section key={d.id} className="card">
              <div className="row small muted">
                <span className="grow">
                  Drafted {d.createdAt.slice(0, 10)} by {d.draftedBy === "agent" ? "the agent" : "template"} for you to edit. The system never sends it.
                </span>
                <form action={discardDraftAction}>
                  <input type="hidden" name="personId" value={person.id} />
                  <input type="hidden" name="draftId" value={d.id} />
                  <button className="btn small">Discard</button>
                </form>
              </div>
              <DraftComposer to={person.emails} subject={d.subject} body={d.body} />
            </section>
          ))}
        </>
      )}

      <h2 id="ledger">Reciprocity ledger</h2>
      <div className="card small">
        <b>Before you ask:</b>{" "}
        {IMPORTANCE.map((imp) => {
          const a = chipAdvice(ledger, now, { importance: imp });
          return (
            <span key={imp} style={{ marginRight: 12 }}>
              {imp}: <span className={`chip ${ADVICE_TONE[a.advice]}`}>{a.advice.replace("_", " ")}</span>
            </span>
          );
        })}
      </div>
      {sp.advice && (
        <p className="notice error">
          The ledger says <b>{sp.advice.replace("_", " ")}</b>: {sp.reason}. Tick “log it anyway” below if the ask is still right.
        </p>
      )}
      <form action={logLedgerAction} className="card">
        <input type="hidden" name="personId" value={person.id} />
        <div className="grid2">
          <div>
            <label htmlFor="kind">What happened</label>
            <select id="kind" name="kind" className="field" defaultValue={sp.advice ? "favor_asked" : "touch"}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="at">When</label>
            <input id="at" type="date" name="at" defaultValue={now.toISOString().slice(0, 10)} />
          </div>
          <div>
            <label htmlFor="askType">Ask type (favors)</label>
            <input id="askType" type="text" name="askType" defaultValue={sp.askType ?? ""} placeholder="upgrade, late_checkout, sold_out_table" maxLength={60} />
          </div>
          <div>
            <label htmlFor="importance">How much this ask matters (favors asked)</label>
            <select id="importance" name="importance" className="field" defaultValue={sp.importance ?? ""}>
              <option value="">—</option>
              {IMPORTANCE.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="roomNights">Room nights (business sent)</label>
            <input id="roomNights" type="number" name="roomNights" min={0} />
          </div>
          <div>
            <label htmlFor="revenue">Revenue in USD (business sent)</label>
            <input id="revenue" type="number" name="revenue" min={0} step="0.01" />
          </div>
        </div>
        <label htmlFor="note">Note</label>
        <input id="note" type="text" name="note" defaultValue={sp.note ?? ""} maxLength={500} />
        {sp.advice && (
          <label className="row small" style={{ color: "var(--ink)" }}>
            <input type="checkbox" name="acknowledgeAdvice" /> I&apos;ve seen the advice; log it anyway
          </label>
        )}
        <div className="actions">
          <button className="btn primary">Log</button>
        </div>
      </form>
      {ledger.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry</th>
                <th>Detail</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td>{e.at.slice(0, 10)}</td>
                  <td>
                    {KIND_LABEL[e.kind]}
                    {e.askType ? ` · ${e.askType}` : ""}
                    {e.importance ? ` · ${e.importance}` : ""}
                  </td>
                  <td>
                    {e.note}
                    {e.roomNights ? ` · ${e.roomNights} nights` : ""}
                    {e.revenueMinor ? ` · ${formatMoney({ amountMinor: e.revenueMinor, currency: "USD" })}` : ""}
                    {e.source !== "manual" ? <span className="chip"> {e.source.replace("_", " ")}</span> : null}
                  </td>
                  <td>
                    <form action={deleteLedgerAction}>
                      <input type="hidden" name="personId" value={person.id} />
                      <input type="hidden" name="entryId" value={e.id} />
                      <button className="btn small">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Role history</h2>
      <div className="card">
        <ul className="plain small">
          {[...person.roles]
            .sort((a, b) => (a.from < b.from ? 1 : -1))
            .map((r) => (
              <li key={`${r.organization}:${r.from}`}>
                <b>{r.title}</b>, {r.organization} · {r.from.slice(0, 10)} – {r.to ? r.to.slice(0, 10) : "now"}
                {r.measuredOn ? <span className="muted"> · measured on {r.measuredOn}</span> : null}
              </li>
            ))}
          {person.roles.length === 0 && <li className="empty">No roles recorded</li>}
        </ul>
      </div>
      {canEdit && (
        <form action={recordMoveAction} className="card">
          <b>Record a move</b>
          <p className="small muted">Closes the current role, opens the new one, and flags shared knowledge that depended on {person.name} for review.</p>
          <input type="hidden" name="personId" value={person.id} />
          <div className="grid2">
            <div>
              <label htmlFor="m-org">New organization</label>
              <input id="m-org" type="text" name="organization" required maxLength={200} />
            </div>
            <div>
              <label htmlFor="m-title">Title</label>
              <input id="m-title" type="text" name="title" required maxLength={200} />
            </div>
            <div>
              <label htmlFor="m-measured">Measured on</label>
              <input id="m-measured" type="text" name="measuredOn" maxLength={200} />
            </div>
            <div>
              <label htmlFor="m-from">Starting</label>
              <input id="m-from" type="date" name="from" required defaultValue={now.toISOString().slice(0, 10)} />
            </div>
          </div>
          <div className="actions">
            <button className="btn">Record move</button>
          </div>
        </form>
      )}
      {knowledge.length > 0 && (
        <div className="card small">
          <b>Knowledge that depends on {person.name}</b>
          <ul className="plain">
            {knowledge.map((k) => (
              <li key={k.id}>
                {k.category.replace(/_/g, " ")} {k.needsReview && <span className="chip warn">needs review</span>} {k.reviewReason && <span className="muted">{k.reviewReason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2 id="clients">Client ties</h2>
      <div className="card">
        {person.clients.length === 0 && <p className="empty small">Doesn&apos;t know any of your clients yet.</p>}
        <ul className="plain small">
          {person.clients.map((c) => (
            <li key={c.id} className="row">
              <span className="grow">{c.name}</span>
              {canEdit && (
                <form action={clientTieAction}>
                  <input type="hidden" name="personId" value={person.id} />
                  <input type="hidden" name="clientId" value={c.id} />
                  <input type="hidden" name="remove" value="1" />
                  <button className="btn small">Remove</button>
                </form>
              )}
            </li>
          ))}
        </ul>
        {canEdit && untied.length > 0 && (
          <form action={clientTieAction} className="row" style={{ marginTop: 8 }}>
            <input type="hidden" name="personId" value={person.id} />
            <select name="clientId" aria-label="Client">
              {untied.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input type="text" name="note" placeholder="How they know them" maxLength={300} className="grow" style={{ width: "auto" }} />
            <button className="btn">Add</button>
          </form>
        )}
      </div>

      {canEdit && (
        <>
          <h2>Details</h2>
          <form action={updatePersonAction} className="card">
            <input type="hidden" name="personId" value={person.id} />
            <p className="notice small">{STORE_GUARDRAIL}</p>
            <div className="grid2">
              <div>
                <label htmlFor="e-name">Name</label>
                <input id="e-name" type="text" name="name" required defaultValue={person.name} maxLength={200} />
              </div>
              <div>
                <label htmlFor="e-emails">Email addresses</label>
                <input id="e-emails" type="text" name="emails" defaultValue={person.emails.join(", ")} />
              </div>
              <div>
                <label htmlFor="e-channel">Preferred channel</label>
                <input id="e-channel" type="text" name="channel" defaultValue={person.approach.channel ?? ""} maxLength={80} />
              </div>
              <div>
                <label htmlFor="e-tz">Time zone</label>
                <input id="e-tz" type="text" name="timeZone" defaultValue={person.approach.timeZone ?? ""} maxLength={64} />
              </div>
              <div>
                <label htmlFor="e-lang">Language</label>
                <input id="e-lang" type="text" name="language" defaultValue={person.approach.language ?? ""} maxLength={40} />
              </div>
              <div>
                <label htmlFor="e-boss">Their boss</label>
                <input id="e-boss" type="text" name="boss" defaultValue={person.approach.boss ?? ""} maxLength={200} />
              </div>
            </div>
            <label className="row small" style={{ color: "var(--ink)" }}>
              <input type="checkbox" name="overHead" defaultChecked={person.approach.goingOverTheirHeadAcceptable} /> Going over their head is sometimes acceptable
            </label>
            {isOwner && (
              <>
                <label htmlFor="e-texture">Your notes (only you can see these; one per line)</label>
                <textarea id="e-texture" name="texture" defaultValue={(person.textureVisible ?? []).join("\n")} />
              </>
            )}
            <label htmlFor="e-scope">Visibility</label>
            <select id="e-scope" name="scope" className="field" defaultValue={person.scope}>
              <option value="private">Private to the holder</option>
              <option value="workspace">Shared with the workspace (notes stay private)</option>
            </select>
            <div className="actions">
              <button className="btn primary">Save</button>
            </div>
          </form>
          {isOwner && (
            <form action={deletePersonAction} className="card row">
              <input type="hidden" name="personId" value={person.id} />
              <span className="grow small muted">Delete this record and its ledger. Records referenced by commitments are kept.</span>
              <button className="btn">Delete</button>
            </form>
          )}
        </>
      )}
    </main>
  );
}
