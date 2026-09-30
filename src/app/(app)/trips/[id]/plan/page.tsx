import Link from "next/link";
import { notFound } from "next/navigation";
import { currentResponder, type CoverageWindow, type Responder } from "@/domain/responsePlan";
import { BACKUP_GRACE_DAYS } from "@/domain/responsePlanRules";
import { getDb, requireMember } from "@/lib/server";
import { planEditor } from "@/modules/ops/responsePlans";
import { acknowledgeAction, raiseUnhappyAction, resolveAction, savePlanAction } from "./actions";

export const metadata = { title: "Response plan" };
export const dynamic = "force-dynamic";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KIND: Record<string, string> = {
  reconcile: "Outcome unknown",
  disruption: "Disruption",
  commitment_overdue: "Overdue commitment",
  unhappy_client: "Unhappy client",
};

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

function WindowFields({ prefix, n, w, disabled }: { prefix: "p" | "b"; n: 1 | 2; w: CoverageWindow | undefined; disabled: boolean }) {
  return (
    <fieldset disabled={disabled} style={{ border: "1px solid var(--line)", borderRadius: 8, marginTop: 8 }}>
      <legend className="small muted">{n === 1 ? "Coverage" : "Second window (optional)"}</legend>
      <div className="row small">
        {DAYS.map((d, i) => (
          <label key={d} style={{ margin: 0 }}>
            <input type="checkbox" name={`${prefix}_days${n}`} value={i} defaultChecked={w?.days.includes(i) ?? false} /> {d}
          </label>
        ))}
      </div>
      <div className="row small">
        <label style={{ margin: 0 }}>
          From <input type="number" name={`${prefix}_start${n}`} min={0} max={23} defaultValue={w?.startHour ?? 8} style={{ width: 70 }} />
        </label>
        <label style={{ margin: 0 }}>
          to <input type="number" name={`${prefix}_end${n}`} min={1} max={24} defaultValue={w?.endHour ?? 20} style={{ width: 70 }} /> (local hour)
        </label>
      </div>
    </fieldset>
  );
}

function ResponderFields({
  prefix,
  label,
  r,
  members,
  optional,
  disabled,
}: {
  prefix: "p" | "b";
  label: string;
  r: Responder | null;
  members: { id: string; name: string; timeZone: string }[];
  optional: boolean;
  disabled: boolean;
}) {
  const idName = prefix === "p" ? "primaryId" : "backupId";
  const tzName = prefix === "p" ? "primaryTz" : "backupTz";
  return (
    <section className="card">
      <h3>{label}</h3>
      <label htmlFor={idName}>Who</label>
      <select id={idName} name={idName} className="field" defaultValue={r?.memberId ?? ""} disabled={disabled}>
        {optional && <option value="">No backup</option>}
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <label htmlFor={tzName}>Time zone</label>
      <input id={tzName} name={tzName} type="text" list="tz" defaultValue={r?.timeZone ?? members[0]?.timeZone ?? "UTC"} disabled={disabled} />
      <WindowFields prefix={prefix} n={1} w={r?.coverage[0]} disabled={disabled} />
      <WindowFields prefix={prefix} n={2} w={r?.coverage[1]} disabled={disabled} />
    </section>
  );
}

