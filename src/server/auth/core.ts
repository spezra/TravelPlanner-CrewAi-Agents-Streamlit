/**
 * Passwordless sign-in, sessions, workspace creation and invitations.
 * Framework-free so it can be tested directly; src/server/auth/session.ts
 * adapts it to Next.js cookies.
 *
 * Tokens are random 256-bit values; only their SHA-256 hashes are stored.
 * Sign-in links are single-use, short-lived and consumed by an explicit POST
 * (email scanners prefetch GET links).
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { withSystem } from "@/db/tenant";
import type { Role } from "@/domain/common";
import { DomainError } from "@/domain/common";
import { config } from "../config";
import { newToken, sha256 } from "../crypto";
import { SYSTEM_FOOTER, type Mailer } from "../mail";
import { hit } from "../rateLimit";

const LOGIN_TOKEN_MINUTES = 15;
const INVITE_DAYS = 7;

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  member: { id: string; workspaceId: string; workspaceName: string; role: Role; name: string; timeZone: string } | null;
  memberships: { memberId: string; workspaceId: string; workspaceName: string; role: Role }[];
}

/**
 * Always reports success to the caller (no account enumeration). Limited per
 * email and per IP.
 */
export async function requestLoginLink(db: Db, mail: Mailer, input: { email: string; ip: string | null; next?: string }, now = new Date()): Promise<void> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new DomainError("bad_email", "Enter a valid email address");
  const token = newToken();
  const allowed = await withSystem(db, async (q) => {
    const okEmail = await hit(q, `login:email:${email}`, 5, 900, now);
    const okIp = input.ip ? await hit(q, `login:ip:${input.ip}`, 30, 900, now) : true;
    if (!okEmail || !okIp) return false;
    await q.query("insert into login_tokens (token_hash, email, purpose, expires_at) values ($1, $2, 'login', $3)", [
      sha256(token),
      email,
      new Date(now.getTime() + LOGIN_TOKEN_MINUTES * 60_000).toISOString(),
    ]);
    return true;
  });
  if (!allowed) throw new DomainError("rate_limited", "Too many sign-in requests. Try again in a few minutes.");
  const next = input.next && input.next.startsWith("/") && !input.next.startsWith("//") ? input.next : "/";
  const link = `${config().APP_URL}/auth/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
  await mail.send({
    to: email,
    subject: "Your sign-in link",
    text: `Use this link to sign in. It works once and expires in ${LOGIN_TOKEN_MINUTES} minutes.\n\n${link}\n\nIf you didn't ask for this, you can ignore it.${SYSTEM_FOOTER}`,
  });
}

/** Consumes a sign-in token and opens a session. Creates the user on first sign-in (the email is now verified). */
export async function consumeLoginToken(
  db: Db,
  token: string,
  meta: { ip: string | null; userAgent: string | null },
  now = new Date(),
): Promise<{ sessionToken: string; userId: string }> {
  return withSystem(db, async (q) => {
    const { rows } = await q.query<{ email: string }>(
      "update login_tokens set used_at = $2 where token_hash = $1 and used_at is null and expires_at > $2 returning email",
      [sha256(token), now.toISOString()],
    );
    const email = rows[0]?.email;
    if (!email) throw new DomainError("invalid_token", "This sign-in link is invalid or has expired. Request a new one.");
    let user = (await q.query<{ id: string; disabled_at: string | null }>("select id, disabled_at from users where email = $1", [email])).rows[0];
    if (!user) {
      const id = randomUUID();
      await q.query("insert into users (id, email, name) values ($1, $2, $3)", [id, email, email.split("@")[0]]);
      user = { id, disabled_at: null };
    }
    if (user.disabled_at) throw new DomainError("disabled", "This account is disabled.");
    // Link any seeded or pre-created member records for this email that have no user yet.
    await q.query("update members set user_id = $1 where user_id is null and lower(email) = $2", [user.id, email]);
    const sessionToken = await createSession(q, user.id, meta, now);
    return { sessionToken, userId: user.id };
  });
}

