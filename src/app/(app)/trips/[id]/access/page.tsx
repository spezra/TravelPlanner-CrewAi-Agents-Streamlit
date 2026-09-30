import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getTrip } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { MAX_PORTAL_DAYS, PORTAL_FLASH_COOKIE } from "@/modules/trips/portal";
import { listDelegations, listMembers, listPortalLinks } from "@/modules/trips/repo";
import { createPortalLinkAction, grantDelegationAction, revokeDelegationAction, revokePortalLinkAction } from "../../actions";
import { fmtWhen, Notices } from "../../ui";

export const metadata = { title: "Trip access" };
export const dynamic = "force-dynamic";

export default async function TripAccess({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const now = new Date();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const trip = await getTrip(q, id);
    if (!trip) return null;
    const [delegations, members, links] = await Promise.all([listDelegations(q, id), listMembers(q), listPortalLinks(q, id)]);
    return { trip, delegations, members, links };
  });
  if (!data) notFound();
  const { trip, delegations, members, links } = data;
  const tz = members.find((m) => m.id === me.member.id)?.timeZone ?? "UTC";
  const isOwner = trip.ownerId === me.member.id;
  const flash = isOwner ? (await cookies()).get(PORTAL_FLASH_COOKIE)?.value : undefined;
  const candidates = members.filter((m) => m.active && m.id !== trip.ownerId);
  const defaultUntil = trip.endsOn ?? new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

  return (
    <main>
      <p className="small">
        <Link href={`/trips/${trip.id}`}>← {trip.title}</Link>
      </p>
      <h1>Access</h1>
      <p className="lede">
        Who else can work on this trip, and the client&apos;s link to their itinerary. {isOwner ? "" : `Only ${trip.ownerName}, the trip owner, can change these.`}
      </p>
      <Notices error={error} ok={ok} />

      <h2>Delegations</h2>
      <p className="small muted">
        A named backup or assistant gets pre-authorized, scoped access to this trip only, until it expires. They can prepare and execute
        within approvals; money decisions stay with you.
      </p>
      <div className="card table-wrap">
        {delegations.length === 0 ? (
          <p className="empty">Nobody else has delegated access.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>As</th>
                <th>Until</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {delegations.map((d) => {
                const expired = d.expiresAt !== null && new Date(d.expiresAt) <= now;
                return (
                  <tr key={d.memberId}>
                    <td>{d.memberName}</td>
                    <td>
                      <span className="chip">{d.purpose}</span>
                    </td>
                    <td className="small">
                      {d.expiresAt ? fmtWhen(d.expiresAt, tz) : "no expiry"} {expired && <span className="chip alert">expired</span>}
                    </td>
                    <td>
                      {isOwner && d.purpose !== "collaboration" && (
                        <form action={revokeDelegationAction}>
                          <input type="hidden" name="tripId" value={trip.id} />
                          <input type="hidden" name="memberId" value={d.memberId} />
                          <button className="btn small">Revoke</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {isOwner && (
        <form action={grantDelegationAction} className="card">
          <input type="hidden" name="tripId" value={trip.id} />
          <h3>Grant access</h3>
          <div className="grid2">
            <div>
              <label htmlFor="memberId">Person</label>
              <select id="memberId" name="memberId" className="field" required>
                {candidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="purpose">As</label>
              <select id="purpose" name="purpose" className="field" defaultValue="backup">
                <option value="backup">Named backup</option>
                <option value="assistant">Assistant</option>
              </select>
            </div>
            <div>
              <label htmlFor="expiresOn">Until (end of day, {tz})</label>
              <input id="expiresOn" name="expiresOn" type="date" required defaultValue={defaultUntil} />
            </div>
          </div>
          <div className="actions">
            <button className="btn primary" type="submit" disabled={candidates.length === 0}>
              Grant
            </button>
          </div>
        </form>
      )}

      <h2>Client link</h2>
      <p className="small muted">
        A private link to one itinerary in traveler language: confirmed bookings, perks as they can honestly be promised, and open proposals
        with price, expiry and cancellation terms. The client can accept a proposal there; your approval is still what spends money. No
        internal notes, credentials, commission or supplier contacts are ever shown.
      </p>
      {flash && (
        <div className="notice">
          <b>New link (shown once; copy it now):</b>
          <div>
            <input type="text" readOnly value={flash} aria-label="Client link" />
          </div>
        </div>
      )}
      <div className="card table-wrap">
        {links.length === 0 ? (
          <p className="empty">No client links yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Link</th>
                <th>Expires</th>
                <th>Last opened</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.map((l) => {
                const live = !l.revokedAt && new Date(l.expiresAt) > now;
                return (
                  <tr key={l.id}>
                    <td>
                      {l.label ?? "Client link"} <span className={`chip ${live ? "ok" : ""}`}>{l.revokedAt ? "revoked" : live ? "active" : "expired"}</span>
                    </td>
                    <td className="small">{fmtWhen(l.expiresAt, tz)}</td>
                    <td className="small">{l.lastUsedAt ? fmtWhen(l.lastUsedAt, tz) : "never"}</td>
                    <td>
                      {isOwner && live && (
                        <form action={revokePortalLinkAction}>
                          <input type="hidden" name="tripId" value={trip.id} />
                          <input type="hidden" name="linkId" value={l.id} />
                          <button className="btn small">Revoke</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {isOwner &&
        (trip.clientId ? (
          <form action={createPortalLinkAction} className="card">
            <input type="hidden" name="tripId" value={trip.id} />
            <h3>Create a client link</h3>
            <div className="grid2">
              <div>
                <label htmlFor="label">Label (for you)</label>
                <input id="label" name="label" type="text" placeholder={`e.g. ${trip.clientName ?? "Client"}`} maxLength={100} />
              </div>
              <div>
                <label htmlFor="days">Valid for (days)</label>
                <input id="days" name="days" type="number" min={1} max={MAX_PORTAL_DAYS} defaultValue={30} required />
              </div>
            </div>
            <div className="actions">
              <button className="btn primary" type="submit">
                Create link
              </button>
            </div>
          </form>
        ) : (
          <p className="notice">Add the client to the trip before sharing it.</p>
        ))}
    </main>
  );
}