export default async function PlanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const { tenant } = await requireMember();
  const data = await planEditor(await getDb(), tenant, id);
  if (!data) notFound();
  const { trip, plan, members, backupDelegation, canEdit, escalations } = data;
  const name = (mid: string | null) => members.find((m) => m.id === mid)?.name ?? "—";
  const now = new Date();
  const open = escalations.filter((e) => !e.resolvedAt);
  const closed = escalations.filter((e) => e.resolvedAt);
  const esc = plan?.escalation ?? [];

  return (
    <main>
      <p className="small">
        <Link href={`/trips/${id}`}>← {trip.title}</Link>
      </p>
      <h1>Response plan</h1>
      <p className="lede">
        A named human for every trip. The backup holds scoped access to this trip (until {BACKUP_GRACE_DAYS} days after it ends), so nothing waits on someone
        asleep. An unhappy client is answered by a person, never the system alone.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {plan && (
        <p className="small">
          Right now: <b>{name(currentResponder(plan, now).memberId)}</b>
          {backupDelegation && (
            <span className="muted">
              {" "}
              · {name(backupDelegation.memberId)}&apos;s backup access {backupDelegation.expiresAt ? `expires ${backupDelegation.expiresAt.slice(0, 10)}` : "has no expiry"}
            </span>
          )}
        </p>
      )}

      <h2>Needs a response</h2>
      {open.length === 0 && <p className="empty">Nothing open.</p>}
      {open.map((e) => (
        <section key={e.id} className="card">
          <div className="row">
            <span className={`chip ${e.kind === "unhappy_client" ? "alert" : "warn"}`}>{KIND[e.kind]}</span>
            <h3 className="grow">{e.title}</h3>
            <span className="small muted">raised {e.raisedAt.slice(0, 16).replace("T", " ")} UTC</span>
          </div>
          <div className="small">{e.detail}</div>
          <div className="small muted">
            {e.acknowledgedAt ? `Acknowledged by ${name(e.acknowledgedBy)}` : e.tried.length ? `Contacted: ${e.tried.map(name).join(" → ")}` : "Not yet contacted"}
          </div>
          <div className="actions">
            {!e.acknowledgedAt && (
              <form action={acknowledgeAction}>
                <input type="hidden" name="tripId" value={id} />
                <input type="hidden" name="escalationId" value={e.id} />
                <button className="btn primary">I&apos;ve got it</button>
              </form>
            )}
            <details>
              <summary className="btn small">Close</summary>
              <form action={resolveAction}>
                <input type="hidden" name="tripId" value={id} />
                <input type="hidden" name="escalationId" value={e.id} />
                <label htmlFor={`n-${e.id}`}>{e.kind === "unhappy_client" ? "How was the client answered? (advisor or named backup only)" : "Note"}</label>
                <input id={`n-${e.id}`} name="note" type="text" required={e.kind === "unhappy_client"} maxLength={2000} />
                <div className="actions">
                  <button className="btn small">Close</button>
                </div>
              </form>
            </details>
          </div>
        </section>
      ))}
      <details className="card">
        <summary>Report an unhappy client</summary>
        <form action={raiseUnhappyAction}>
          <input type="hidden" name="tripId" value={id} />
          <label htmlFor="summary">What happened (goes to the responders on this plan)</label>
          <textarea id="summary" name="summary" required minLength={3} maxLength={2000} style={{ minHeight: 70 }} />
          <div className="actions">
            <button className="btn primary">Raise</button>
          </div>
        </form>
      </details>

      <h2>Plan</h2>
      {!canEdit && <p className="notice small">Only {name(trip.ownerId)} or a workspace owner/admin can change this plan.</p>}
      <form action={savePlanAction}>
        <input type="hidden" name="tripId" value={id} />
        <datalist id="tz">
          {timeZones().map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <div className="grid2">
          <ResponderFields prefix="p" label="Primary" r={plan?.primary ?? { memberId: trip.ownerId, timeZone: members.find((m) => m.id === trip.ownerId)?.timeZone ?? "UTC", coverage: [] }} members={members} optional={false} disabled={!canEdit} />
          <ResponderFields prefix="b" label="Backup" r={plan?.backup ?? null} members={members} optional disabled={!canEdit} />
        </div>
        <section className="card">
          <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
            <label htmlFor="ack">Acknowledge within (minutes) before escalating to the next person</label>
            <input id="ack" name="ackDeadlineMinutes" type="number" min={5} max={1440} defaultValue={plan?.ackDeadlineMinutes ?? 30} />
            <label>Then escalate to, in order</label>
            <div className="row">
              {[0, 1, 2].map((i) => (
                <select key={i} name={`esc${i + 1}`} defaultValue={esc[i] ?? ""} aria-label={`Escalation ${i + 1}`}>
                  <option value="">—</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ))}
            </div>
            <label htmlFor="policy">Client-contact policy</label>
            <textarea
              id="policy"
              name="clientContactPolicy"
              required
              minLength={3}
              maxLength={2000}
              style={{ minHeight: 70 }}
              defaultValue={plan?.clientContactPolicy ?? "The advisor, or the named backup. Never the system alone for anything the client is unhappy about."}
            />
            <div className="actions">
              <button className="btn primary">Save plan</button>
            </div>
          </fieldset>
        </section>
      </form>

      {closed.length > 0 && (
        <details className="card small">
          <summary>Closed ({closed.length})</summary>
          <ul className="plain">
            {closed.map((e) => (
              <li key={e.id}>
                {KIND[e.kind]}: {e.title} · closed by {e.resolvedBy === "system" ? "the system (cause cleared)" : name(e.resolvedBy)} {e.resolvedAt?.slice(0, 10)}
                {e.resolutionNote && <span className="muted"> · {e.resolutionNote}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
