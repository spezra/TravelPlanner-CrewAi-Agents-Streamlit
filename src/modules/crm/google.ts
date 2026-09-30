/**
 * Connect Gmail and Calendar (read-only) and build relationship records from
 * existing history with no manual entry: who you write to, who writes back,
 * who you meet, and when you last did. Only message metadata is read (From,
 * To, Cc, Date, Subject); bodies never leave Google. Results arrive as
 * suggestions the member confirms.
 *
 * Everything here is private to the member who connected the account.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { audit } from "@/db/repo";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import {
  isAutomatedAddress,
  isRelationshipCandidate,
  matchPerson,
  nameFromAddress,
  normalizeAddress,
  organizationFromDomain,
  parseAddress,
  parseAddressList,
  type ContactAggregate,
  type SuggestionDraft,
} from "@/domain/crmIngest";
import {
  CALENDAR_SCOPE,
  codeChallenge,
  GMAIL_SCOPE,
  GoogleApiError,
  GoogleClient,
  GoogleGrantError,
  idTokenEmail,
  newCodeVerifier,
  type CalendarEvent,
  type FetchLike,
  type GmailMessageMeta,
} from "@/providers/google";
import { config } from "@/server/config";
import { decryptFor, encryptFor, newToken, sha256 } from "@/server/crypto";
import { enqueue, enqueueAsTenant, PermanentJobError } from "@/server/jobs/queue";
import { log } from "@/server/log";
import { SYSTEM_FOOTER, type Mailer } from "@/server/mail";
import { insertSuggestions } from "./inbound";

const HISTORY_DAYS = 730;
const STATE_MINUTES = 10;
const DAY = 86_400_000;

export function googleClientFromConfig(fetch?: FetchLike): GoogleClient | null {
  const c = config();
  if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET) return null;
  return new GoogleClient({ clientId: c.GOOGLE_CLIENT_ID, clientSecret: c.GOOGLE_CLIENT_SECRET, redirectUri: `${c.APP_URL}/api/integrations/google/callback`, fetch });
}

// ---------------------------------------------------------------------------
// OAuth

/** Starts the authorization-code flow: a single-use state bound to this member, and a PKCE verifier kept encrypted server-side. */
export async function beginGoogleAuth(db: Db, tenant: Tenant, client: GoogleClient, now: Date): Promise<string> {
  const state = newToken();
  const verifier = newCodeVerifier();
  const hash = sha256(state);
  const email = await withTenant(db, tenant, async (q) => {
    // Old, unused states for this member are dead weight.
    await q.query("delete from google_oauth_states where expires_at < $1 or used_at is not null", [now.toISOString()]);
    await q.query("insert into google_oauth_states (state_hash, workspace_id, member_id, verifier_sealed, expires_at) values ($1, $2, $3, $4, $5)", [
      hash,
      tenant.workspaceId,
      tenant.memberId,
      await encryptFor(q, tenant.workspaceId, `oauth_state:${hash}`, verifier),
      new Date(now.getTime() + STATE_MINUTES * 60_000).toISOString(),
    ]);
    const { rows } = await q.query<{ email: string }>("select email from members where id = $1", [tenant.memberId]);
    return rows[0]?.email;
  });
  return client.authUrl({ state, codeChallenge: codeChallenge(verifier), loginHint: email });
}

