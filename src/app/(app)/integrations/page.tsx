import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { config } from "@/server/config";
import { getIntegration, googleClientFromConfig } from "@/modules/crm/google";
import { ensureInboundRoute, inboundAddress, inboundDomain, listSuggestions } from "@/modules/crm/inbound";
import { candidatesAction, disconnectGoogleAction, rotateInboundAction } from "./actions";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function Integrations({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const db = await getDb();
  const cfg = config();
  const route = await ensureInboundRoute(db, me.tenant);
  const address = inboundAddress(route.token, inboundDomain(cfg.APP_URL));
  const { google, candidates } = await withTenant(db, me.tenant, async (q) => ({
    google: await getIntegration(q),
    candidates: (await listSuggestions(q, { source: "google_import", status: "pending", limit: 500 })).filter((s) => s.ownerId === me.member.id),
  }));
  const googleReady = googleClientFromConfig() !== null;
  const isAdmin = me.member.role === "owner" || me.member.role === "admin";

  return (
    <main>
      <h1>Integrations</h1>
      <p className="lede">Connect email and calendar and the platform builds your relationship records from history, with nothing to type. You confirm what it finds.</p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <h2>Forwarding address</h2>
      <div className="card">
        <p className="small" style={{ marginTop: 0 }}>
          Forward supplier confirmations, commitments and client mail here (or set it as a BCC). The agent reads each message and suggests what to do with it in
          the Inbox.
        </p>
        <p>
          <code>{address}</code>
        </p>
        {!cfg.INBOUND_EMAIL_SECRET && <p className="notice error small">Inbound email isn&apos;t enabled on this installation yet (INBOUND_EMAIL_SECRET is not set).</p>}
        {isAdmin && (
          <>
            <p className="small muted">
              Mail provider setup (Postmark inbound or compatible): POST JSON to <code>{cfg.APP_URL}/api/webhooks/inbound-email</code> with HTTP Basic auth, the
              inbound secret as the password.
            </p>
            <form action={rotateInboundAction}>
              <button className="btn small">Replace this address</button>
            </form>
          </>
        )}
      </div>

      <h2>Google (Gmail and Calendar)</h2>
      <div className="card">
        {!googleReady && <p className="notice error small">Google isn&apos;t configured on this installation (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>}
        {google ? (
          <>
            <div className="row">
              <span className="grow">
                <b>{google.googleEmail}</b>{" "}
                <span className={`chip ${google.status === "connected" ? "ok" : "alert"}`}>{google.status}</span>{" "}
                <span className="chip">
                  {google.importStatus === "complete" ? `imported ${google.importCompletedAt?.slice(0, 10) ?? ""}` : `import ${google.importStatus}`}
                </span>
              </span>
              <form action={disconnectGoogleAction}>
                <button className="btn">Disconnect</button>
              </form>
            </div>
            {google.statusReason && <p className="small muted">{google.statusReason}</p>}
            <p className="small muted">
              {google.contactsSeen} addresses seen · last synced {google.lastSyncedAt?.slice(0, 16).replace("T", " ") ?? "not yet"} · syncs daily. Only who and when
              (From, To, Date, Subject) is read; message bodies stay in Google.
            </p>
            {google.status === "disconnected" && googleReady && (
              <form action="/api/integrations/google/start" method="post">
                <button className="btn primary">Reconnect</button>
              </form>
            )}
          </>
        ) : (
          googleReady && (
            <form action="/api/integrations/google/start" method="post" className="row">
              <span className="grow small">Read-only access to Gmail and Calendar for the last two years. Private to you.</span>
              <button className="btn primary">Connect Google</button>
            </form>
          )
        )}
      </div>

      <h2 id="candidates">People to confirm</h2>
      {candidates.length === 0 ? (
        <p className="empty">{google ? "Nothing waiting. New people appear here after each sync." : "Connect Google to find the people you already work with."}</p>
      ) : (
        <form action={candidatesAction} className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>Person</th>
                <th>Organization</th>
                <th>History</th>
                <th>Last touch</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((s) => {
                const p = s.payload;
                return (
                  <tr key={s.id}>
                    <td>
                      <input type="checkbox" name="ids" value={s.id} defaultChecked aria-label={`Select ${String(p.name)}`} />
                    </td>
                    <td>
                      {String(p.name)}
                      <div className="small muted">{String(p.email)}</div>
                      {p.mergeIntoName ? <div className="small muted">Shares a name with {String(p.mergeIntoName)}; adding creates a separate record</div> : null}
                    </td>
                    <td>{p.organization ? String(p.organization) : "—"}</td>
                    <td className="small">
                      {Number(p.sentCount)} sent · {Number(p.receivedCount)} received · {Number(p.meetingCount)} meetings
                    </td>
                    <td className="small">{String(p.lastTouch).slice(0, 10)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="actions">
            <button className="btn primary" name="op" value="accept">
              Add selected as private relationships
            </button>
            <button className="btn" name="op" value="dismiss">
              Not relationships
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
