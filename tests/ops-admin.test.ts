import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { auditLog, failedJobs, getSettings, retryJob, runRetention, updateSettings } from "@/modules/ops/admin";
import { createClient, getClientDetail } from "@/modules/ops/clients";
import { downloadExport, listMyExports, requestExport } from "@/modules/ops/exports";
import { fulfilAccess, fulfilDeletion, listRequests, recordRequest, requestWorkspaceDeletion, subjectOptions } from "@/modules/ops/privacy";
import { seedOps } from "@/modules/ops/seed";
import { consumeLoginToken, getSession, requestLoginLink } from "@/server/auth/core";
import { decryptFor, encryptFor } from "@/server/crypto";
import { drain, enqueue } from "@/server/jobs/queue";
import { MemoryMailer } from "@/server/mail";
import { NOW, useDb } from "./helpers/db";
import { assistant, backup, expert, handlersWith, opsDeps, outsider } from "./helpers/ops";

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const getDb = useDb();
let db: Db;
beforeEach(() => {
  db = getDb();
});

const makeAdmin = (memberId: string) => withSystem(db, (q) => q.query("update members set role = 'admin' where id = $1", [memberId]));
type ExportDoc = { format: string; subject: unknown; tables: Record<string, Record<string, unknown>[]> };

async function exportAs(tenant: Tenant, deps = opsDeps()) {
  const id = await requestExport(db, tenant, NOW);
  await drain(db, handlersWith(deps));
  const file = await downloadExport(db, deps.store, tenant, id, NOW);
  return { id, deps, doc: JSON.parse(file.body.toString("utf8")) as ExportDoc, file };
}

describe("workspace export", () => {
  it("contains only what the requester can see, decrypted for them, and downloads once", async () => {
    const privateClient = await createClient(db, expert, { name: "The Okafors", email: null, phone: null, notes: "Son has a nut allergy" });
    await makeAdmin(DEMO.backup);
    const deps = opsDeps();
    const id = await requestExport(db, backup, NOW);
    await drain(db, handlersWith(deps));
    // Stored encrypted.
    const [blob] = [...deps.store.items.values()];
    expect(blob!.toString("utf8")).not.toContain("Whitfields");

    const file = await downloadExport(db, deps.store, backup, id, NOW);
    const doc = JSON.parse(file.body.toString("utf8")) as ExportDoc;
    expect(doc.format).toBe("atp-export/1");
    const ids = (t: string) => (doc.tables[t] ?? []).map((r) => r.id);
    expect(ids("trips")).toContain(DEMO.trip);
    expect(ids("trips")).not.toContain(DEMO.privateTrip); // the expert's private trip
    expect(ids("trips")).not.toContain(DEMO.otherTrip); // another workspace
    expect(ids("clients")).not.toContain(privateClient);
    expect(ids("people")).toEqual([DEMO.concierge]); // Rafael is the expert's private contact
    expect(doc.tables.workspace_keys).toBeUndefined();
    expect(doc.tables.jobs).toBeUndefined();
    expect(doc.tables.expert_learnings).toEqual([]); // the expert's taste model is theirs alone
    // Single download, only by the requester, blob gone afterwards.
    await expect(downloadExport(db, deps.store, backup, id, NOW)).rejects.toThrow(/already downloaded/);
    await expect(downloadExport(db, deps.store, expert, id, NOW)).rejects.toThrow(/not found/);
    expect(deps.store.items.size).toBe(0);
    expect((await listMyExports(db, backup))[0]).toMatchObject({ id, status: "downloaded" });
    expect(await listMyExports(db, expert)).toEqual([]);
  });

  it("decrypts encrypted fields for the requester", async () => {
    const privateClient = await createClient(db, expert, { name: "The Okafors", email: null, phone: null, notes: "Son has a nut allergy" });
    const { doc } = await exportAs(expert);
    const row = doc.tables.clients!.find((r) => r.id === privateClient)!;
    expect(row.notes).toBe("Son has a nut allergy");
    expect(row).not.toHaveProperty("notes_enc");
    expect(doc.tables.trips!.map((r) => r.id)).toContain(DEMO.privateTrip);
  });

  it("only owners and admins export, and another member can't download it", async () => {
    await expect(requestExport(db, assistant, NOW)).rejects.toThrow(/Only owner or admin/);
    const deps = opsDeps();
    const id = await requestExport(db, expert, NOW);
    await drain(db, handlersWith(deps));
    await makeAdmin(DEMO.backup);
    await expect(downloadExport(db, deps.store, backup, id, NOW)).rejects.toThrow(/not found/);
  });

  it("expires after seven days and the file is deleted", async () => {
    const deps = opsDeps();
    const id = await requestExport(db, expert, NOW);
    await drain(db, handlersWith(deps));
    expect(deps.store.items.size).toBe(1);
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    expect((await runRetention(db, deps.store, later)).exportsExpired).toBe(1);
    expect(deps.store.items.size).toBe(0);
    await expect(downloadExport(db, deps.store, expert, id, later)).rejects.toThrow(/expired/);
  });
});

