/**
 * Data-subject requests (access and deletion) and workspace deletion.
 *
 * A deletion erases the subject's personal fields and encrypted content and
 * leaves a tombstone: the rows that carry money and operational history
 * (trips, bookings, ledger entries, commitments) stay, so ledger totals and
 * audit history never change. Requests are recorded and fulfilled by owners
 * and admins; the erasure itself runs as the system role, constrained to the
 * workspace, because a compliance obligation can't depend on which advisor
 * holds a private record.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import { confirmWorkspaceDeletion, ERASED, subjectRef, type SubjectType } from "@/domain/privacy";
import { shredWorkspaceKeys } from "@/server/crypto";
import { enqueueAsTenant, PermanentJobError } from "@/server/jobs/queue";
import type { BlobStore } from "@/server/storage";
import { log } from "@/server/log";
import { actor, audit, iso, requireRole, str } from "./common";
import { queueExport } from "./exports";

export const DELETE_WORKSPACE_KIND = "ops.delete_workspace";

export interface SubjectOption {
  type: SubjectType;
  id: string;
  label: string;
}

/**
 * Subjects a request can name. Owners and admins handle requests for any
 * record in the workspace, including advisors' private clients, so this
 * reads names through the system role, scoped to the workspace.
 */
export async function subjectOptions(db: Db, tenant: Tenant): Promise<SubjectOption[]> {
  await withTenant(db, tenant, async (q) => requireRole(await actor(q, tenant), ["owner", "admin"], "handle data-subject requests"));
  return withSystem(db, async (q) => {
    const ws = tenant.workspaceId;
    const clients = (await q.query<{ id: string; name: string }>("select id, name from clients where workspace_id = $1 and erased_at is null order by name", [ws])).rows;
    const party = (
      await q.query<{ id: string; name: string; client: string }>(
        "select p.id, p.name, c.name as client from client_party_members p join clients c on c.id = p.client_id where p.workspace_id = $1 and p.erased_at is null order by c.name, p.name",
        [ws],
      )
    ).rows;
    const people = (await q.query<{ id: string; name: string }>("select id, name from people where workspace_id = $1 and name <> $2 order by name", [ws, ERASED])).rows;
    return [
      ...clients.map((c) => ({ type: "client" as const, id: c.id, label: c.name })),
      ...party.map((p) => ({ type: "party_member" as const, id: p.id, label: `${p.name} (party of ${p.client})` })),
      ...people.map((p) => ({ type: "person" as const, id: p.id, label: `${p.name} (supplier contact)` })),
    ];
  });
}

async function subjectExists(q: Queryable, workspaceId: string, type: SubjectType, id: string): Promise<boolean> {
  const table = type === "client" ? "clients" : type === "party_member" ? "client_party_members" : "people";
  return (await q.query(`select 1 from ${table} where id = $1 and workspace_id = $2`, [id, workspaceId])).rows.length > 0;
}

export interface DsrRow {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  subjectRef: string;
  kind: "access" | "deletion";
  status: "open" | "in_progress" | "completed" | "rejected";
  receivedAt: string;
  note: string | null;
  exportId: string | null;
  completedAt: string | null;
  completedBy: string | null;
  requestedBy: string;
}

export async function listRequests(db: Db, tenant: Tenant): Promise<DsrRow[]> {
  return withTenant(db, tenant, async (q) => {
    requireRole(await actor(q, tenant), ["owner", "admin"], "handle data-subject requests");
    return (await q.query<Record<string, unknown>>("select * from data_subject_requests order by received_at desc limit 200")).rows.map((r) => ({
      id: String(r.id),
      subjectType: r.subject_type as SubjectType,
      subjectId: String(r.subject_id),
      subjectRef: String(r.subject_ref),
      kind: r.kind as DsrRow["kind"],
      status: r.status as DsrRow["status"],
      receivedAt: iso(r.received_at)!,
      note: str(r.note),
      exportId: str(r.export_id),
      completedAt: iso(r.completed_at),
      completedBy: str(r.completed_by),
      requestedBy: String(r.requested_by),
    }));
  });
}

