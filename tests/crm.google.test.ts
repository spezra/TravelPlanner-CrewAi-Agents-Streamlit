import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import { GoogleClient } from "@/providers/google";
import { drain, enqueue } from "@/server/jobs/queue";
import { MemoryMailer } from "@/server/mail";
import { beginGoogleAuth, completeGoogleAuth, getIntegration, touchesFromMessage } from "@/modules/crm/google";
import { acceptSuggestions, listSuggestions } from "@/modules/crm/inbound";
import { createHandlers } from "@/modules/crm/jobs";
import { listLedger, listNotices, listPeople } from "@/modules/crm/people";
import { NOW, useDb } from "./helpers/db";
import { assistant, expert, fakeFetch, json, seedCrmData, type Route } from "./helpers/crm";

const getDb = useDb();
let db: Db;
let mail: MemoryMailer;
beforeEach(async () => {
  db = getDb();
  mail = new MemoryMailer();
  await seedCrmData(db);
});

const SELF = "marisol@example.com";
const idToken = (email: string) =>
  ["e30", Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", email, email_verified: true })).toString("base64url"), "sig"].join(".");

interface TokenState {
  challenge?: string;
  refreshFails?: boolean;
}

/** Google's token endpoint: checks the PKCE verifier against the challenge from the auth URL. */
function tokenEndpoint(st: TokenState): Route {
  return (url, init) => {
    if (url.href !== "https://oauth2.googleapis.com/token") return;
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "authorization_code") {
      const verifier = form.get("code_verifier") ?? "";
      if (form.get("code") !== "good-code" || createHash("sha256").update(verifier).digest("base64url") !== st.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      return json({
        access_token: "ya29.access-1",
        expires_in: 3600,
        refresh_token: "1//refresh-1",
        scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
        id_token: idToken(SELF),
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (st.refreshFails) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      return json({ access_token: "ya29.access-2", expires_in: 3600 });
    }
  };
}

const msg = (id: string, from: string, to: string, date: string, labels: string[] = []) => ({
  id,
  internalDate: String(Date.parse(date)),
  labelIds: labels,
  payload: { headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Date", value: date }, { name: "Subject", value: "hello" }] },
});

const MESSAGES: Record<string, ReturnType<typeof msg>> = {
  m1: msg("m1", `Marisol Vega <${SELF}>`, "Chef Ana Ruiz <ana@cocina-ruiz.example>", "2026-03-01T10:00:00Z", ["SENT"]),
  m2: msg("m2", "Chef Ana Ruiz <ana@cocina-ruiz.example>", SELF, "2026-03-02T10:00:00Z", ["INBOX"]),
  m3: msg("m3", "News <newsletter@brand.example>", SELF, "2026-04-01T10:00:00Z", ["INBOX"]),
  m4: msg("m4", "Rafael Montes <rafael@haciendatierraroja.example>", SELF, "2026-05-01T10:00:00Z", ["INBOX"]),
  m5: msg("m5", `Marisol Vega <${SELF}>`, "rafael@haciendatierraroja.example", "2026-05-02T10:00:00Z", ["SENT"]),
  m6: msg("m6", "Cold Pitch <sales@pitch.example>", SELF, "2026-06-01T10:00:00Z", ["INBOX"]),
  m7: msg("m7", "Chef Ana Ruiz <ana@cocina-ruiz.example>", SELF, "2026-09-20T10:00:00Z", ["INBOX"]),
};

function googleApis(opts: { history?: string[] } = {}): Route {
  return (url, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (!url.host.endsWith("googleapis.com") || url.host === "oauth2.googleapis.com") return;
    if (auth !== "Bearer ya29.access-1" && auth !== "Bearer ya29.access-2") return json({ error: { code: 401 } }, 401);
    const p = url.pathname;
    if (p === "/gmail/v1/users/me/profile") return json({ emailAddress: SELF, historyId: "1000" });
    if (p === "/gmail/v1/users/me/messages") {
      expect(url.searchParams.get("q")).toMatch(/^after:\d+ /);
      return url.searchParams.get("pageToken") === "p2"
        ? json({ messages: [{ id: "m4", threadId: "t" }, { id: "m5", threadId: "t" }, { id: "m6", threadId: "t" }] })
        : json({ messages: [{ id: "m1", threadId: "t" }, { id: "m2", threadId: "t" }, { id: "m3", threadId: "t" }], nextPageToken: "p2" });
    }
    const m = /^\/gmail\/v1\/users\/me\/messages\/(\w+)$/.exec(p);
    if (m) {
      expect(url.searchParams.get("format")).toBe("metadata");
      return MESSAGES[m[1]!] ? json(MESSAGES[m[1]!]) : json({}, 404);
    }
    if (p === "/gmail/v1/users/me/history") {
      if (!opts.history) return json({ error: { code: 404 } }, 404);
      return json({ history: [{ messagesAdded: opts.history.map((id) => ({ message: { id, threadId: "t" } })) }], historyId: "2000" });
    }
    if (p === "/calendar/v3/calendars/primary/events") {
      if (url.searchParams.get("syncToken")) return json({ items: [], nextSyncToken: "sync-2" });
      return json({
        items: [
          {
            id: "e1",
            status: "confirmed",
            start: { dateTime: "2026-07-10T15:00:00Z" },
            attendees: [{ email: SELF, self: true }, { email: "tomas@dmc-oaxaca.example", displayName: "Tomás Vidal" }, { email: "room-1@resource.calendar.google.com", resource: true }],
          },
          { id: "e2", status: "cancelled", start: { dateTime: "2026-07-11T15:00:00Z" }, attendees: [{ email: "gone@x.example" }] },
          { id: "e3", status: "confirmed", start: { dateTime: "2027-01-01T15:00:00Z" }, attendees: [{ email: "future@x.example" }] },
        ],
        nextSyncToken: "sync-1",
      });
    }
  };
}

function setup(st: TokenState = {}, apis: Route = googleApis()) {
  const fetch = fakeFetch(tokenEndpoint(st), apis);
  const client = new GoogleClient({ clientId: "cid.apps.googleusercontent.com", clientSecret: "secret", redirectUri: "https://app.example.test/api/integrations/google/callback", fetch });
  const handlers = createHandlers({ llm: () => null, google: () => client, mailer: () => mail, now: () => NOW, pagesPerRun: 1 });
  return { fetch, client, handlers };
}

async function connect(st: TokenState, client: GoogleClient) {
  const url = new URL(await beginGoogleAuth(db, expert, client, NOW));
  st.challenge = url.searchParams.get("code_challenge")!;
  return completeGoogleAuth(db, expert, client, { code: "good-code", state: url.searchParams.get("state") }, NOW);
}

describe("Google OAuth", () => {
  it("builds a PKCE authorization request with state and the read-only scopes", async () => {
    const { client } = setup();
    const url = new URL(await beginGoogleAuth(db, expert, client, NOW));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    const stored = await withSystem(db, (q) => q.query<{ state_hash: string; verifier_sealed: string }>("select * from google_oauth_states"));
    expect(stored.rows[0]!.state_hash).not.toBe(url.searchParams.get("state"));
  });

  it("validates state: unknown, another member's, expired, reused", async () => {
    const st: TokenState = {};
    const { client } = setup(st);
    await expect(completeGoogleAuth(db, expert, client, { code: "good-code", state: "forged" }, NOW)).rejects.toThrow(/invalid/);

    const url = new URL(await beginGoogleAuth(db, expert, client, NOW));
    st.challenge = url.searchParams.get("code_challenge")!;
    const state = url.searchParams.get("state");
    // The assistant can't complete the expert's flow (row-level security hides the state).
    await expect(completeGoogleAuth(db, assistant, client, { code: "good-code", state }, NOW)).rejects.toThrow(/invalid/);
    const late = new Date(NOW.getTime() + 11 * 60_000);
    await expect(completeGoogleAuth(db, expert, client, { code: "good-code", state }, late)).rejects.toThrow(/expired/);

    const url2 = new URL(await beginGoogleAuth(db, expert, client, NOW));
    st.challenge = url2.searchParams.get("code_challenge")!;
    await completeGoogleAuth(db, expert, client, { code: "good-code", state: url2.searchParams.get("state") }, NOW);
    await expect(completeGoogleAuth(db, expert, client, { code: "good-code", state: url2.searchParams.get("state") }, NOW)).rejects.toThrow(/already used/);
  });

  it("a wrong PKCE verifier or a denied consent fails without storing tokens", async () => {
    const st: TokenState = {};
    const { client } = setup(st);
    const url = new URL(await beginGoogleAuth(db, expert, client, NOW));
    st.challenge = "not-the-challenge";
    await expect(completeGoogleAuth(db, expert, client, { code: "good-code", state: url.searchParams.get("state") }, NOW)).rejects.toThrow(/rejected/);
    const url2 = new URL(await beginGoogleAuth(db, expert, client, NOW));
    await expect(completeGoogleAuth(db, expert, client, { error: "access_denied", state: url2.searchParams.get("state") }, NOW)).rejects.toThrow(/not granted/);
    expect((await withSystem(db, (q) => q.query("select * from google_integrations"))).rows).toHaveLength(0);
  });

  it("stores tokens encrypted, private to the member, and queues the import", async () => {
    const st: TokenState = {};
    const { client } = setup(st);
    const { integrationId } = await connect(st, client);
    const row = await withSystem(db, (q) => q.query<Record<string, string>>("select * from google_integrations where id = $1", [integrationId]));
    expect(row.rows[0]!.google_email).toBe(SELF);
    expect(row.rows[0]!.access_token_sealed).not.toContain("ya29");
    expect(row.rows[0]!.refresh_token_sealed).not.toContain("refresh-1");
    expect(await withTenant(db, expert, getIntegration)).toMatchObject({ status: "connected", importStatus: "pending" });
    expect(await withTenant(db, assistant, getIntegration)).toBeNull();
    const jobs = await withSystem(db, (q) => q.query<{ kind: string }>("select kind from jobs"));
    expect(jobs.rows.map((j) => j.kind)).toEqual(["crm.google_import"]);
  });
});

describe("Google import and sync", () => {
  it("builds candidates from two years of metadata, resumably and idempotently", async () => {
    const st: TokenState = {};
    const { client, handlers, fetch } = setup(st);
    const { integrationId } = await connect(st, client);
    await drain(db, handlers);

    const integ = await withTenant(db, expert, getIntegration);
    expect(integ).toMatchObject({ importStatus: "complete" });
    // pagesPerRun = 1: two Gmail pages and one Calendar page ran as three jobs.
    const runs = await withSystem(db, (q) => q.query<{ n: number }>("select count(*)::int as n from jobs where kind = 'crm.google_import' and status = 'done'"));
    expect(runs.rows[0]!.n).toBe(3);

    const sugg = await withTenant(db, expert, (q) => listSuggestions(q, { source: "google_import" }));
    // Ana: two-way. Tomás: a meeting. Rafael already has a record; newsletters, pitches, resources, cancelled and future events don't count.
    expect(sugg.map((s) => s.payload.email).sort()).toEqual(["ana@cocina-ruiz.example", "tomas@dmc-oaxaca.example"]);
    const ana = sugg.find((s) => s.payload.email === "ana@cocina-ruiz.example")!;
    expect(ana.payload).toMatchObject({ name: "Chef Ana Ruiz", organization: "Cocina Ruiz", sentCount: 1, receivedCount: 1, lastTouch: "2026-03-02T10:00:00.000Z" });
    // Suggestions are private to the member who connected.
    expect(await withTenant(db, assistant, (q) => listSuggestions(q, { source: "google_import" }))).toHaveLength(0);
    // Only metadata was requested; no message bodies.
    expect(fetch.calls.filter((c) => c.url.pathname.includes("/messages/")).every((c) => c.url.searchParams.get("format") === "metadata")).toBe(true);

    // Run the import again from scratch: counts and suggestions don't double.
    await withSystem(db, (q) => q.query("update google_integrations set import_status = 'pending', import_cursor = '{}'"));
    await withSystem(db, (q) => enqueue(q, { kind: "crm.google_import", payload: { integrationId }, tenant: expert, dedupeKey: "rerun" }));
    await drain(db, handlers);
    const again = await withTenant(db, expert, (q) => listSuggestions(q, { source: "google_import" }));
    expect(again).toHaveLength(2);
    expect(again.find((s) => s.payload.email === "ana@cocina-ruiz.example")!.payload).toMatchObject({ sentCount: 1, receivedCount: 1 });

    // Bulk accept: people with a last-touch ledger entry, no manual entry.
    const r = await acceptSuggestions(db, expert, again.map((s) => s.id), NOW);
    expect(r).toEqual({ accepted: 2, failed: [] });
    const people = await withTenant(db, expert, (q) => listPeople(q, expert));
    const anaP = people.find((p) => p.emails.includes("ana@cocina-ruiz.example"))!;
    expect(anaP).toMatchObject({ scope: "private", source: "google_import", ownerId: DEMO.expert });
    expect(await withTenant(db, expert, (q) => listLedger(q, anaP.id))).toEqual([expect.objectContaining({ kind: "touch", at: "2026-03-02T10:00:00.000Z", source: "google_import" })]);
    expect((await withTenant(db, expert, listNotices)).map((n) => n.kind)).toContain("import_ready");
  });

  it("syncs incrementally from the history id and calendar sync token", async () => {
    const st: TokenState = {};
    const { client, handlers } = setup(st, googleApis({ history: ["m7", "m2"] }));
    const { integrationId } = await connect(st, client);
    await drain(db, handlers);
    await withSystem(db, (q) => enqueue(q, { kind: "crm.google_sync" }));
    await drain(db, handlers);
    const row = await withSystem(db, (q) => q.query<{ gmail_history_id: string; calendar_sync_token: string }>("select * from google_integrations where id = $1", [integrationId]));
    expect(row.rows[0]).toMatchObject({ gmail_history_id: "2000", calendar_sync_token: "sync-2" });
    const c = await withSystem(db, (q) => q.query<{ received_count: number; last_touch: Date | string }>("select * from google_contacts where email = 'ana@cocina-ruiz.example'"));
    // m7 is new; m2 was already counted.
    expect(c.rows[0]!.received_count).toBe(2);
    expect(new Date(c.rows[0]!.last_touch).toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });

  it("a revoked grant disconnects the integration and tells the owner", async () => {
    const st: TokenState = {};
    const { client, handlers } = setup(st);
    const { integrationId } = await connect(st, client);
    // The access token has expired and Google refuses the refresh token.
    await withSystem(db, (q) => q.query("update google_integrations set access_expires_at = $1", [new Date(NOW.getTime() - 1000).toISOString()]));
    st.refreshFails = true;
    await drain(db, handlers);
    const row = await withSystem(db, (q) => q.query<Record<string, unknown>>("select * from google_integrations where id = $1", [integrationId]));
    expect(row.rows[0]).toMatchObject({ status: "disconnected", access_token_sealed: null, refresh_token_sealed: null });
    const job = await withSystem(db, (q) => q.query<{ status: string }>("select status from jobs where kind = 'crm.google_import'"));
    expect(job.rows[0]!.status).toBe("done"); // nothing to retry
    expect((await withTenant(db, expert, listNotices)).map((n) => n.kind)).toContain("integration_disconnected");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: SELF, subject: "Google connection needs attention" });
    expect(mail.sent[0]!.text).toMatch(/Sent automatically by the agency's booking system/);
  });

  it("reads direction from metadata", () => {
    expect(touchesFromMessage({ id: "x", internalDate: null, labelIds: [], headers: { from: "a@b.example", date: "Tue, 1 Sep 2026 10:00:00 +0000" } }, SELF)).toEqual([
      { email: "a@b.example", name: null, kind: "received", at: "2026-09-01T10:00:00.000Z" },
    ]);
    const many = Array.from({ length: 20 }, (_, i) => `p${i}@x.example`).join(", ");
    expect(touchesFromMessage({ id: "y", internalDate: "0", labelIds: ["SENT"], headers: { from: SELF, to: many } }, SELF)).toEqual([]);
  });
});