describe("data-subject requests", () => {
  const sums = async () =>
    (
      await withSystem(db, (q) =>
        q.query<{ items: number; nights: number; ledger: number; trips: number }>(
          `select (select coalesce(sum(price_minor), 0) from trip_items where workspace_id = $1)::int as items,
                  (select coalesce(sum(room_nights), 0) from ledger_entries where workspace_id = $1)::int as nights,
                  (select count(*) from ledger_entries where workspace_id = $1)::int as ledger,
                  (select count(*) from trips where workspace_id = $1)::int as trips`,
          [DEMO.workspace],
        ),
      )
    ).rows[0]!;

  it("deletion erases the client's personal data, keeps a tombstone, and never changes ledger totals", async () => {
    await withSystem(db, (q) => seedOps(q, NOW));
    const notes = await withTenant(db, expert, (q) => encryptFor(q, DEMO.workspace, `clients.notes:${DEMO.client}`, "Anniversary on the 14th"));
    await withSystem(db, (q) => q.query("update clients set notes_enc = $2 where id = $1", [DEMO.client, notes]));
    const before = await sums();

    await expect(recordRequest(db, assistant, { subjectType: "client", subjectId: DEMO.client, kind: "deletion", receivedAt: NOW.toISOString(), note: null })).rejects.toThrow(/Only owner or admin/);
    const reqId = await recordRequest(db, expert, { subjectType: "client", subjectId: DEMO.client, kind: "deletion", receivedAt: NOW.toISOString(), note: "Email from Tom" });
    const counts = await fulfilDeletion(db, opsDeps().store, expert, reqId, NOW);
    expect(counts).toMatchObject({ client: 1, party: 2, statements: 4 });

    const c = (await withSystem(db, (q) => q.query<Record<string, unknown>>("select * from clients where id = $1", [DEMO.client]))).rows[0]!;
    expect(c).toMatchObject({ name: "[erased]", email: null, notes_enc: null });
    expect(c.erased_at).not.toBeNull();
    const party = (await withSystem(db, (q) => q.query<{ name: string }>("select name from client_party_members where client_id = $1", [DEMO.client]))).rows;
    expect(party.map((p) => p.name)).toEqual(["[erased]", "[erased]"]);
    expect((await withSystem(db, (q) => q.query("select 1 from brief_statements where client_id = $1", [DEMO.client]))).rows).toEqual([]);
    expect(await sums()).toEqual(before);
    expect((await withSystem(db, (q) => q.query("select * from erasure_tombstones where request_id = $1", [reqId]))).rows).toHaveLength(1);
    expect((await listRequests(db, expert))[0]).toMatchObject({ id: reqId, status: "completed", subjectRef: `client ${DEMO.client.slice(0, 8)}` });
    const audit = (await withSystem(db, (q) => q.query<{ data: string }>("select data::text as data from audit_events where action = 'dsr.subject_erased'"))).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).not.toContain("Whitfield");
    expect(await getClientDetail(db, expert, DEMO.client)).toMatchObject({ erased: true, notes: null });
    // Closed requests stay closed.
    await expect(fulfilDeletion(db, opsDeps().store, expert, reqId, NOW)).rejects.toThrow(/already closed/);
  });

  it("erasing a supplier contact keeps the reciprocity ledger's totals", async () => {
    const before = await sums();
    const reqId = await recordRequest(db, expert, { subjectType: "person", subjectId: DEMO.gm, kind: "deletion", receivedAt: NOW.toISOString(), note: null });
    await fulfilDeletion(db, opsDeps().store, expert, reqId, NOW);
    expect(await sums()).toEqual(before);
    const p = (await withSystem(db, (q) => q.query<Record<string, unknown>>("select name, texture, roles from people where id = $1", [DEMO.gm]))).rows[0]!;
    expect(p).toMatchObject({ name: "[erased]", texture: [], roles: [] });
    const notes = (await withSystem(db, (q) => q.query<{ note: string }>("select note from ledger_entries where person_id = $1", [DEMO.gm]))).rows;
    expect(notes.every((n) => n.note === "")).toBe(true);
    const promisors = (await withSystem(db, (q) => q.query<{ promisor: string }>("select promisor from commitments where promisor_person_id = $1", [DEMO.gm]))).rows;
    expect(promisors.map((c) => c.promisor)).toEqual(["[erased]"]);
  });

  it("admins can act on private records; access requests produce a subject-only export", async () => {
    await makeAdmin(DEMO.backup);
    const options = await subjectOptions(db, backup);
    expect(options.map((o) => o.id)).toContain(DEMO.gm); // Rafael is the expert's private contact
    const reqId = await recordRequest(db, backup, { subjectType: "person", subjectId: DEMO.gm, kind: "access", receivedAt: NOW.toISOString(), note: null });
    const deps = opsDeps();
    const exportId = await fulfilAccess(db, backup, reqId, NOW);
    await drain(db, handlersWith(deps));
    expect((await listRequests(db, backup))[0]).toMatchObject({ status: "completed", exportId });
    const doc = JSON.parse((await downloadExport(db, deps.store, backup, exportId, NOW)).body.toString("utf8")) as ExportDoc;
    expect(doc.subject).toEqual({ type: "person", id: DEMO.gm });
    expect(Object.keys(doc.tables).sort()).toEqual(["commitments", "ledger_entries", "people"]);
    expect(doc.tables.people!.map((r) => r.id)).toEqual([DEMO.gm]);
    expect(doc.tables.ledger_entries).toHaveLength(5);
    await expect(recordRequest(db, backup, { subjectType: "client", subjectId: "00000000-0000-4000-8000-00000000dead", kind: "access", receivedAt: NOW.toISOString(), note: null })).rejects.toThrow(/No such subject/);
  });
});

