/**
 * Regression tests for the pre-launch security review. Each test replays an
 * exploit that worked before the fix and asserts it is now refused.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import { useDb } from "./helpers/db";

const getDb = useDb();
let db: Db;
beforeEach(() => {
  db = getDb();
});

const expert = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
const assistant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
const specialist = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };

describe("database-level isolation", () => {
  it("every table has forced row-level security and no tenant policy is unconditional", async () => {
    const loose = await db.query(
      "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' and relname <> 'schema_migrations' and (not relrowsecurity or not relforcerowsecurity)",
    );
    expect(loose.rows).toEqual([]);
    const open = await db.query("select tablename, policyname from pg_policies where (qual = 'true' or with_check = 'true') and not ('app_system' = any(roles))");
    expect(open.rows).toEqual([]);
  });

  it("an assistant can't delegate itself onto a private trip", async () => {
    await expect(
      withTenant(db, assistant, (q) =>
        q.query("insert into trip_delegations (trip_id, workspace_id, member_id, purpose) values ($1, $2, $3, 'backup')", [DEMO.privateTrip, DEMO.workspace, DEMO.assistant]),
      ),
    ).rejects.toThrow(/row-level security/);
    // The trip owner still can.
    await withTenant(db, expert, (q) =>
      q.query("insert into trip_delegations (trip_id, workspace_id, member_id, purpose) values ($1, $2, $3, 'assistant')", [DEMO.privateTrip, DEMO.workspace, DEMO.assistant]),
    );
  });

  it("members can't change their own role, and audit events are append-only", async () => {
    await expect(withTenant(db, assistant, (q) => q.query("update members set role = 'owner' where id = $1", [DEMO.assistant]))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db, assistant, (q) => q.query("delete from audit_events"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db, assistant, (q) => q.query("update audit_events set actor = 'x'"))).rejects.toThrow(/permission denied/);
  });

  it("temp tables can't shadow what security-definer functions read", async () => {
    const r = await withTenant(db, assistant, async (q) => {
      await q.query("create temp table members (id uuid, workspace_id uuid, role text, disabled_at timestamptz, name text)");
      await q.query("insert into pg_temp.members values ($1, $2, 'owner', null, 'x')", [DEMO.assistant, DEMO.workspace]);
      return (await q.query<{ admin: boolean }>("select app_is_admin() as admin")).rows[0]!.admin;
    }).catch((err: Error) => (/permission denied/.test(err.message) ? false : Promise.reject(err)));
    expect(r).toBe(false);
  });
});

describe("cross-workspace collaborations", () => {
  async function setup() {
    const cid = randomUUID();
    const tid = randomUUID();
    await withSystem(db, async (q) => {
      await q.query(
        "insert into network_members (workspace_id, admitted_at, admitted_by) values ($1, now(), 'op'), ($2, now(), 'op') on conflict (workspace_id) do update set admitted_at = now(), removed_at = null",
        [DEMO.workspace, DEMO.otherWorkspace],
      );
      await q.query(
        `insert into collaborations (id, workspace_id, requester_member_id, specialist_workspace_id, specialist_member_id, requester_name, specialist_name, trip_id, contribution, state, brief)
         values ($1, $2, $3, $4, $5, 'R', 'S', $6, 'review_itinerary', 'brief_shared', '{}')`,
        [cid, DEMO.workspace, DEMO.expert, DEMO.otherWorkspace, DEMO.otherExpert, DEMO.trip],
      );
      await q.query(
        `insert into collaboration_shares (id, collaboration_id, workspace_id, kind, label, content, content_fingerprint, shared_by) values ($1, $2, $3, 'client', 'Client', '{"name":"Secret Client"}', 'x', $4)`,
        [randomUUID(), cid, DEMO.workspace, DEMO.expert],
      );
      await q.query(
        `insert into collaboration_terms (id, collaboration_id, workspace_id, version, proposed_by, proposed_by_side, terms, fingerprint, specialist_accepted_at, specialist_accepted_by)
         values ($1, $2, $3, 1, $4, 'specialist', '{"clientAccessExpiresAt":"2099-01-01T00:00:00.000Z"}', 'fp', now(), $4)`,
        [tid, cid, DEMO.otherWorkspace, DEMO.otherExpert],
      );
    });
    return { cid, tid };
  }
  const shares = (cid: string) => withTenant(db, specialist, (q) => q.query("select label from collaboration_shares where collaboration_id = $1", [cid]));

  it("the specialist can't accept on the requester's behalf or open client access itself", async () => {
    const { cid, tid } = await setup();
    expect((await shares(cid)).rows).toEqual([]);
    await expect(
      withTenant(db, specialist, (q) => q.query("update collaboration_terms set requester_accepted_at = now(), requester_accepted_by = $2 where id = $1", [tid, DEMO.expert])),
    ).rejects.toThrow(/only the requester accepts/);
    await expect(
      withTenant(db, specialist, (q) =>
        q.query("update collaborations set state = 'active', agreed_terms_version = 1, client_access_expires_at = '2099-01-01' where id = $1", [cid]),
      ),
    ).rejects.toThrow(/accepted by both sides/);
    expect((await shares(cid)).rows).toEqual([]);
  });

  it("agreed terms are immutable and the log records only your own side", async () => {
    const { cid, tid } = await setup();
    await expect(withTenant(db, specialist, (q) => q.query(`update collaboration_terms set terms = '{"fees":[]}' where id = $1`, [tid]))).rejects.toThrow(/immutable/);
    await expect(
      withTenant(db, specialist, (q) =>
        q.query("insert into collaboration_log (id, collaboration_id, workspace_id, actor_member_id, actor_side, kind, detail) values ($1, $2, $3, $4, 'requester', 'terms_agreed', '{}')", [
          randomUUID(),
          cid,
          DEMO.otherWorkspace,
          DEMO.otherExpert,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