export async function recordRequest(
  db: Db,
  tenant: Tenant,
  input: { subjectType: SubjectType; subjectId: string; kind: "access" | "deletion"; receivedAt: string; note: string | null },
): Promise<string> {
  await withTenant(db, tenant, async (q) => requireRole(await actor(q, tenant), ["owner", "admin"], "record data-subject requests"));
  if (!(await withSystem(db, (q) => subjectExists(q, tenant.workspaceId, input.subjectType, input.subjectId)))) throw new DomainError("not_found", "No such subject in this workspace");
  if (Number.isNaN(Date.parse(input.receivedAt))) throw new DomainError("bad_date", "When was the request received?");
  return withTenant(db, tenant, async (q) => {
    const id = randomUUID();
    await q.query(
      "insert into data_subject_requests (id, workspace_id, subject_type, subject_id, subject_ref, kind, requested_by, received_at, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, tenant.workspaceId, input.subjectType, input.subjectId, subjectRef(input.subjectType, input.subjectId), input.kind, tenant.memberId, input.receivedAt, input.note?.trim() || null],
    );
    await audit(q, tenant, `dsr.${input.kind}_recorded`, id, { subjectType: input.subjectType, subjectRef: subjectRef(input.subjectType, input.subjectId) });
    return id;
  });
}

async function loadOpenRequest(q: Queryable, id: string) {
  const r = (await q.query<Record<string, unknown>>("select * from data_subject_requests where id = $1 for update", [id])).rows[0];
  if (!r) throw new DomainError("not_found", "Request not found");
  if (r.status === "completed" || r.status === "rejected") throw new DomainError("closed", "This request is already closed");
  return { id: String(r.id), kind: r.kind as "access" | "deletion", type: r.subject_type as SubjectType, subjectId: String(r.subject_id) };
}

/** Fulfil an access request: an export of everything held about the subject, downloadable by this admin. */
export async function fulfilAccess(db: Db, tenant: Tenant, requestId: string, now: Date): Promise<string> {
  return withTenant(db, tenant, async (q) => {
    requireRole(await actor(q, tenant), ["owner", "admin"], "fulfil data-subject requests");
    const req = await loadOpenRequest(q, requestId);
    if (req.kind !== "access") throw new DomainError("wrong_kind", "That is a deletion request");
    const exportId = await queueExport(q, tenant, now, { type: req.type, id: req.subjectId, requestId });
    await q.query("update data_subject_requests set status = 'in_progress', export_id = $2 where id = $1", [requestId, exportId]);
    return exportId;
  });
}

export async function rejectRequest(db: Db, tenant: Tenant, requestId: string, reason: string, now: Date): Promise<void> {
  if (reason.trim().length < 3) throw new DomainError("reason_required", "Record why the request is declined");
  return withTenant(db, tenant, async (q) => {
    requireRole(await actor(q, tenant), ["owner", "admin"], "decline data-subject requests");
    await loadOpenRequest(q, requestId);
    await q.query("update data_subject_requests set status = 'rejected', completed_at = $2, completed_by = $3, note = coalesce(note || E'\\n', '') || $4 where id = $1", [
      requestId,
      now.toISOString(),
      tenant.memberId,
      `Declined: ${reason.trim()}`,
    ]);
    await audit(q, tenant, "dsr.rejected", requestId);
  });
}

/**
 * Erase one subject's personal data. Idempotent. Returns counts of what was
 * erased (no personal content).
 */