describe("workspace deletion", () => {
  it("owner-only with typed confirmation; shreds keys, deletes blobs, revokes sessions", async () => {
    const mail = new MemoryMailer();
    await requestLoginLink(db, mail, { email: "diego@example.com", ip: null }, NOW);
    const token = decodeURIComponent(/token=([^&\s]+)/.exec(mail.sent[0]!.text)![1]!);
    const { sessionToken } = await consumeLoginToken(db, token, { ip: null, userAgent: null }, NOW);
    expect((await getSession(db, sessionToken, NOW))!.member?.workspaceId).toBe(DEMO.workspace);

    const sealed = await withTenant(db, expert, (q) => encryptFor(q, DEMO.workspace, "note:1", "secret"));
    const deps = opsDeps();
    await requestExport(db, expert, NOW);
    await drain(db, handlersWith(deps));
    expect(deps.store.items.size).toBe(1);

    await expect(requestWorkspaceDeletion(db, assistant, "Marisol Vega Travel", NOW)).rejects.toThrow(/Only owner/);
    await expect(requestWorkspaceDeletion(db, expert, "marisol vega", NOW)).rejects.toThrow(/Type the workspace name exactly/);
    await requestWorkspaceDeletion(db, expert, "Marisol Vega Travel", NOW);
    await drain(db, handlersWith(deps));
    const job = (await withSystem(db, (q) => q.query<{ status: string; last_error: string | null }>("select status, last_error from jobs where kind = 'ops.delete_workspace'"))).rows;
    expect(job).toEqual([{ status: "done", last_error: null }]);

    expect((await withSystem(db, (q) => q.query("select * from workspace_keys where workspace_id = $1", [DEMO.workspace]))).rows).toEqual([]);
    await expect(withSystem(db, (q) => decryptFor(q, DEMO.workspace, "note:1", sealed))).rejects.toThrow(/not found/);
    expect(deps.store.items.size).toBe(0);
    const ws = (await withSystem(db, (q) => q.query<{ deleted_at: unknown }>("select deleted_at from workspaces where id = $1", [DEMO.workspace]))).rows[0]!;
    expect(ws.deleted_at).not.toBeNull();
    expect(await getSession(db, sessionToken, NOW)).toBeNull();
    // The other workspace is untouched.
    expect((await withSystem(db, (q) => q.query("select 1 from members where workspace_id = $1 and disabled_at is null", [DEMO.otherWorkspace]))).rows).toHaveLength(1);
  });
});