async function createSession(q: Queryable, userId: string, meta: { ip: string | null; userAgent: string | null }, now: Date): Promise<string> {
  const token = newToken();
  const { rows } = await q.query<{ id: string }>(
    "select id from members where user_id = $1 and disabled_at is null order by (role = 'owner') desc, name limit 1",
    [userId],
  );
  await q.query(
    `insert into sessions (id, token_hash, user_id, member_id, expires_at, ip, user_agent) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      sha256(token),
      userId,
      rows[0]?.id ?? null,
      new Date(now.getTime() + config().SESSION_TTL_DAYS * 86_400_000).toISOString(),
      meta.ip,
      meta.userAgent?.slice(0, 300) ?? null,
    ],
  );
  return token;
}

/** Development/e2e only: sign in as an existing member by email without a link. */
export async function devLogin(db: Db, email: string, now = new Date()): Promise<string> {
  if (config().ALLOW_DEV_LOGIN !== "1" || config().NODE_ENV === "production") throw new DomainError("forbidden", "Dev login is disabled");
  return withSystem(db, async (q) => {
    const e = normalizeEmail(email);
    let user = (await q.query<{ id: string }>("select id from users where email = $1", [e])).rows[0];
    if (!user) {
      user = { id: randomUUID() };
      await q.query("insert into users (id, email, name) values ($1, $2, $3)", [user.id, e, e.split("@")[0]]);
    }
    await q.query("update members set user_id = $1 where user_id is null and lower(email) = $2", [user.id, e]);
    return createSession(q, user.id, { ip: null, userAgent: "dev-login" }, now);
  });
}

export async function getSession(db: Db, sessionToken: string, now = new Date()): Promise<SessionInfo | null> {
  return withSystem(db, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>(
      `select s.id as session_id, s.last_seen_at, u.id as user_id, u.email, u.name as user_name, s.member_id
         from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2 and u.disabled_at is null`,
      [sha256(sessionToken), now.toISOString()],
    );
    const s = rows[0];
    if (!s) return null;
    const memberships = (
      await q.query<Record<string, unknown>>(
        `select m.id, m.workspace_id, w.name as workspace_name, m.role, m.name, m.time_zone
           from members m join workspaces w on w.id = m.workspace_id
          where m.user_id = $1 and m.disabled_at is null order by w.name`,
        [s.user_id],
      )
    ).rows;
    const active = memberships.find((m) => m.id === s.member_id) ?? null;
    // Touch at most every 5 minutes to avoid a write per request.
    if (now.getTime() - new Date(String(s.last_seen_at)).getTime() > 300_000) {
      await q.query("update sessions set last_seen_at = $2 where id = $1", [s.session_id, now.toISOString()]);
    }
    return {
      sessionId: String(s.session_id),
      userId: String(s.user_id),
      email: String(s.email),
      name: String(s.user_name),
      member: active
        ? { id: String(active.id), workspaceId: String(active.workspace_id), workspaceName: String(active.workspace_name), role: active.role as Role, name: String(active.name), timeZone: String(active.time_zone ?? "UTC") }
        : null,
      memberships: memberships.map((m) => ({ memberId: String(m.id), workspaceId: String(m.workspace_id), workspaceName: String(m.workspace_name), role: m.role as Role })),
    };
  });
}

export async function switchMembership(db: Db, sessionId: string, userId: string, memberId: string): Promise<void> {
  await withSystem(db, async (q) => {
    const ok = await q.query("select 1 from members where id = $1 and user_id = $2 and disabled_at is null", [memberId, userId]);
    if (!ok.rows.length) throw new DomainError("forbidden", "Not a member of that workspace");
    await q.query("update sessions set member_id = $2 where id = $1", [sessionId, memberId]);
  });
}

export async function revokeSession(db: Db, sessionToken: string): Promise<void> {
  await withSystem(db, (q) => q.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(sessionToken)]));
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await withSystem(db, (q) => q.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]));
}

/** First-run: a signed-in user with no workspace creates one and becomes its owner. */
export async function createWorkspace(
  db: Db,
  input: { userId: string; sessionId: string; workspaceName: string; memberName: string; bookPortability: "advisor_owns" | "agency_owns" | "shared"; timeZone: string },
): Promise<{ workspaceId: string; memberId: string }> {
  const name = input.workspaceName.trim();
  if (name.length < 2) throw new DomainError("bad_name", "Workspace name is too short");
  return withSystem(db, async (q) => {
    const user = (await q.query<{ email: string }>("select email from users where id = $1", [input.userId])).rows[0];
    if (!user) throw new DomainError("not_found", "User not found");
    const workspaceId = randomUUID();
    const memberId = randomUUID();
    await q.query("insert into workspaces (id, name, book_portability) values ($1, $2, $3)", [workspaceId, name, input.bookPortability]);
    await q.query("insert into members (id, workspace_id, user_id, name, email, role, time_zone) values ($1, $2, $3, $4, $5, 'owner', $6)", [
      memberId,
      workspaceId,
      input.userId,
      input.memberName.trim() || user.email,
      user.email,
      input.timeZone,
    ]);
    await q.query("update sessions set member_id = $2 where id = $1", [input.sessionId, memberId]);
    await q.query("insert into audit_events (workspace_id, actor, action, subject) values ($1, $2, 'workspace.created', $3)", [workspaceId, memberId, workspaceId]);
    return { workspaceId, memberId };
  });
}

/** Owners and admins invite people by email with a role. */
export async function inviteMember(
  db: Db,
  mail: Mailer,
  input: { workspaceId: string; invitedBy: string; email: string; role: Role },
  now = new Date(),
): Promise<string> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new DomainError("bad_email", "Enter a valid email address");
  const token = newToken();
  const { workspaceName, inviterName } = await withSystem(db, async (q) => {
    const inviter = (
      await q.query<{ role: string; name: string; workspace_name: string }>(
        "select m.role, m.name, w.name as workspace_name from members m join workspaces w on w.id = m.workspace_id where m.id = $1 and m.workspace_id = $2 and m.disabled_at is null",
        [input.invitedBy, input.workspaceId],
      )
    ).rows[0];
    if (!inviter || (inviter.role !== "owner" && inviter.role !== "admin")) throw new DomainError("forbidden", "Only owners and admins can invite");
    if (input.role === "owner" && inviter.role !== "owner") throw new DomainError("forbidden", "Only owners can invite owners");
    const exists = await q.query("select 1 from members where workspace_id = $1 and lower(email) = $2 and disabled_at is null", [input.workspaceId, email]);
    if (exists.rows.length) throw new DomainError("exists", "That person is already a member");
    await q.query(
      "insert into invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [randomUUID(), input.workspaceId, email, input.role, sha256(token), input.invitedBy, new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString()],
    );
    await q.query("insert into audit_events (workspace_id, actor, action, subject, data) values ($1, $2, 'member.invited', $3, $4)", [
      input.workspaceId,
      input.invitedBy,
      email,
      JSON.stringify({ role: input.role }),
    ]);
    return { workspaceName: inviter.workspace_name, inviterName: inviter.name };
  });
  const link = `${config().APP_URL}/invite?token=${encodeURIComponent(token)}`;
  await mail.send({
    to: email,
    subject: `${inviterName} invited you to ${workspaceName}`,
    text: `${inviterName} invited you to join ${workspaceName} as ${input.role}.\n\n${link}\n\nThe invitation expires in ${INVITE_DAYS} days.${SYSTEM_FOOTER}`,
  });
  return token;
}

/** Accept an invitation as the signed-in user; the invitation email must match. */
export async function acceptInvitation(db: Db, input: { token: string; userId: string; sessionId: string; name: string; timeZone: string }, now = new Date()) {
  return withSystem(db, async (q) => {
    const user = (await q.query<{ email: string }>("select email from users where id = $1", [input.userId])).rows[0];
    const inv = (
      await q.query<{ id: string; workspace_id: string; email: string; role: string }>(
        "select id, workspace_id, email, role from invitations where token_hash = $1 and accepted_at is null and revoked_at is null and expires_at > $2",
        [sha256(input.token), now.toISOString()],
      )
    ).rows[0];
    if (!inv || !user) throw new DomainError("invalid_invite", "This invitation is invalid or has expired");
    if (normalizeEmail(user.email) !== inv.email) throw new DomainError("wrong_account", `This invitation is for ${inv.email}. Sign in with that address.`);
    const memberId = randomUUID();
    await q.query("insert into members (id, workspace_id, user_id, name, email, role, time_zone) values ($1, $2, $3, $4, $5, $6, $7)", [
      memberId,
      inv.workspace_id,
      input.userId,
      input.name.trim() || user.email,
      user.email,
      inv.role,
      input.timeZone,
    ]);
    await q.query("update invitations set accepted_at = $2 where id = $1", [inv.id, now.toISOString()]);
    await q.query("update sessions set member_id = $2 where id = $1", [input.sessionId, memberId]);
    await q.query("insert into audit_events (workspace_id, actor, action, subject) values ($1, $2, 'member.joined', $3)", [inv.workspace_id, memberId, memberId]);
    return { workspaceId: inv.workspace_id, memberId };
  });
}

/** Owners disable members; their sessions stop resolving to that workspace immediately. */
export async function disableMember(db: Db, input: { workspaceId: string; actorId: string; memberId: string }): Promise<void> {
  await withSystem(db, async (q) => {
    const actor = (await q.query<{ role: string }>("select role from members where id = $1 and workspace_id = $2", [input.actorId, input.workspaceId])).rows[0];
    if (actor?.role !== "owner") throw new DomainError("forbidden", "Only owners can remove members");
    if (input.actorId === input.memberId) throw new DomainError("forbidden", "You can't remove yourself");
    await q.query("update members set disabled_at = now() where id = $1 and workspace_id = $2", [input.memberId, input.workspaceId]);
    await q.query("update sessions set member_id = null where member_id = $1", [input.memberId]);
    await q.query("insert into audit_events (workspace_id, actor, action, subject) values ($1, $2, 'member.disabled', $3)", [input.workspaceId, input.actorId, input.memberId]);
  });
}
