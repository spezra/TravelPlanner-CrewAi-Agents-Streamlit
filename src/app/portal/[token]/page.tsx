import { clientIp } from "@/lib/clientIp";
import { headers } from "next/headers";
import type { PortalItem } from "@/domain/portal";
import { formatAmount } from "@/domain/tripPlanning";
import { getDb } from "@/lib/server";
import { loadPortal, portalRateLimit } from "@/modules/trips/portal";
import { acceptProposalAction } from "./actions";

export const metadata = { title: "Your trip" };

const ERRORS: Record<string, string> = {
  bad_input: "Please type your full name and tick the box to accept.",
  rate_limited: "Too many attempts. Please try again later.",
  link_invalid: "This link is no longer valid. Please ask your advisor for a new one.",
  not_found: "That proposal isn't part of this trip.",
  not_open: "That proposal is no longer open.",
  offer_expired: "That price has expired. Your advisor will send an updated one.",
  already_accepted: "You've already accepted this proposal.",
};
export const dynamic = "force-dynamic";

const when = (iso: string | null, withTime = true) =>
  iso
    ? `${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "full", ...(withTime ? { timeStyle: "short" } : {}) }).format(new Date(iso))}${withTime ? " UTC" : ""}`
    : null;

function ItemCard({ it }: { it: PortalItem }) {
  return (
    <section className="card">
      <div className="row">
        <h3 className="grow">{it.title}</h3>
        <span className={`chip ${it.tone}`}>{it.status}</span>
      </div>
      <div className="small muted">
        {when(it.startsAt, false) ?? "Date to be confirmed"}
        {it.endsAt && it.endsAt.slice(0, 10) !== it.startsAt?.slice(0, 10) ? ` → ${when(it.endsAt, false)}` : ""}
        {it.confirmationRef ? ` · Confirmation ${it.confirmationRef}` : ""}
      </div>
      {it.perks.length > 0 && (
        <>
          <div className="small" style={{ marginTop: 8 }}>
            {it.perksAreProposed ? "Included with this proposal, once booked:" : "Included:"}
          </div>
          <ul className="small">
            {it.perks.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default async function Portal({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string; accepted?: string }> }) {
  const { token } = await params;
  const { error: errorCode, accepted } = await searchParams;
  const error = errorCode ? (ERRORS[errorCode] ?? "Something went wrong. Please contact your advisor.") : undefined;
  const db = await getDb();
  const now = new Date();
  const h = await headers();
  const ip = clientIp(h);
  const allowed = await portalRateLimit(db, ip, now);
  const portal = allowed ? await loadPortal(db, token, now) : null;

  if (!portal) {
    return (
      <main>
        <header className="top">
          <span className="brand">Your trip</span>
        </header>
        <p className="notice">
          {allowed ? "This link is no longer valid. Please ask your travel advisor for a new one." : "Too many requests. Please try again in a minute."}
        </p>
      </main>
    );
  }
  const v = portal.view;
  const confirmed = v.items.filter((i) => i.status === "Confirmed");
  const other = v.items.filter((i) => i.status !== "Confirmed");

  return (
    <main>
      <header className="top">
        <span className="brand">{v.agencyName}</span>
        <span className="who">
          Your advisor: {v.advisor.name}
          {v.advisor.email && (
            <>
              {" · "}
              <a href={`mailto:${v.advisor.email}`}>{v.advisor.email}</a>
            </>
          )}
        </span>
      </header>
      <h1>{v.tripTitle}</h1>
      <p className="lede">
        {v.startsOn ? `${when(v.startsOn, false)}${v.endsOn ? ` to ${when(v.endsOn, false)}` : ""}` : "Dates to be confirmed"}
      </p>

      {(accepted || error) && (
        <div className={`notice ${error ? "error" : ""}`}>
          <div className="small muted">Message from {v.agencyName}&apos;s booking system</div>
          {error ?? `Thank you. We've recorded your acceptance for ${v.advisor.name}. Nothing is booked or charged until ${v.advisor.name} confirms.`}
        </div>
      )}

      {v.document && (
        <article className="proposal-doc">
          <h2>{v.document.title}</h2>
          {v.document.intro && <p className="doc-intro">{v.document.intro}</p>}
          {v.document.sections.map((s, i) => (
            <section key={i}>
              <h3>{s.heading}</h3>
              {s.body.split(/\n{2,}/).map((para, j) => (
                <p key={j}>{para}</p>
              ))}
            </section>
          ))}
          {v.document.closing && <p className="doc-closing">{v.document.closing}</p>}
        </article>
      )}

      {v.proposals.length > 0 && (
        <>
          <h2>Waiting for your go-ahead</h2>
          {v.proposals.map((p) => (
            <section key={p.approvalId} className="card">
              <div className="row">
                <h3 className="grow">{p.summary.join("; ")}</h3>
                <b>{formatAmount(p.price)}</b>
              </div>
              <ul className="plain small">
                <li>{p.expired ? <span className="chip alert">This price has expired</span> : <>Price held until {when(p.offerExpiresAt)}</>}</li>
                <li>Cancellation: {p.cancellationPolicy}</li>
                {p.alsoChanges.map((c) => (
                  <li key={c}>What else changes: {c}</li>
                ))}
              </ul>
              {p.clientAcceptance ? (
                <p className="notice small">
                  Accepted by {p.clientAcceptance.acceptedName} on {when(p.clientAcceptance.acceptedAt)}.
                  {p.clientAcceptance.termsCurrent ? ` ${v.advisor.name} will confirm before anything is booked.` : " The terms have changed since; your advisor will be in touch."}
                </p>
              ) : p.expired ? (
                <p className="small muted">{v.advisor.name} will send you an updated price.</p>
              ) : (
                <form action={acceptProposalAction}>
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="approvalId" value={p.approvalId} />
                  <label htmlFor={`name_${p.approvalId}`}>Your full name</label>
                  <input id={`name_${p.approvalId}`} name="acceptedName" type="text" required minLength={2} maxLength={120} autoComplete="name" />
                  <label className="small" style={{ color: "inherit" }}>
                    <input type="checkbox" name="confirm" value="yes" required /> I accept this proposal at this price and these cancellation terms. I understand{" "}
                    {v.advisor.name} confirms before anything is booked or charged.
                  </label>
                  <div className="actions">
                    <button className="btn primary" type="submit">
                      Accept proposal
                    </button>
                  </div>
                </form>
              )}
            </section>
          ))}
        </>
      )}

      <h2>Confirmed</h2>
      {confirmed.length === 0 ? <p className="empty">Nothing confirmed yet.</p> : confirmed.map((it) => <ItemCard key={it.id} it={it} />)}

      {other.length > 0 && (
        <>
          <h2>In progress</h2>
          {other.map((it) => (
            <ItemCard key={it.id} it={it} />
          ))}
        </>
      )}

      <p className="small muted" style={{ marginTop: 32 }}>
        This page is maintained automatically by {v.agencyName}&apos;s booking system. For anything about your trip, contact {v.advisor.name}
        {v.advisor.email ? ` at ${v.advisor.email}` : ""}. Times are shown in UTC.
      </p>
    </main>
  );
}