describe("settings, audit log and failed jobs", () => {
  it("portability changes need an owner and are audited", async () => {
    await makeAdmin(DEMO.backup);
    const s = await getSettings(db, backup);
    await expect(updateSettings(db, backup, { ...s, bookPortability: "agency_owns" })).rejects.toThrow(/Only an owner/);
    await updateSettings(db, backup, { ...s, name: "Marisol Vega Travel Co.", retention: { sourceTextDays: 30, rawAudioDays: 14 } });
    await expect(updateSettings(db, assistant, s)).rejects.toThrow(/Only owner or admin/);
    await updateSettings(db, expert, { ...(await getSettings(db, expert)), bookPortability: "shared" });
    expect(await getSettings(db, expert)).toMatchObject({ bookPortability: "shared", retention: { sourceTextDays: 30, rawAudioDays: 14 } });
    const page = await auditLog(db, expert, { action: "workspace.portability" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ actor: DEMO.expert, actorName: "Marisol Vega", data: { from: "advisor_owns", to: "shared" } });
    await expect(updateSettings(db, expert, { ...s, retention: { sourceTextDays: 0, rawAudioDays: 1 } })).rejects.toThrow(/between 1 and 3650/);
  });

  it("filters and pages the audit log, within the workspace", async () => {
    await withSystem(db, async (q) => {
      for (let i = 0; i < 7; i++) {
        await q.query("insert into audit_events (workspace_id, actor, action, subject, at) values ($1, $2, 'test.event', $3, $4)", [DEMO.workspace, DEMO.assistant, `s${i}`, `2026-09-${10 + i}T10:00:00Z`]);
      }
      await q.query("insert into audit_events (workspace_id, actor, action, subject) values ($1, 'x', 'test.event', 'other')", [DEMO.otherWorkspace]);
    });
    const p1 = await auditLog(db, expert, { action: "test.", limit: 3 });
    expect(p1.rows.map((r) => r.subject)).toEqual(["s6", "s5", "s4"]);
    const p2 = await auditLog(db, expert, { action: "test.", limit: 3, before: p1.nextBefore });
    expect(p2.rows.map((r) => r.subject)).toEqual(["s3", "s2", "s1"]);
    const p3 = await auditLog(db, expert, { action: "test.", limit: 3, before: p2.nextBefore });
    expect(p3).toMatchObject({ nextBefore: null });
    expect(p3.rows.map((r) => r.subject)).toEqual(["s0"]);
    expect((await auditLog(db, expert, { actor: DEMO.assistant, from: "2026-09-12", to: "2026-09-13" })).rows.map((r) => r.subject)).toEqual(["s3", "s2"]);
    await expect(auditLog(db, assistant, {})).rejects.toThrow(/Only owner or admin/);
  });

  it("lists and retries only this workspace's failed jobs", async () => {
    await withSystem(db, async (q) => {
      await enqueue(q, { kind: "ops.test_mine", tenant: expert });
      await enqueue(q, { kind: "ops.test_theirs", tenant: outsider });
      await q.query("update jobs set status = 'dead', last_error = 'boom', attempts = 8");
    });
    const mine = await failedJobs(db, expert);
    expect(mine.map((j) => j.kind)).toEqual(["ops.test_mine"]);
    const theirs = (await withSystem(db, (q) => q.query<{ id: number }>("select id from jobs where kind = 'ops.test_theirs'"))).rows[0]!.id;
    await expect(retryJob(db, expert, Number(theirs), NOW)).rejects.toThrow(/No failed job/);
    await retryJob(db, expert, mine[0]!.id, NOW);
    const row = (await withSystem(db, (q) => q.query<{ status: string; attempts: number }>("select status, attempts from jobs where id = $1", [mine[0]!.id]))).rows[0]!;
    expect(row).toEqual({ status: "queued", attempts: 0 });
    await expect(failedJobs(db, assistant)).rejects.toThrow(/Only owner or admin/);
  });

  it("purges source text past the retention limit", async () => {
    await withSystem(db, (q) => seedOps(q, NOW));
    const sealed = await withTenant(db, expert, (q) => encryptFor(q, DEMO.workspace, "decisions.conversation:x", "old conversation"));
    await withSystem(db, (q) => q.query("update decisions set conversation_enc = $1", [sealed]));
    const r = await runRetention(db, opsDeps().store, new Date(NOW.getTime() + 91 * 86_400_000));
    expect(r.sourcesPurged).toBe(3);
    expect((await withSystem(db, (q) => q.query("select 1 from decisions where conversation_enc is not null"))).rows).toEqual([]);
  });
});

