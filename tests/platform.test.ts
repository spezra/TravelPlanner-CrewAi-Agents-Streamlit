import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import {
  acceptInvitation,
  consumeLoginToken,
  createWorkspace,
  disableMember,
  getSession,
  inviteMember,
  requestLoginLink,
  revokeSession,
  switchMembership,
} from "@/server/auth/core";
import { decryptFor, encryptFor, shredWorkspaceKeys } from "@/server/crypto";
import { MemoryMailer } from "@/server/mail";
import { drain, enqueue, enqueueAsTenant, PermanentJobError, releaseStale, type JobHandler } from "@/server/jobs/queue";
import { NOW, useDb } from "./helpers/db";

const getDb = useDb();
let db: Db;
let mail: MemoryMailer;
beforeEach(() => {
  db = getDb();
  mail = new MemoryMailer();
});

const tokenFrom = (text: string, param = "token") => decodeURIComponent(new RegExp(`[?&]${param}=([^&\\s]+)`).exec(text)![1]!);
const meta = { ip: "203.0.113.9", userAgent: "vitest" };

async function signIn(email: string) {
  await requestLoginLink(db, mail, { email, ip: meta.ip }, NOW);
  const { sessionToken } = await consumeLoginToken(db, tokenFrom(mail.sent.at(-1)!.text), meta, NOW);
  return sessionToken;
}

describe("sign-in", () => {
  it("links a seeded member on first sign-in and resolves the session", async () => {
    const token = await signIn("Marisol@Example.com ");
    const s = await getSession(db, token, NOW);
    expect(s).toMatchObject({ email: "marisol@example.com", member: { id: DEMO.expert, workspaceId: DEMO.workspace, role: "owner" } });
  });

  it("sign-in links are single-use and expire", async () => {
    await requestLoginLink(db, mail, { email: "a@example.com", ip: null }, NOW);
    const t = tokenFrom(mail.sent[0]!.text);
    await consumeLoginToken(db, t, meta, NOW);
    await expect(consumeLoginToken(db, t, meta, NOW)).rejects.toThrow(/invalid or has expired/);
    await requestLoginLink(db, mail, { email: "b@example.com", ip: null }, NOW);
    const later = new Date(NOW.getTime() + 16 * 60_000);
    await expect(consumeLoginToken(db, tokenFrom(mail.sent[1]!.text), meta, later)).rejects.toThrow(/expired/);
  });

  it("only stores token hashes", async () => {
    await requestLoginLink(db, mail, { email: "a@example.com", ip: null }, NOW);
    const t = tokenFrom(mail.sent[0]!.text);
    const { rows } = await withSystem(db, (q) => q.query<{ token_hash: string }>("select token_hash from login_tokens"));
    expect(rows[0]!.token_hash).not.toContain(t);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rate-limits per email", async () => {
    for (let i = 0; i < 5; i++) await requestLoginLink(db, mail, { email: "x@example.com", ip: null }, NOW);
    await expect(requestLoginLink(db, mail, { email: "x@example.com", ip: null }, NOW)).rejects.toThrow(/Too many/);
  });

  it("only redirects to local paths", async () => {
    await requestLoginLink(db, mail, { email: "a@example.com", ip: null, next: "//evil.example" }, NOW);
    expect(tokenFrom(mail.sent[0]!.text, "next")).toBe("/");
  });

  it("revoked sessions stop resolving", async () => {
    const token = await signIn("marisol@example.com");
    await revokeSession(db, token);
    expect(await getSession(db, token, NOW)).toBeNull();
  });
});

describe("workspaces and invitations", () => {
  it("a new user creates a workspace and becomes its owner", async () => {
    const token = await signIn("new.expert@example.com");
    const s = (await getSession(db, token, NOW))!;
    expect(s.member).toBeNull();
    await createWorkspace(db, { userId: s.userId, sessionId: s.sessionId, workspaceName: "Kyoto Quiet", memberName: "Aiko", bookPortability: "advisor_owns", timeZone: "Asia/Tokyo" });
    expect((await getSession(db, token, NOW))!.member).toMatchObject({ role: "owner", workspaceName: "Kyoto Quiet" });
  });

  it("invitations bind to the invited email and role", async () => {
    const inviteToken = await inviteMember(db, mail, { workspaceId: DEMO.workspace, invitedBy: DEMO.expert, email: "ops@example.com", role: "assistant" }, NOW);
    expect(mail.sent.at(-1)!.subject).toMatch(/invited you/);

    const wrong = await signIn("someone.else@example.com");
    const ws = (await getSession(db, wrong, NOW))!;
    await expect(acceptInvitation(db, { token: inviteToken, userId: ws.userId, sessionId: ws.sessionId, name: "X", timeZone: "UTC" }, NOW)).rejects.toThrow(/for ops@example.com/);

    const right = await signIn("ops@example.com");
    const rs = (await getSession(db, right, NOW))!;
    await acceptInvitation(db, { token: inviteToken, userId: rs.userId, sessionId: rs.sessionId, name: "Ops", timeZone: "UTC" }, NOW);
    expect((await getSession(db, right, NOW))!.member).toMatchObject({ role: "assistant", workspaceId: DEMO.workspace });
    await expect(acceptInvitation(db, { token: inviteToken, userId: rs.userId, sessionId: rs.sessionId, name: "Ops", timeZone: "UTC" }, NOW)).rejects.toThrow();
  });

  it("assistants can't invite; members can't switch into workspaces they don't belong to", async () => {
    await expect(inviteMember(db, mail, { workspaceId: DEMO.workspace, invitedBy: DEMO.assistant, email: "z@example.com", role: "advisor" }, NOW)).rejects.toThrow(/owners and admins/);
    const token = await signIn("diego@example.com");
    const s = (await getSession(db, token, NOW))!;
    await expect(switchMembership(db, s.sessionId, s.userId, DEMO.otherExpert)).rejects.toThrow(/Not a member/);
  });

  it("disabling a member cuts off their workspace access immediately", async () => {
    const token = await signIn("diego@example.com");
    await disableMember(db, { workspaceId: DEMO.workspace, actorId: DEMO.expert, memberId: DEMO.assistant });
    expect((await getSession(db, token, NOW))!.member).toBeNull();
  });
});