async function eraseSubject(q: Queryable, ws: string, type: SubjectType, id: string): Promise<Record<string, number>> {
  const n = async (sql: string, params: unknown[]) => (await q.query(`${sql} returning 1`, params)).rows.length;
  if (type === "client") {
    const party = await n("update client_party_members set name = $3, relation = '', notes_enc = null, erased_at = coalesce(erased_at, now()) where workspace_id = $1 and client_id = $2", [ws, id, ERASED]);
    const statements = await n("delete from brief_statements where workspace_id = $1 and client_id = $2", [ws, id]);
    const suggestions = await n("delete from brief_suggestions where workspace_id = $1 and client_id = $2", [ws, id]);
    const sources = await n("update brief_extractions set source_enc = null, source_label = $3 where workspace_id = $1 and client_id = $2", [ws, id, ERASED]);
    // Decisions stay (they carry the expert's judgment about suppliers); the conversation they came from goes.
    const conversations = await n("update decisions set conversation_enc = null where workspace_id = $1 and client_id = $2 and conversation_enc is not null", [ws, id]);
    const client = await n("update clients set name = $3, email = null, phone = null, notes_enc = null, erased_at = coalesce(erased_at, now()) where workspace_id = $1 and id = $2", [
      ws,
      id,
      ERASED,
    ]);
    // Other areas that hold this client's personal data.
    const trips = "trip_id in (select id from trips where workspace_id = $1 and client_id = $2)";
    const travelers = await n(`update trip_items set booking_request_enc = null where workspace_id = $1 and ${trips} and booking_request_enc is not null`, [ws, id]);
    const acceptances = await n(`update approval_client_acceptances set accepted_name = $3 where workspace_id = $1 and ${trips}`, [ws, id, ERASED]);
    const cards = await n("delete from money_payment_methods where workspace_id = $1 and client_id = $2", [ws, id]);
    const cardSetups = await n("delete from money_card_setups where workspace_id = $1 and client_id = $2", [ws, id]);
    const ties = await n("delete from person_clients where workspace_id = $1 and client_id = $2", [ws, id]);
    return { client, party, statements, suggestions, sources, conversations, travelers, acceptances, cards, cardSetups, ties };
  }
  if (type === "party_member") {
    const party = await n("update client_party_members set name = $3, relation = '', notes_enc = null, erased_at = coalesce(erased_at, now()) where workspace_id = $1 and id = $2", [ws, id, ERASED]);
    return { party };
  }
  // A supplier contact: the person record and the notes about them go; the reciprocity ledger's
  // amounts, dates and kinds stay so totals are unchanged.
  const person = await n("update people set name = $3, roles = '[]', approach = '{}', texture = '[]' where workspace_id = $1 and id = $2", [ws, id, ERASED]);
  const ledger = await n("update ledger_entries set note = '' where workspace_id = $1 and person_id = $2", [ws, id]);
  const commitments = await n("update commitments set promisor = $3 where workspace_id = $1 and promisor_person_id = $2", [ws, id, ERASED]);
  const imported = await n(
    "delete from google_contacts where workspace_id = $1 and lower(email) in (select lower(e) from people, unnest(emails) e where workspace_id = $1 and id = $2)",
    [ws, id],
  );
  const emails = await n("update people set emails = '{}' where workspace_id = $1 and id = $2 and cardinality(emails) > 0", [ws, id]);
  const texture = await n("delete from person_texture where workspace_id = $1 and person_id = $2", [ws, id]);
  const drafts = await n("delete from crm_note_drafts where workspace_id = $1 and person_id = $2", [ws, id]);
  const ties = await n("delete from person_clients where workspace_id = $1 and person_id = $2", [ws, id]);
  return { person, ledger, commitments, imported, emails, texture, drafts, ties };
}

/**
 * Fulfil a deletion request. Also withdraws any undownloaded export about the
 * subject, since it holds the erased data.
 */