describe("row-level security for ops tables", () => {
  const TABLES = [
    "client_party_members",
    "brief_extractions",
    "brief_suggestions",
    "expert_learnings",
    "supplier_conditions",
    "trip_notes",
    "draft_outcomes",
    "escalations",
    "escalation_notifications",
    "workspace_exports",
    "data_subject_requests",
    "erasure_tombstones",
  ];

  async function populate() {
    await withSystem(db, (q) => seedOps(q, NOW));
    await withSystem(db, async (q) => {
      await q.query(
        "insert into brief_extractions (id, workspace_id, client_id, trip_id, source_label, status, requested_by) values ('00000000-0000-4000-8000-000000000801', $1, $2, $3, 'call', 'done', $4)",
        [DEMO.workspace, DEMO.client, DEMO.trip, DEMO.expert],
      );
      await q.query(
        "insert into brief_suggestions (id, workspace_id, extraction_id, client_id, trip_id, dimension, text, evidence) values ('00000000-0000-4000-8000-000000000802', $1, '00000000-0000-4000-8000-000000000801', $2, $3, 'desired_experience', 'x', 'agent_inferred')",
        [DEMO.workspace, DEMO.client, DEMO.trip],
      );
      await q.query("insert into trip_notes (id, workspace_id, trip_id, text) values ('00000000-0000-4000-8000-000000000803', $1, $2, 'note')", [DEMO.workspace, DEMO.trip]);
      await q.query(
        "insert into escalations (id, workspace_id, trip_id, source_key, kind, title, raised_at, raised_by) values ('00000000-0000-4000-8000-000000000804', $1, $2, 'k', 'unhappy_client', 't', now(), 'x')",
        [DEMO.workspace, DEMO.trip],
      );
      await q.query("insert into escalation_notifications (escalation_id, workspace_id, member_id, step, role) values ('00000000-0000-4000-8000-000000000804', $1, $2, 0, 'primary')", [
        DEMO.workspace,
        DEMO.expert,
      ]);
      await q.query("insert into workspace_exports (id, workspace_id, requested_by, status, expires_at) values ('00000000-0000-4000-8000-000000000805', $1, $2, 'queued', now())", [
        DEMO.workspace,
        DEMO.expert,
      ]);
      await q.query(
        "insert into data_subject_requests (id, workspace_id, subject_type, subject_id, subject_ref, kind, requested_by, received_at) values ('00000000-0000-4000-8000-000000000806', $1, 'client', $2, 'c', 'access', $3, now())",
        [DEMO.workspace, DEMO.client, DEMO.expert],
      );
      await q.query("insert into erasure_tombstones (id, workspace_id, subject_type, subject_id, erased_at) values ('00000000-0000-4000-8000-000000000807', $1, 'client', $2, now())", [
        DEMO.workspace,
        DEMO.client,
      ]);
    });
  }
  const count = async (tenant: Tenant, t: string) => (await withTenant(db, tenant, (q) => q.query(`select * from ${t}`))).rows.length;

  it("another workspace sees none of it and can't write into it", async () => {
    await populate();
    for (const t of TABLES) {
      expect(await count(expert, t), t).toBeGreaterThan(0);
      expect(await count(outsider, t), t).toBe(0);
    }
    await expect(
      withTenant(db, outsider, (q) => q.query("insert into trip_notes (id, workspace_id, trip_id, text) values ('00000000-0000-4000-8000-000000000899', $1, $2, 'x')", [DEMO.workspace, DEMO.trip])),
    ).rejects.toThrow(/row-level security/);
  });

  it("private stores stay with their owner; compliance records with owners and admins", async () => {
    await populate();
    // The taste model, endorsement record, exports and private supplier conditions are the expert's alone.
    for (const t of ["expert_learnings", "draft_outcomes", "workspace_exports", "supplier_conditions"]) expect(await count(assistant, t), t).toBe(0);
    for (const t of ["data_subject_requests", "erasure_tombstones"]) expect(await count(assistant, t), t).toBe(0);
    // Trip- and client-bound rows follow the trip and client.
    expect(await count(assistant, "trip_notes")).toBe(1);
    expect(await count(assistant, "client_party_members")).toBe(2);
    await withSystem(db, (q) => q.query("update clients set scope = 'private' where id = $1", [DEMO.client]));
    expect(await count(assistant, "client_party_members")).toBe(0);
    expect(await count(assistant, "brief_suggestions")).toBe(0);
    // Nobody can write a taste-model entry for someone else.
    await expect(
      withTenant(db, assistant, (q) =>
        q.query("insert into expert_learnings (id, workspace_id, expert_id, kind, subject, summary, status, observed_at) values ('00000000-0000-4000-8000-000000000898', $1, $2, 'reject', 's', 's', 'endorsed', now())", [
          DEMO.workspace,
          DEMO.expert,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