export interface IntegrationView {
  id: string;
  googleEmail: string;
  scopes: string[];
  status: "connected" | "disconnected";
  statusReason: string | null;
  importStatus: "pending" | "running" | "complete" | "failed";
  importCompletedAt: string | null;
  lastSyncedAt: string | null;
  contactsSeen: number;
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export async function getIntegration(q: Queryable): Promise<IntegrationView | null> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select g.*, (select count(*)::int from google_contacts c where c.integration_id = g.id) as contacts_seen
       from google_integrations g where g.member_id = app_member()`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    googleEmail: String(r.google_email),
    scopes: (r.scopes as string[]) ?? [],
    status: r.status as IntegrationView["status"],
    statusReason: (r.status_reason as string | null) ?? null,
    importStatus: r.import_status as IntegrationView["importStatus"],
    importCompletedAt: iso(r.import_completed_at),
    lastSyncedAt: iso(r.last_synced_at),
    contactsSeen: Number(r.contacts_seen ?? 0),
  };
}

/**
 * The callback. Validates the state (exists for this member, unused,
 * unexpired), burns it before anything else, exchanges the code with the PKCE
 * verifier, and stores the tokens encrypted.
 */
export async function completeGoogleAuth(
  db: Db,
  tenant: Tenant,
  client: GoogleClient,
  params: { code?: string | null; state?: string | null; error?: string | null },
  now: Date,
): Promise<{ integrationId: string }> {
  if (!params.state) throw new DomainError("invalid_state", "The Google sign-in link is invalid. Start again.");
  const hash = sha256(params.state);
  const verifier = await withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<{ verifier_sealed: string; expires_at: unknown; used_at: unknown; member_id: string }>(
      "select verifier_sealed, expires_at, used_at, member_id from google_oauth_states where state_hash = $1 for update",
      [hash],
    );
    const r = rows[0];
    // RLS already limits rows to this member; the check is explicit anyway.
    if (!r || r.member_id !== tenant.memberId) throw new DomainError("invalid_state", "The Google sign-in link is invalid. Start again.");
    if (r.used_at) throw new DomainError("invalid_state", "That Google sign-in link was already used. Start again.");
    if (new Date(iso(r.expires_at)!).getTime() < now.getTime()) throw new DomainError("invalid_state", "The Google sign-in link expired. Start again.");
    await q.query("update google_oauth_states set used_at = $2 where state_hash = $1", [hash, now.toISOString()]);
    return decryptFor(q, tenant.workspaceId, `oauth_state:${hash}`, r.verifier_sealed);
  });
  if (params.error) throw new DomainError("google_denied", params.error === "access_denied" ? "Google access was not granted." : `Google returned: ${params.error}`);
  if (!params.code) throw new DomainError("invalid_state", "Google returned no authorization code.");

  let tokens;
  try {
    tokens = await client.exchangeCode(params.code, verifier);
  } catch (err) {
    if (err instanceof GoogleGrantError) throw new DomainError("google_exchange", "Google rejected the sign-in. Start again.");
    throw err;
  }
  const hasGmail = tokens.scopes.includes(GMAIL_SCOPE);
  const hasCalendar = tokens.scopes.includes(CALENDAR_SCOPE);
  if (!hasGmail && !hasCalendar) throw new DomainError("google_scopes", "Allow access to Gmail or Calendar (read-only) to build your relationship records.");
  let email = tokens.idToken ? idTokenEmail(tokens.idToken)?.email : undefined;
  if (!email && hasGmail) email = (await client.gmailProfile(tokens.accessToken)).emailAddress.toLowerCase();
  if (!email) throw new DomainError("google_email", "Google didn't share the account's email address.");

  return withTenant(db, tenant, async (q) => {
    const existing = await q.query<{ id: string; google_email: string; refresh_token_sealed: string | null; import_status: string }>(
      "select id, google_email, refresh_token_sealed, import_status from google_integrations where member_id = $1",
      [tenant.memberId],
    );
    let prev = existing.rows[0];
    if (prev && prev.google_email !== email) {
      // A different Google account: its history is a different mailbox. Start clean.
      await q.query("delete from google_integrations where id = $1", [prev.id]);
      prev = undefined;
    }
    const id = prev?.id ?? randomUUID();
    let refreshSealed: string | null;
    if (tokens.refreshToken) refreshSealed = await encryptFor(q, tenant.workspaceId, `google:${id}:refresh`, tokens.refreshToken);
    else if (prev?.refresh_token_sealed) refreshSealed = prev.refresh_token_sealed;
    else throw new DomainError("google_refresh", "Google didn't grant offline access. Remove the app at myaccount.google.com/permissions and connect again.");
    const accessSealed = await encryptFor(q, tenant.workspaceId, `google:${id}:access`, tokens.accessToken);
    const expires = new Date(now.getTime() + tokens.expiresIn * 1000).toISOString();
    if (prev) {
      await q.query(
        `update google_integrations set scopes = $2, access_token_sealed = $3, refresh_token_sealed = $4, access_expires_at = $5,
           status = 'connected', status_reason = null, updated_at = $6,
           import_status = case when import_status = 'complete' then 'complete' else 'pending' end
         where id = $1`,
        [id, tokens.scopes, accessSealed, refreshSealed, expires, now.toISOString()],
      );
    } else {
      await q.query(
        `insert into google_integrations (id, workspace_id, member_id, google_email, scopes, access_token_sealed, refresh_token_sealed, access_expires_at, status, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'connected',$9,$9)`,
        [id, tenant.workspaceId, tenant.memberId, email, tokens.scopes, accessSealed, refreshSealed, expires, now.toISOString()],
      );
    }
    const done = prev?.import_status === "complete";
    await enqueueAsTenant(q, {
      kind: done ? "crm.google_sync_account" : "crm.google_import",
      payload: { integrationId: id },
      dedupeKey: `${done ? "crm.google_sync_account" : "crm.google_import"}:${id}:connect:${now.getTime()}`,
    });
    await audit(q, tenant.workspaceId, tenant.memberId, "integration.google_connected", id, { scopes: tokens.scopes, reconnect: Boolean(prev) });
    return { integrationId: id };
  });
}

/** The member disconnects: revoke at Google (best effort) and forget the tokens and mined contacts. Accepted records stay. */
export async function disconnectGoogle(db: Db, tenant: Tenant, client: GoogleClient | null, now: Date): Promise<void> {
  const tokens = await withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<{ id: string; refresh_token_sealed: string | null }>("select id, refresh_token_sealed from google_integrations where member_id = $1", [tenant.memberId]);
    const r = rows[0];
    if (!r) throw new DomainError("not_found", "Google isn't connected");
    const refresh = r.refresh_token_sealed ? await decryptFor(q, tenant.workspaceId, `google:${r.id}:refresh`, r.refresh_token_sealed) : null;
    await q.query("delete from google_integrations where id = $1", [r.id]);
    await q.query("update crm_suggestions set status = 'dismissed', decided_by = $1, decided_at = $2 where source = 'google_import' and status = 'pending' and owner_id = $1", [
      tenant.memberId,
      now.toISOString(),
    ]);
    await audit(q, tenant.workspaceId, tenant.memberId, "integration.google_disconnected", r.id, { by: "member" });
    return refresh;
  });
  if (tokens && client) await client.revoke(tokens);
}

// ---------------------------------------------------------------------------
// Token handling

class IntegrationGone extends Error {}

interface IntegrationRow {
  id: string;
  googleEmail: string;
  scopes: string[];
  status: string;
  importStatus: string;
  cursor: ImportCursor;
  historyId: string | null;
  calendarSyncToken: string | null;
  lastSyncedAt: string | null;
}

interface ImportCursor {
  phase?: "gmail" | "calendar" | "candidates";
  step?: number;
  historyId?: string | null;
  gmailPageToken?: string | null;
  calendarPageToken?: string | null;
  calendarSyncToken?: string | null;
}

export interface GoogleJobDeps {
  client: GoogleClient;
  mailer: Mailer;
  now: Date;
  /** API pages per job run before the import continues in a follow-up job. */
  pagesPerRun?: number;
}

/** An authorized session for one integration. Refreshes before expiry and once on a 401; a dead grant disconnects. */
class GoogleSession {
  private access: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly db: Db,
    private readonly tenant: Tenant,
    private readonly deps: GoogleJobDeps,
    readonly integration: IntegrationRow,
  ) {}

  static async open(db: Db, tenant: Tenant, integrationId: string, deps: GoogleJobDeps): Promise<GoogleSession | null> {
    const row = await withTenant(db, tenant, async (q) => {
      const { rows } = await q.query<Record<string, unknown>>("select * from google_integrations where id = $1", [integrationId]);
      return rows[0];
    });
    if (!row) return null;
    const s = new GoogleSession(db, tenant, deps, {
      id: String(row.id),
      googleEmail: String(row.google_email),
      scopes: (row.scopes as string[]) ?? [],
      status: String(row.status),
      importStatus: String(row.import_status),
      cursor: (row.import_cursor ?? {}) as ImportCursor,
      historyId: (row.gmail_history_id as string | null) ?? null,
      calendarSyncToken: (row.calendar_sync_token as string | null) ?? null,
      lastSyncedAt: iso(row.last_synced_at),
    });
    if (s.integration.status !== "connected") return null;
    return s;
  }

  private async load(): Promise<{ access: string | null; refresh: string | null; expiresAt: number }> {
    return withTenant(this.db, this.tenant, async (q) => {
      const { rows } = await q.query<{ access_token_sealed: string | null; refresh_token_sealed: string | null; access_expires_at: unknown }>(
        "select access_token_sealed, refresh_token_sealed, access_expires_at from google_integrations where id = $1",
        [this.integration.id],
      );
      const r = rows[0];
      if (!r) throw new IntegrationGone("integration removed");
      const ws = this.tenant.workspaceId;
      return {
        access: r.access_token_sealed ? await decryptFor(q, ws, `google:${this.integration.id}:access`, r.access_token_sealed) : null,
        refresh: r.refresh_token_sealed ? await decryptFor(q, ws, `google:${this.integration.id}:refresh`, r.refresh_token_sealed) : null,
        expiresAt: r.access_expires_at ? new Date(iso(r.access_expires_at)!).getTime() : 0,
      };
    });
  }

  private async refresh(refreshToken: string | null): Promise<void> {
    if (!refreshToken) return this.disconnect("No refresh token on file");
    try {
      const t = await this.deps.client.refresh(refreshToken);
      this.access = t.accessToken;
      this.expiresAt = this.deps.now.getTime() + t.expiresIn * 1000;
      await withTenant(this.db, this.tenant, async (q) => {
        const ws = this.tenant.workspaceId;
        await q.query(
          `update google_integrations set access_token_sealed = $2, access_expires_at = $3, updated_at = now()
             ${t.refreshToken ? ", refresh_token_sealed = $4" : ""} where id = $1`,
          [
            this.integration.id,
            await encryptFor(q, ws, `google:${this.integration.id}:access`, t.accessToken),
            new Date(this.expiresAt).toISOString(),
            ...(t.refreshToken ? [await encryptFor(q, ws, `google:${this.integration.id}:refresh`, t.refreshToken)] : []),
          ],
        );
      });
    } catch (err) {
      if (err instanceof GoogleGrantError) return this.disconnect("Google access was revoked or expired");
      throw err;
    }
  }

  private async token(): Promise<string> {
    if (this.access && this.expiresAt - 60_000 > this.deps.now.getTime()) return this.access;
    const stored = await this.load();
    if (stored.access && stored.expiresAt - 60_000 > this.deps.now.getTime()) {
      this.access = stored.access;
      this.expiresAt = stored.expiresAt;
      return stored.access;
    }
    await this.refresh(stored.refresh);
    return this.access!;
  }

  /** Runs a Google call; on 401, refreshes once and retries. */
  async call<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.token());
    } catch (err) {
      if (!(err instanceof GoogleGrantError) || err.code !== "unauthorized") throw err;
      await this.refresh((await this.load()).refresh);
      try {
        return await fn(this.access!);
      } catch (again) {
        if (again instanceof GoogleGrantError && again.code === "unauthorized") await this.disconnect("Google rejected the refreshed token");
        throw again;
      }
    }
  }

  async disconnect(reason: string): Promise<never> {
    await markDisconnected(this.db, this.tenant, this.integration.id, reason, this.deps.mailer, this.deps.now);
    throw new IntegrationGone(reason);
  }
}

/** Revoked or expired grant: stop syncing, drop the tokens, tell the owner (in the app and by a system email). */
export async function markDisconnected(db: Db, tenant: Tenant, integrationId: string, reason: string, mailer: Mailer, now: Date): Promise<void> {
  const to = await withTenant(db, tenant, async (q) => {
    const r = await q.query(
      `update google_integrations set status = 'disconnected', status_reason = $2, access_token_sealed = null, refresh_token_sealed = null,
         access_expires_at = null, updated_at = $3 where id = $1 and status = 'connected' returning id`,
      [integrationId, reason, now.toISOString()],
    );
    if (!r.rows[0]) return null;
    await q.query(
      `insert into crm_notices (id, workspace_id, member_id, kind, message, dedupe_key) values ($1,$2,$3,'integration_disconnected',$4,$5)
       on conflict (workspace_id, dedupe_key) do nothing`,
      [randomUUID(), tenant.workspaceId, tenant.memberId, `Google disconnected: ${reason}. Reconnect on the Integrations page to keep your relationship records current.`, `google:${integrationId}:disconnected:${now.toISOString()}`],
    );
    await audit(q, tenant.workspaceId, "system:google", "integration.google_disconnected", integrationId, { reason });
    const { rows } = await q.query<{ email: string }>("select email from members where id = $1", [tenant.memberId]);
    return rows[0]?.email ?? null;
  });
  if (!to) return;
  await mailer
    .send({
      to,
      subject: "Google connection needs attention",
      text: `Your Google (Gmail and Calendar) connection stopped working: ${reason}.\n\nReconnect at ${config().APP_URL}/integrations to keep relationship records current. Nothing already recorded was lost.${SYSTEM_FOOTER}`,
    })
    .catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, "disconnect email failed"));
}

// ---------------------------------------------------------------------------
// Turning metadata into interactions

interface Touch {
  email: string;
  name: string | null;
  kind: "sent" | "received" | "meeting";
  at: string;
}

const MAX_RECIPIENTS = 15;
const MAX_ATTENDEES = 20;

export function touchesFromMessage(m: GmailMessageMeta, selfEmail: string): Touch[] {
  const self = normalizeAddress(selfEmail);
  const from = parseAddress(m.headers.from ?? "");
  const dateMs = m.internalDate ? Number(m.internalDate) : Date.parse(m.headers.date ?? "");
  if (!from || !Number.isFinite(dateMs)) return [];
  const at = new Date(dateMs).toISOString();
  const outgoing = from.email === self || m.labelIds.includes("SENT");
  if (outgoing) {
    const to = [...parseAddressList(m.headers.to), ...parseAddressList(m.headers.cc)].filter((a) => a.email !== self && !isAutomatedAddress(a.email));
    if (to.length > MAX_RECIPIENTS) return []; // a mailing, not a conversation
    return to.map((a) => ({ email: a.email, name: a.name, kind: "sent" as const, at }));
  }
  if (isAutomatedAddress(from.email) || m.labelIds.includes("CATEGORY_PROMOTIONS") || m.labelIds.includes("SPAM")) return [];
  return [{ email: from.email, name: from.name, kind: "received", at }];
}

export function touchesFromEvent(e: CalendarEvent, selfEmail: string, now: Date): Touch[] | "future" {
  if (e.status === "cancelled" || !e.start) return [];
  if (new Date(e.start).getTime() > now.getTime()) return "future";
  const self = normalizeAddress(selfEmail);
  const others = e.attendees.filter((a) => !a.self && !a.resource && a.email !== self && !isAutomatedAddress(a.email));
  if (others.length === 0 || e.attendees.length > MAX_ATTENDEES) return [];
  return others.map((a) => ({ email: a.email, name: a.displayName, kind: "meeting" as const, at: new Date(e.start!).toISOString() }));
}

/** Counts each message/event once, ever: the seen table makes a retried page a no-op. */
async function recordTouches(q: Queryable, tenant: Tenant, integrationId: string, source: "gmail" | "calendar", items: { externalId: string; touches: Touch[] }[]): Promise<number> {
  let fresh = 0;
  for (const it of items) {
    const ins = await q.query(
      `insert into google_seen (integration_id, workspace_id, member_id, source, external_id) values ($1,$2,$3,$4,$5)
       on conflict do nothing returning external_id`,
      [integrationId, tenant.workspaceId, tenant.memberId, source, it.externalId],
    );
    if (!ins.rows[0]) continue;
    fresh++;
    for (const t of it.touches) {
      await q.query(
        `insert into google_contacts (integration_id, workspace_id, member_id, email, name, organization, first_touch, last_touch, sent_count, received_count, meeting_count)
         values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)
         on conflict (integration_id, email) do update set
           name = coalesce(google_contacts.name, excluded.name),
           first_touch = least(google_contacts.first_touch, excluded.first_touch),
           last_touch = greatest(google_contacts.last_touch, excluded.last_touch),
           sent_count = google_contacts.sent_count + excluded.sent_count,
           received_count = google_contacts.received_count + excluded.received_count,
           meeting_count = google_contacts.meeting_count + excluded.meeting_count`,
        [
          integrationId, tenant.workspaceId, tenant.memberId, t.email, t.name?.slice(0, 200) ?? null, organizationFromDomain(t.email), t.at,
          t.kind === "sent" ? 1 : 0, t.kind === "received" ? 1 : 0, t.kind === "meeting" ? 1 : 0,
        ],
      );
    }
  }
  return fresh;
}

async function unseen(q: Queryable, integrationId: string, source: "gmail" | "calendar", ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { rows } = await q.query<{ external_id: string }>(
    "select external_id from google_seen where integration_id = $1 and source = $2 and external_id = any($3::text[])",
    [integrationId, source, ids],
  );
  const seen = new Set(rows.map((r) => r.external_id));
  return new Set(ids.filter((id) => !seen.has(id)));
}

async function gmailTouches(db: Db, tenant: Tenant, s: GoogleSession, client: GoogleClient, ids: string[]): Promise<{ externalId: string; touches: Touch[] }[]> {
  const todo = await withTenant(db, tenant, (q) => unseen(q, s.integration.id, "gmail", ids));
  const out: { externalId: string; touches: Touch[] }[] = [];
  for (const id of ids) {
    if (!todo.has(id)) continue;
    try {
      const meta = await s.call((t) => client.gmailMetadata(t, id));
      out.push({ externalId: id, touches: touchesFromMessage(meta, s.integration.googleEmail) });
    } catch (err) {
      // Deleted between list and get: nothing to count.
      if (err instanceof GoogleApiError && err.status === 404) out.push({ externalId: id, touches: [] });
      else throw err;
    }
  }
  return out;
}

function eventTouches(events: CalendarEvent[], selfEmail: string, now: Date): { externalId: string; touches: Touch[] }[] {
  const out: { externalId: string; touches: Touch[] }[] = [];
  for (const e of events) {
    const t = touchesFromEvent(e, selfEmail, now);
    // Future events aren't touches yet; leave them unseen so a later sync counts them once they happen.
    if (t !== "future") out.push({ externalId: e.id, touches: t });
  }
  return out;
}

/** Candidates from the aggregates, as suggestions. Pending ones are refreshed with the latest counts. */
async function refreshCandidates(q: Queryable, tenant: Tenant, integrationId: string): Promise<number> {
  const { rows } = await q.query<Record<string, unknown>>("select * from google_contacts where integration_id = $1", [integrationId]);
  const members = new Set((await q.query<{ email: string }>("select lower(email) as email from members")).rows.map((r) => r.email));
  const people = (await q.query<{ id: string; name: string; emails: string[] }>("select id, name, emails from people")).rows.map((p) => ({ ...p, emails: p.emails ?? [] }));
  const drafts: SuggestionDraft[] = [];
  for (const r of rows) {
    const c: ContactAggregate = {
      email: String(r.email),
      name: (r.name as string | null) ?? null,
      organization: (r.organization as string | null) ?? null,
      firstTouch: iso(r.first_touch)!,
      lastTouch: iso(r.last_touch)!,
      sentCount: Number(r.sent_count),
      receivedCount: Number(r.received_count),
      meetingCount: Number(r.meeting_count),
    };
    if (members.has(c.email) || !isRelationshipCandidate(c)) continue;
    const match = matchPerson(people, { email: c.email, name: c.name });
    if (match?.by === "email") continue; // already a record
    drafts.push({
      kind: "upsert_person",
      dedupeKey: `g:${tenant.memberId}:${c.email}`,
      payload: {
        email: c.email,
        name: c.name ?? nameFromAddress({ email: c.email, name: null }),
        organization: c.organization,
        title: null,
        firstTouch: c.firstTouch,
        lastTouch: c.lastTouch,
        sentCount: c.sentCount,
        receivedCount: c.receivedCount,
        meetingCount: c.meetingCount,
        mergeIntoPersonId: match?.person.id ?? null,
        mergeIntoName: match?.person.name ?? null,
      },
    });
  }
  return insertSuggestions(q, tenant, { ownerId: tenant.memberId, scope: "private", source: "google_import", messageId: null }, drafts, { refreshPending: true });
}

const gmailQuery = (since: Date) => `after:${Math.floor(since.getTime() / 1000)} -in:chats -category:promotions -category:social -category:forums`;

// ---------------------------------------------------------------------------
// Jobs

async function run(db: Db, tenant: Tenant | null, integrationId: unknown, deps: GoogleJobDeps, body: (s: GoogleSession) => Promise<void>): Promise<void> {
  if (!tenant) throw new PermanentJobError("Google jobs act for a member");
  if (typeof integrationId !== "string") throw new PermanentJobError("integrationId required");
  const s = await GoogleSession.open(db, tenant, integrationId, deps);
  if (!s) return; // disconnected or removed: nothing to do
  try {
    await body(s);
  } catch (err) {
    if (err instanceof IntegrationGone) return; // owner already notified
    if (err instanceof GoogleGrantError && err.code === "insufficient_scope") {
      await s.disconnect("Google access no longer includes Gmail/Calendar read permission").catch(() => undefined);
      return;
    }
    throw err;
  }
}

/**
 * crm.google_import: the initial two-year import. Works in bounded runs,
 * saving its cursor with each page and continuing in a follow-up job, so a
 * crash or retry resumes where it stopped and never double-counts.
 */
export function googleImportJob(db: Db, tenant: Tenant | null, integrationId: unknown, deps: GoogleJobDeps): Promise<void> {
  return run(db, tenant, integrationId, deps, async (s) => {
    const t = tenant!;
    const id = s.integration.id;
    if (s.integration.importStatus === "complete") return;
    const cur: ImportCursor = { phase: "gmail", step: 0, ...s.integration.cursor };
    const hasGmail = s.integration.scopes.includes(GMAIL_SCOPE);
    const hasCalendar = s.integration.scopes.includes(CALENDAR_SCOPE);
    const since = new Date(deps.now.getTime() - HISTORY_DAYS * DAY);
    const budget = deps.pagesPerRun ?? 10;
    let pages = 0;

    const save = (fn?: (q: Queryable) => Promise<void>) =>
      withTenant(db, t, async (q) => {
        if (fn) await fn(q);
        await q.query("update google_integrations set import_cursor = $2, import_status = 'running', updated_at = now() where id = $1", [id, JSON.stringify(cur)]);
      });

    if (cur.phase === "gmail" && !hasGmail) cur.phase = "calendar";
    while (cur.phase === "gmail" && pages < budget) {
      if (!cur.historyId) cur.historyId = (await s.call((tk) => deps.client.gmailProfile(tk))).historyId;
      const page = await s.call((tk) => deps.client.gmailList(tk, { q: gmailQuery(since), pageToken: cur.gmailPageToken }));
      const items = await gmailTouches(db, t, s, deps.client, page.messages.map((m) => m.id));
      pages++;
      cur.gmailPageToken = page.nextPageToken;
      if (!page.nextPageToken) cur.phase = "calendar";
      await save((q) => recordTouches(q, t, id, "gmail", items).then(() => undefined));
    }

    if (cur.phase === "calendar" && !hasCalendar) cur.phase = "candidates";
    while (cur.phase === "calendar" && pages < budget) {
      const page = await s.call((tk) => deps.client.calendarEvents(tk, { timeMin: since.toISOString(), pageToken: cur.calendarPageToken }));
      pages++;
      cur.calendarPageToken = page.nextPageToken;
      if (!page.nextPageToken) {
        cur.calendarSyncToken = page.nextSyncToken;
        cur.phase = "candidates";
      }
      const items = eventTouches(page.events, s.integration.googleEmail, deps.now);
      await save((q) => recordTouches(q, t, id, "calendar", items).then(() => undefined));
    }

    if (cur.phase !== "candidates") {
      cur.step = (cur.step ?? 0) + 1;
      await save((q) => enqueueAsTenant(q, { kind: "crm.google_import", payload: { integrationId: id }, dedupeKey: `crm.google_import:${id}:cont:${cur.step}` }));
      return;
    }

    await withTenant(db, t, async (q) => {
      const n = await refreshCandidates(q, t, id);
      await q.query(
        `update google_integrations set import_status = 'complete', import_cursor = '{}', gmail_history_id = $2, calendar_sync_token = $3,
           import_completed_at = $4, last_synced_at = $4, updated_at = $4 where id = $1`,
        [id, cur.historyId ?? null, cur.calendarSyncToken ?? null, deps.now.toISOString()],
      );
      await q.query(
        `insert into crm_notices (id, workspace_id, member_id, kind, message, dedupe_key) values ($1,$2,$3,'import_ready',$4,$5)
         on conflict (workspace_id, dedupe_key) do nothing`,
        [randomUUID(), t.workspaceId, t.memberId, `Your email and calendar history is in: ${n} people to confirm on the Integrations page.`, `google:${id}:import_ready`],
      );
      await audit(q, t.workspaceId, "system:google", "integration.google_imported", id, { candidates: n });
    });
  });
}

const SYNC_PAGE_CAP = 20;

/**
 * crm.google_sync_account: incremental daily sync using the Gmail history id
 * and the Calendar sync token. An expired cursor (404 / 410) falls back to a
 * dated re-list; the seen table keeps counts exact.
 */
export function googleSyncAccountJob(db: Db, tenant: Tenant | null, integrationId: unknown, deps: GoogleJobDeps): Promise<void> {
  return run(db, tenant, integrationId, deps, async (s) => {
    const t = tenant!;
    const id = s.integration.id;
    if (s.integration.importStatus !== "complete") return;
    const lastSync = s.integration.lastSyncedAt ? new Date(s.integration.lastSyncedAt) : new Date(deps.now.getTime() - 7 * DAY);
    const overlap = new Date(lastSync.getTime() - DAY);
    let historyId = s.integration.historyId;
    let syncToken = s.integration.calendarSyncToken;

    if (s.integration.scopes.includes(GMAIL_SCOPE)) {
      const ids: string[] = [];
      let fallback = !historyId;
      if (historyId) {
        let pageToken: string | null = null;
        try {
          for (let i = 0; i < SYNC_PAGE_CAP; i++) {
            const h = await s.call((tk) => deps.client.gmailHistory(tk, { startHistoryId: historyId!, pageToken }));
            ids.push(...h.messageIds);
            if (h.historyId) historyId = h.historyId;
            pageToken = h.nextPageToken;
            if (!pageToken) break;
          }
        } catch (err) {
          if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
          fallback = true; // history id too old
        }
      }
      if (fallback) {
        historyId = (await s.call((tk) => deps.client.gmailProfile(tk))).historyId;
        let pageToken: string | null = null;
        for (let i = 0; i < SYNC_PAGE_CAP; i++) {
          const page = await s.call((tk) => deps.client.gmailList(tk, { q: gmailQuery(overlap), pageToken }));
          ids.push(...page.messages.map((m) => m.id));
          pageToken = page.nextPageToken;
          if (!pageToken) break;
        }
      }
      const items = await gmailTouches(db, t, s, deps.client, [...new Set(ids)]);
      await withTenant(db, t, (q) => recordTouches(q, t, id, "gmail", items));
    }

    if (s.integration.scopes.includes(CALENDAR_SCOPE)) {
      const events: CalendarEvent[] = [];
      const list = async (p: { syncToken?: string | null; timeMin?: string }) => {
        let pageToken: string | null = null;
        let next: string | null = null;
        for (let i = 0; i < SYNC_PAGE_CAP; i++) {
          const page = await s.call((tk) => deps.client.calendarEvents(tk, { ...p, pageToken }));
          events.push(...page.events);
          pageToken = page.nextPageToken;
          next = page.nextSyncToken ?? next;
          if (!pageToken) break;
        }
        return next;
      };
      try {
        syncToken = syncToken ? await list({ syncToken }) : await list({ timeMin: overlap.toISOString() });
      } catch (err) {
        if (!(err instanceof GoogleApiError && err.status === 410)) throw err;
        events.length = 0;
        syncToken = await list({ timeMin: overlap.toISOString() }); // sync token expired: full resync of the recent window
      }
      const items = eventTouches(events, s.integration.googleEmail, deps.now);
      await withTenant(db, t, (q) => recordTouches(q, t, id, "calendar", items));
    }

    await withTenant(db, t, async (q) => {
      const n = await refreshCandidates(q, t, id);
      await q.query("update google_integrations set gmail_history_id = $2, calendar_sync_token = $3, last_synced_at = $4, updated_at = $4 where id = $1", [
        id,
        historyId,
        syncToken,
        deps.now.toISOString(),
      ]);
      await audit(q, t.workspaceId, "system:google", "integration.google_synced", id, { candidates: n });
    });
  });
}

/** crm.google_sync (daily, platform-level): fan out one sync per connected account, once per day. */
export async function googleSyncFanOut(db: Db, now: Date): Promise<number> {
  return withSystem(db, async (q) => {
    const { rows } = await q.query<{ id: string; workspace_id: string; member_id: string }>(
      "select id, workspace_id, member_id from google_integrations where status = 'connected' and import_status = 'complete'",
    );
    const day = now.toISOString().slice(0, 10);
    for (const r of rows) {
      await enqueue(q, {
        kind: "crm.google_sync_account",
        payload: { integrationId: r.id },
        tenant: { workspaceId: r.workspace_id, memberId: r.member_id },
        dedupeKey: `crm.google_sync_account:${r.id}:${day}`,
      });
    }
    return rows.length;
  });
}