describe("encryption", () => {
  it("round-trips per workspace, bound to context, and is shreddable", async () => {
    const sealed = await withTenant(db, { workspaceId: DEMO.workspace, memberId: DEMO.expert }, (q) => encryptFor(q, DEMO.workspace, "note:1", "Rafael: dry humor"));
    expect(sealed).not.toContain("Rafael");
    const plain = await withTenant(db, { workspaceId: DEMO.workspace, memberId: DEMO.expert }, (q) => decryptFor(q, DEMO.workspace, "note:1", sealed));
    expect(plain).toBe("Rafael: dry humor");
    await expect(withTenant(db, { workspaceId: DEMO.workspace, memberId: DEMO.expert }, (q) => decryptFor(q, DEMO.workspace, "note:2", sealed))).rejects.toThrow();
    // Another workspace can't read this workspace's keys.
    await expect(withTenant(db, { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert }, (q) => decryptFor(q, DEMO.workspace, "note:1", sealed))).rejects.toThrow();
    await withSystem(db, (q) => shredWorkspaceKeys(q, DEMO.workspace));
    await expect(withSystem(db, (q) => decryptFor(q, DEMO.workspace, "note:1", sealed))).rejects.toThrow(/not found/);
  });
});

describe("job queue", () => {
  it("runs, retries with backoff, dead-letters, and dedupes", async () => {
    const seen: string[] = [];
    let flaky = 0;
    const handlers: Record<string, JobHandler> = {
      ok: async ({ job, tenant }) => {
        seen.push(`ok:${String(job.payload.n)}:${tenant?.memberId ?? "system"}`);
      },
      flaky: async () => {
        if (flaky++ === 0) throw new Error("transient");
      },
      broken: async () => {
        throw new PermanentJobError("bad input");
      },
    };
    await withSystem(db, async (q) => {
      await enqueue(q, { kind: "ok", payload: { n: 1 }, dedupeKey: "once" });
      await enqueue(q, { kind: "ok", payload: { n: 2 }, dedupeKey: "once" });
      await enqueue(q, { kind: "flaky" });
      await enqueue(q, { kind: "broken" });
    });
    await withTenant(db, { workspaceId: DEMO.workspace, memberId: DEMO.expert }, (q) => enqueueAsTenant(q, { kind: "ok", payload: { n: 3 } }));
    await drain(db, handlers);
    expect(seen.sort()).toEqual(["ok:1:system", `ok:3:${DEMO.expert}`]);
    const statuses = await withSystem(db, (q) => q.query<{ kind: string; status: string }>("select kind, status from jobs order by id"));
    expect(statuses.rows.map((r) => `${r.kind}:${r.status}`)).toEqual(["ok:done", "flaky:queued", "broken:dead", "ok:done"]);
    // The retry is scheduled in the future, not run immediately.
    await withSystem(db, (q) => q.query("update jobs set run_at = now() where kind = 'flaky'"));
    await drain(db, handlers);
    const flakyRow = await withSystem(db, (q) => q.query<{ status: string; attempts: number }>("select status, attempts from jobs where kind = 'flaky'"));
    expect(flakyRow.rows[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  it("tenants can't read the job table directly", async () => {
    await expect(withTenant(db, { workspaceId: DEMO.workspace, memberId: DEMO.expert }, (q) => q.query("select * from jobs"))).rejects.toThrow(/permission denied/);
  });

  it("returns abandoned jobs to the queue", async () => {
    await withSystem(db, (q) => q.query("insert into jobs (kind, status, locked_at) values ('ok', 'running', now() - interval '1 hour')"));
    expect(await releaseStale(db, 900)).toBe(1);
  });
});