export async function fulfilDeletion(db: Db, store: BlobStore, tenant: Tenant, requestId: string, now: Date): Promise<Record<string, number>> {
  const req = await withTenant(db, tenant, async (q) => {
    requireRole(await actor(q, tenant), ["owner", "admin"], "fulfil data-subject requests");
    const r = await loadOpenRequest(q, requestId);
    if (r.kind !== "deletion") throw new DomainError("wrong_kind", "That is an access request");
    return r;
  });
  const { counts, blobKeys } = await withSystem(db, async (q) => {
    const counts = await eraseSubject(q, tenant.workspaceId, req.type, req.subjectId);
    const blobKeys = (
      await q.query<{ blob_key: string }>(
        "update workspace_exports set status = 'expired' where workspace_id = $1 and subject_id = $2 and status in ('queued', 'ready') returning blob_key",
        [tenant.workspaceId, req.subjectId],
      )
    ).rows
      .map((r) => r.blob_key)
      .filter(Boolean);
    await q.query("insert into erasure_tombstones (id, workspace_id, subject_type, subject_id, request_id, erased_at, erased_by, fields) values ($1,$2,$3,$4,$5,$6,$7,$8)", [
      randomUUID(),
      tenant.workspaceId,
      req.type,
      req.subjectId,
      requestId,
      now.toISOString(),
      tenant.memberId,
      JSON.stringify(counts),
    ]);
    await q.query("update data_subject_requests set status = 'completed', completed_at = $2, completed_by = $3 where id = $1 and workspace_id = $4", [
      requestId,
      now.toISOString(),
      tenant.memberId,
      tenant.workspaceId,
    ]);
    await audit(q, tenant, "dsr.subject_erased", requestId, { subjectType: req.type, subjectRef: subjectRef(req.type, req.subjectId), counts });
    return { counts, blobKeys };
  });
  for (const k of blobKeys) {
    try {
      await store.delete(k);
    } catch (err) {
      log.warn({ requestId, err: err instanceof Error ? err.message : String(err) }, "subject export blob delete failed; retention will retry");
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Workspace deletion

/** Owner only, with the workspace name typed back. The irreversible part runs as a job. */
export async function requestWorkspaceDeletion(db: Db, tenant: Tenant, typedName: string, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    requireRole(me, ["owner"], "delete the workspace");
    const ws = (await q.query<{ name: string; deletion_requested_at: string | null }>("select name, deletion_requested_at from workspaces where id = app_workspace()")).rows[0];
    if (!ws) throw new DomainError("not_found", "Workspace not found");
    confirmWorkspaceDeletion(ws.name, typedName);
    await q.query("update workspaces set deletion_requested_at = coalesce(deletion_requested_at, $1) where id = app_workspace()", [now.toISOString()]);
    await audit(q, tenant, "workspace.deletion_requested", tenant.workspaceId);
    // The job acts on the workspace id in its payload, so it runs even after this membership is disabled.
    await enqueueAsTenant(q, { kind: DELETE_WORKSPACE_KIND, payload: { workspaceId: tenant.workspaceId }, dedupeKey: `${DELETE_WORKSPACE_KIND}:${tenant.workspaceId}` });
  });
}

/**
 * Job body for ops.delete_workspace: crypto-shred the keys (every encrypted
 * field and blob becomes unreadable), mark the workspace deleted, disable its
 * members, revoke their sessions for it, cancel its queued work and delete
 * its known blobs. Idempotent.
 */
export async function deleteWorkspace(db: Db, store: BlobStore, workspaceId: string, now: Date): Promise<{ blobsDeleted: number }> {
  const blobKeys = await withSystem(db, async (q) => {
    const ws = (await q.query<{ deletion_requested_at: string | null }>("select deletion_requested_at from workspaces where id = $1", [workspaceId])).rows[0];
    if (!ws) throw new PermanentJobError("Workspace not found");
    if (!ws.deletion_requested_at) throw new PermanentJobError("Workspace deletion was not requested");
    await shredWorkspaceKeys(q, workspaceId);
    const members = (await q.query<{ id: string }>("select id from members where workspace_id = $1", [workspaceId])).rows.map((r) => r.id);
    await q.query("update sessions set revoked_at = coalesce(revoked_at, $2), member_id = null where member_id = any($1::uuid[])", [members, now.toISOString()]);
    await q.query("update members set disabled_at = coalesce(disabled_at, $2) where workspace_id = $1", [workspaceId, now.toISOString()]);
    await q.query("update invitations set revoked_at = coalesce(revoked_at, $2) where workspace_id = $1 and accepted_at is null", [workspaceId, now.toISOString()]);
    await q.query("update jobs set status = 'dead', last_error = 'workspace deleted', finished_at = $2 where workspace_id = $1 and status = 'queued'", [workspaceId, now.toISOString()]);
    const keys = (
      await q.query<{ blob_key: string }>("update workspace_exports set status = 'expired' where workspace_id = $1 and blob_key is not null returning blob_key", [workspaceId])
    ).rows.map((r) => r.blob_key);
    await q.query("update workspaces set deleted_at = coalesce(deleted_at, $2) where id = $1", [workspaceId, now.toISOString()]);
    await audit(q, { workspaceId, memberId: null }, "workspace.deleted", workspaceId, { members: members.length, blobs: keys.length }, "system:deletion");
    return keys;
  });
  let blobsDeleted = 0;
  for (const k of blobKeys) {
    await store.delete(k);
    blobsDeleted++;
  }
  await withSystem(db, (q) => q.query("update workspace_exports set blob_key = null where workspace_id = $1", [workspaceId]));
  return { blobsDeleted };
}
