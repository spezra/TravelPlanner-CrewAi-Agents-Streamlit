import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { currentRole, warmthEvidence } from "@/domain/crm";
import { getDb, requireMember } from "@/lib/server";
import { listLedger, listNotices, listPeople, nudgesFor, STORE_GUARDRAIL } from "@/modules/crm/people";
import { createPersonAction, dismissNoticeAction } from "./actions";

export const metadata = { title: "Relationships" };
export const dynamic = "force-dynamic";

export default async function People({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string; show?: string; q?: string }> }) {
  const { error, ok, show, q: query } = await searchParams;
  const me = await requireMember();
  const now = new Date();
  const { people, ledger, notices } = await withTenant(await getDb(), me.tenant, async (q) => ({
    people: await listPeople(q, me.tenant),
    ledger: await listLedger(q),
    notices: await listNotices(q),
  }));
  const needle = query?.trim().toLowerCase() ?? "";
  const shown = people
    .filter((p) => (show === "all" ? true : show === "workspace" ? p.scope === "workspace" : p.ownerId === me.member.id))
    .filter((p) => !needle || `${p.name} ${p.emails.join(" ")} ${p.roles.map((r) => r.organization).join(" ")}`.toLowerCase().includes(needle));
  const mineCount = people.filter((p) => p.ownerId === me.member.id).length;
  const nudges = people.flatMap((p) => nudgesFor(p, ledger.filter((e) => e.personId === p.id), me.tenant, now).map((n) => ({ n, p })));

  return (
    <main>
      <h1>Relationships</h1>
      <p className="lede">
        People, not properties: the relationship follows the person when they move. Warmth is shown as evidence, not a score. The agent drafts; you send
        under your own name.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      {notices.length > 0 && (
        <section>
          <h2>For you</h2>
          {notices.map((n) => (
            <div key={n.id} className="card row">
              <span className="chip warn">{n.kind.replace(/_/g, " ")}</span>
              <span className="grow">
                {n.personId ? <Link href={`/people/${n.personId}`}>{n.message}</Link> : n.message}
              </span>
              <form action={dismissNoticeAction}>
                <input type="hidden" name="noticeId" value={n.id} />
                <input type="hidden" name="back" value="/people" />
                <button className="btn small">Dismiss</button>
              </form>
            </div>
          ))}
        </section>
      )}

      {nudges.length > 0 && (
        <section>
          <h2>Nudges</h2>
          {nudges.map(({ n, p }) => (
            <div key={`${p.id}:${n.kind}`} className="card row">
              <span className="grow">{n.message}</span>
              <Link className="btn" href={`/people/${p.id}#drafts`}>
                Draft a note
              </Link>
            </div>
          ))}
        </section>
      )}

      <h2>People</h2>
      <form className="row" method="get" style={{ marginBottom: 12 }}>
        <select name="show" defaultValue={show ?? "mine"} aria-label="Show">
          <option value="mine">Mine ({mineCount})</option>
          <option value="workspace">Shared with the workspace</option>
          <option value="all">Everyone I can see ({people.length})</option>
        </select>
        <input type="text" name="q" defaultValue={query ?? ""} placeholder="Name, email or property" aria-label="Search" className="grow" style={{ width: "auto" }} />
        <button className="btn">Filter</button>
      </form>
      {shown.length === 0 && <p className="empty">No one here yet. Add someone below, or connect your email and calendar on the Integrations page.</p>}
      <div className="grid2">
        {shown.map((p) => {
          const w = warmthEvidence(
            ledger.filter((e) => e.personId === p.id),
            now,
          );
          const role = currentRole(p);
          return (
            <section key={p.id} className="card">
              <h3>
                <Link href={`/people/${p.id}`}>{p.name}</Link>
              </h3>
              <div className="small muted">
                {role ? `${role.title}, ${role.organization}` : "No current role"}
                {role?.measuredOn ? ` · measured on ${role.measuredOn}` : ""}
              </div>
              <div className="small" style={{ marginTop: 6 }}>
                <span className="chip">{p.scope}</span> <span className="chip">held by {p.ownerId === me.member.id ? "you" : p.ownerName}</span>
                {p.clients.length > 0 && <span className="chip ok">knows {p.clients.map((c) => c.name).join(", ")}</span>}
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                Last touch {w.lastTouch ? w.lastTouch.slice(0, 10) : "never"} · {w.favorsAsked} asks / {w.favorsGranted} granted · {w.businessSent} bookings ({w.roomNights}{" "}
                nights) · {w.recognitionGiven} recognition
              </div>
            </section>
          );
        })}
      </div>

      <h2 id="new">Add a person</h2>
      <form action={createPersonAction} className="card">
        <p className="notice small">{STORE_GUARDRAIL}</p>
        <div className="grid2">
          <div>
            <label htmlFor="name">Name</label>
            <input id="name" type="text" name="name" required maxLength={200} />
          </div>
          <div>
            <label htmlFor="emails">Email addresses</label>
            <input id="emails" type="text" name="emails" placeholder="comma-separated" />
          </div>
          <div>
            <label htmlFor="organization">Organization</label>
            <input id="organization" type="text" name="organization" maxLength={200} />
          </div>
          <div>
            <label htmlFor="title">Title</label>
            <input id="title" type="text" name="title" maxLength={200} />
          </div>
          <div>
            <label htmlFor="measuredOn">Measured on</label>
            <input id="measuredOn" type="text" name="measuredOn" placeholder="e.g. occupancy and reviews" maxLength={200} />
          </div>
          <div>
            <label htmlFor="from">In this role since</label>
            <input id="from" type="date" name="from" />
          </div>
          <div>
            <label htmlFor="channel">Preferred channel</label>
            <input id="channel" type="text" name="channel" placeholder="Email, WhatsApp, phone" maxLength={80} />
          </div>
          <div>
            <label htmlFor="timeZone">Time zone</label>
            <input id="timeZone" type="text" name="timeZone" placeholder="America/Mexico_City" maxLength={64} />
          </div>
          <div>
            <label htmlFor="language">Language</label>
            <input id="language" type="text" name="language" maxLength={40} />
          </div>
          <div>
            <label htmlFor="boss">Their boss</label>
            <input id="boss" type="text" name="boss" maxLength={200} />
          </div>
        </div>
        <label className="row small" style={{ color: "var(--ink)" }}>
          <input type="checkbox" name="overHead" /> Going over their head is sometimes acceptable
        </label>
        <label htmlFor="texture">Your notes (only you can see these; one per line)</label>
        <textarea id="texture" name="texture" placeholder="Dry humor; hates being rushed" />
        <label htmlFor="scope">Visibility</label>
        <select id="scope" name="scope" className="field" defaultValue="private">
          <option value="private">Private to me</option>
          <option value="workspace">Shared with the workspace (your notes stay private)</option>
        </select>
        <div className="actions">
          <button className="btn primary">Add person</button>
        </div>
      </form>
    </main>
  );
}
