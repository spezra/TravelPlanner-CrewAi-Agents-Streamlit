/**
 * Google OAuth 2.0 (authorization code + PKCE) and the read-only Gmail and
 * Calendar calls used to build relationship records from history. Every HTTP
 * call goes through an injectable fetch so tests never touch the network.
 *
 * Docs: developers.google.com/identity/protocols/oauth2/web-server,
 * developers.google.com/gmail/api/reference/rest, developers.google.com/calendar/api/v3/reference.
 */
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The grant is gone (revoked, expired, password change): the member must reconnect. */
export class GoogleGrantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GoogleGrantError";
  }
}

/** A non-auth API failure. `status` 404/410 on sync cursors means "start over". */
export class GoogleApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GoogleApiError";
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
  scopes: string[];
  idToken: string | null;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailMessageMeta {
  id: string;
  internalDate: string | null;
  labelIds: string[];
  headers: Record<string, string>;
}

export interface CalendarEvent {
  id: string;
  status: string;
  start: string | null;
  summary: string | null;
  organizer: { email: string; self: boolean } | null;
  attendees: { email: string; displayName: string | null; self: boolean; resource: boolean }[];
}

// PKCE (RFC 7636)
export const newCodeVerifier = (): string => randomBytes(48).toString("base64url");
export const codeChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

/** Reads the email claim of an ID token received directly from Google's token endpoint over TLS (OIDC Core 3.1.3.7). */
export function idTokenEmail(idToken: string): { email: string; verified: boolean } | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { email?: string; email_verified?: boolean; iss?: string };
    if (!claims.email) return null;
    if (claims.iss && claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return null;
    return { email: claims.email.toLowerCase(), verified: claims.email_verified !== false };
  } catch {
    return null;
  }
}

export class GoogleClient {
  constructor(
    private readonly opts: { clientId: string; clientSecret: string; redirectUri: string; fetch?: FetchLike },
  ) {}

  private get fetch(): FetchLike {
    return this.opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  authUrl(p: { state: string; codeChallenge: string; loginHint?: string }): string {
    const q = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      // Consent every time so Google returns a refresh token even on reconnect.
      prompt: "consent",
      include_granted_scopes: "true",
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: "S256",
    });
    if (p.loginHint) q.set("login_hint", p.loginHint);
    return `${AUTH_URL}?${q.toString()}`;
  }

  exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    return this.token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: this.opts.redirectUri });
  }

  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  /** Best effort: a token that's already invalid is as good as revoked. */
  async revoke(token: string): Promise<void> {
    await this.fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }).catch(() => undefined);
  }

  private async token(params: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: this.opts.clientId, client_secret: this.opts.clientSecret, ...params }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
      // invalid_grant: code reused/expired, or refresh token revoked/expired. Nothing to retry.
      if (code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client") {
        throw new GoogleGrantError(code, typeof body.error_description === "string" ? body.error_description : code);
      }
      throw new GoogleApiError(res.status, `token endpoint: ${code}`);
    }
    if (typeof body.access_token !== "string") throw new GoogleApiError(502, "token endpoint returned no access_token");
    return {
      accessToken: body.access_token,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3600,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
      idToken: typeof body.id_token === "string" ? body.id_token : null,
    };
  }

  private async get<T>(accessToken: string, url: string): Promise<T> {
    const res = await this.fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
    if (res.status === 401) throw new GoogleGrantError("unauthorized", "access token rejected");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 403 insufficientPermissions: the scope was not granted. Treat as a lost grant for that API.
      if (res.status === 403 && /insufficient|PERMISSION_DENIED/i.test(text)) throw new GoogleGrantError("insufficient_scope", "scope not granted");
      throw new GoogleApiError(res.status, `${new URL(url).pathname}: HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  gmailProfile(token: string): Promise<{ emailAddress: string; historyId: string }> {
    return this.get(token, `${GMAIL}/profile`);
  }

  async gmailList(token: string, p: { q: string; pageToken?: string | null; maxResults?: number }): Promise<{ messages: GmailMessageRef[]; nextPageToken: string | null }> {
    const q = new URLSearchParams({ q: p.q, maxResults: String(p.maxResults ?? 100) });
    if (p.pageToken) q.set("pageToken", p.pageToken);
    const r = await this.get<{ messages?: GmailMessageRef[]; nextPageToken?: string }>(token, `${GMAIL}/messages?${q}`);
    return { messages: r.messages ?? [], nextPageToken: r.nextPageToken ?? null };
  }

  async gmailMetadata(token: string, id: string): Promise<GmailMessageMeta> {
    const q = new URLSearchParams({ format: "metadata" });
    for (const h of ["From", "To", "Cc", "Date", "Subject"]) q.append("metadataHeaders", h);
    const r = await this.get<{ id: string; internalDate?: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } }>(
      token,
      `${GMAIL}/messages/${encodeURIComponent(id)}?${q}`,
    );
    const headers: Record<string, string> = {};
    for (const h of r.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
    return { id: r.id, internalDate: r.internalDate ?? null, labelIds: r.labelIds ?? [], headers };
  }

  /** Messages added since a history id. 404 means the id is too old: fall back to a dated list. */
  async gmailHistory(token: string, p: { startHistoryId: string; pageToken?: string | null }): Promise<{ messageIds: string[]; historyId: string | null; nextPageToken: string | null }> {
    const q = new URLSearchParams({ startHistoryId: p.startHistoryId, historyTypes: "messageAdded", maxResults: "500" });
    if (p.pageToken) q.set("pageToken", p.pageToken);
    const r = await this.get<{ history?: { messagesAdded?: { message: GmailMessageRef }[] }[]; historyId?: string; nextPageToken?: string }>(token, `${GMAIL}/history?${q}`);
    const ids = new Set<string>();
    for (const h of r.history ?? []) for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
    return { messageIds: [...ids], historyId: r.historyId ?? null, nextPageToken: r.nextPageToken ?? null };
  }

  /**
   * Primary calendar events. Initial sync passes timeMin; incremental sync
   * passes only syncToken (410 Gone means the token expired: full resync).
   */
  async calendarEvents(
    token: string,
    p: { timeMin?: string; syncToken?: string | null; pageToken?: string | null },
  ): Promise<{ events: CalendarEvent[]; nextPageToken: string | null; nextSyncToken: string | null }> {
    const q = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
    if (p.syncToken) q.set("syncToken", p.syncToken);
    else if (p.timeMin) q.set("timeMin", p.timeMin);
    if (p.pageToken) q.set("pageToken", p.pageToken);
    type Raw = {
      id: string;
      status?: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      organizer?: { email?: string; self?: boolean };
      attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean }[];
    };
    const r = await this.get<{ items?: Raw[]; nextPageToken?: string; nextSyncToken?: string }>(token, `${CALENDAR}/events?${q}`);
    return {
      events: (r.items ?? []).map((e) => ({
        id: e.id,
        status: e.status ?? "confirmed",
        start: e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null),
        summary: e.summary ?? null,
        organizer: e.organizer?.email ? { email: e.organizer.email.toLowerCase(), self: Boolean(e.organizer.self) } : null,
        attendees: (e.attendees ?? [])
          .filter((a) => a.email)
          .map((a) => ({ email: a.email!.toLowerCase(), displayName: a.displayName ?? null, self: Boolean(a.self), resource: Boolean(a.resource) })),
      })),
      nextPageToken: r.nextPageToken ?? null,
      nextSyncToken: r.nextSyncToken ?? null,
    };
  }
}
