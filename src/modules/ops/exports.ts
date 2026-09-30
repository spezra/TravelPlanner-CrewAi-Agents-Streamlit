/**
 * Workspace data export. A JSON file of everything the requester can see,
 * with encrypted fields decrypted for them, built by a job running as the
 * requester (so row-level security decides the contents), then encrypted with
 * the workspace key, stored as a blob, downloadable once by the requester and
 * deleted after seven days. Access requests for one data subject use the same
 * path with a subject filter.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import { canDownload, exportExpiry, type ExportStatus, type SubjectType } from "@/domain/privacy";
import { decryptBytes, decryptFor, encryptFor } from "@/server/crypto";
import { enqueueAsTenant, PermanentJobError } from "@/server/jobs/queue";
import type { BlobStore } from "@/server/storage";
import { actor, audit, encCtx, iso, requireRole, str, type OpsDeps } from "./common";

export const EXPORT_KIND = "ops.export_workspace";
export const EXPORT_FORMAT = "atp-export/1";

/** Platform tables and secrets that never go into an export. */
const EXCLUDED_TABLES = new Set(["workspace_keys", "jobs", "rate_limits", "login_tokens", "sessions", "invitations", "workspace_exports", "schema_migrations", "google_oauth_states"]);
/** Credentials are never exported, even decrypted for their owner. */
const EXCLUDED_COLUMNS = new Set(["token_hash", "wrapped_key", "access_token_sealed", "refresh_token_sealed", "verifier_sealed"]);

/** Encrypted columns: the `_enc` convention, plus the `_sealed` / `sealed` names some features use. */
const isEncrypted = (column: string) => column.endsWith("_enc") || column.endsWith("_sealed") || column === "sealed";
const plainName = (column: string) => (column === "sealed" ? "content" : column.replace(/_(enc|sealed)$/, ""));

/**
 * How to decrypt a column. The default convention is the context
 * "<table>.<column without _enc>:<row id>"; features that encrypt differently
 * register their context here.
 */
type ContextFn = (row: Record<string, unknown>) => string;
const DECRYPTORS = new Map<string, ContextFn>();
export function registerExportDecryptor(table: string, column: string, context: ContextFn): void {
  DECRYPTORS.set(`${table}.${column}`, context);
}

// Features whose encryption context differs from the default convention.
registerExportDecryptor("trip_items", "booking_request_enc", (r) => `trip_item:${String(r.id)}:travelers`);
registerExportDecryptor("trip_items", "internal_notes_enc", (r) => `trip_item:${String(r.id)}:notes`);
registerExportDecryptor("call_transcripts", "body_enc", (r) => `call_transcript:${String(r.id)}`);
registerExportDecryptor("call_notes", "body_enc", (r) => `call_note:${String(r.id)}`);
registerExportDecryptor("call_recaps", "body_enc", (r) => `call_recap:${String(r.id)}`);
registerExportDecryptor("call_extractions", "unclear_enc", (r) => `call_extraction:${String(r.source_ref)}`);
registerExportDecryptor("money_recipients", "settlement_details_enc", (r) => `money-recipient:${String(r.id)}`);
registerExportDecryptor("person_texture", "sealed", (r) => `person_texture:${String(r.person_id)}`);
registerExportDecryptor("crm_note_drafts", "body_sealed", (r) => `crm_note_draft:${String(r.id)}`);
registerExportDecryptor("inbound_messages", "subject_sealed", (r) => `inbound_subject:${String(r.id)}`);
registerExportDecryptor("inbound_messages", "body_sealed", (r) => `inbound_body:${String(r.id)}`);

function contextFor(table: string, column: string, row: Record<string, unknown>): string | null {
  const custom = DECRYPTORS.get(`${table}.${column}`);
  if (custom) return custom(row);
  if (row.id == null) return null;
  return encCtx(table, plainName(column), String(row.id));
}

const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Decrypt every *_enc column of a row in place (renamed without the suffix). */
async function decryptRow(q: Queryable, workspaceId: string, table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (EXCLUDED_COLUMNS.has(k)) continue;
    if (!isEncrypted(k)) {
      out[k] = v instanceof Date ? v.toISOString() : v;
      continue;
    }
    const name = plainName(k);
    if (v == null) {
      out[name] = null;
      continue;
    }
    const ctx = contextFor(table, k, row);
    try {
      out[name] = ctx ? await decryptFor(q, workspaceId, ctx, String(v)) : { encrypted: true, readable: false };
    } catch {
      // Never fail the whole export on one field; say plainly what couldn't be read.
      out[name] = { encrypted: true, readable: false };
    }
  }
  return out;
}

/** Tables with a workspace_id that the current role may read: other features' tables are included automatically. */
async function exportableTables(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ table_name: string }>(
    `select c.table_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'workspace_id' order by c.table_name`,
  );
  const out: string[] = [];
  for (const r of rows) {
    if (EXCLUDED_TABLES.has(r.table_name)) continue;
    const can = await q.query<{ ok: boolean }>("select has_table_privilege(current_user, $1, 'select') as ok", [`public.${r.table_name}`]);
    if (can.rows[0]?.ok) out.push(r.table_name);
  }
  return out;
}

const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** Everything the current (RLS-bound) role can see in the workspace. */
export async function buildWorkspaceExport(q: Queryable, workspaceId: string): Promise<Record<string, Record<string, unknown>[]>> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const ws = (await q.query<Record<string, unknown>>("select id, name, book_portability, data_region, retention, created_at from workspaces where id = $1", [workspaceId])).rows;
  tables.workspaces = ws.map((r) => ({ ...r, created_at: iso(r.created_at) }));
  for (const t of await exportableTables(q)) {
    const { rows } = await q.query<Record<string, unknown>>(`select * from ${ident(t)} where workspace_id = $1`, [workspaceId]);
    tables[t] = await Promise.all(rows.map((r) => decryptRow(q, workspaceId, t, r)));
  }
  return tables;
}

/** Everything held about one data subject. Runs as the system role, so every query names the workspace. */
export async function buildSubjectExport(q: Queryable, workspaceId: string, type: SubjectType, id: string): Promise<Record<string, Record<string, unknown>[]>> {
  const sel = async (table: string, where: string, params: unknown[]) => {
    const { rows } = await q.query<Record<string, unknown>>(`select * from ${ident(table)} where workspace_id = $1 and ${where}`, [workspaceId, ...params]);
    return Promise.all(rows.map((r) => decryptRow(q, workspaceId, table, r)));
  };
  if (type === "client") {
    return {
      clients: await sel("clients", "id = $2", [id]),
      client_party_members: await sel("client_party_members", "client_id = $2", [id]),
      brief_statements: await sel("brief_statements", "client_id = $2", [id]),
      trips: await sel("trips", "client_id = $2", [id]),
      trip_items: await sel("trip_items", "trip_id in (select id from trips where client_id = $2)", [id]),
      decisions: await sel("decisions", "client_id = $2", [id]),
    };
  }
  if (type === "party_member") {
    return { client_party_members: await sel("client_party_members", "id = $2", [id]) };
  }
  return {
    people: await sel("people", "id = $2", [id]),
    ledger_entries: await sel("ledger_entries", "person_id = $2", [id]),
    commitments: await sel("commitments", "promisor_person_id = $2", [id]),
  };
}

export interface ExportRow {
  id: string;
  status: ExportStatus;
  subjectType: SubjectType | null;
  createdAt: string;
  readyAt: string | null;
  downloadedAt: string | null;
  expiresAt: string;
  bytes: number | null;
  error: string | null;
}

export async function listMyExports(db: Db, tenant: Tenant): Promise<ExportRow[]> {
  return withTenant(db, tenant, async (q) =>
    (await q.query<Record<string, unknown>>("select * from workspace_exports where requested_by = app_member() order by created_at desc limit 20")).rows.map((r) => ({
      id: String(r.id),
      status: r.status as ExportStatus,
      subjectType: (r.subject_type as SubjectType | null) ?? null,
      createdAt: iso(r.created_at)!,
      readyAt: iso(r.ready_at),
      downloadedAt: iso(r.downloaded_at),
      expiresAt: iso(r.expires_at)!,
      bytes: r.bytes == null ? null : Number(r.bytes),
      error: str(r.error),
    })),
  );
}

/** Queue an export (owners and admins). Inside the caller's transaction when `q` is given. */
export async function queueExport(q: Queryable, tenant: Tenant, now: Date, subject: { type: SubjectType; id: string; requestId: string } | null = null): Promise<string> {
  const me = await actor(q, tenant);
  requireRole(me, ["owner", "admin"], "export workspace data");
  const id = randomUUID();
  await q.query(
    "insert into workspace_exports (id, workspace_id, requested_by, subject_type, subject_id, request_id, status, expires_at, created_at) values ($1,$2,$3,$4,$5,$6,'queued',$7,$8)",
    [id, tenant.workspaceId, tenant.memberId, subject?.type ?? null, subject?.id ?? null, subject?.requestId ?? null, exportExpiry(now).toISOString(), now.toISOString()],
  );
  await enqueueAsTenant(q, { kind: EXPORT_KIND, payload: { exportId: id }, dedupeKey: `${EXPORT_KIND}:${id}` });
  await audit(q, tenant, "export.requested", id, { subject: subject ? { type: subject.type, requestId: subject.requestId } : null });
  return id;
}

export async function requestExport(db: Db, tenant: Tenant, now: Date): Promise<string> {
  return withTenant(db, tenant, (q) => queueExport(q, tenant, now));
}

const blobKey = (workspaceId: string, id: string) => `exports/${workspaceId}/${id}.json.enc`;

/** Job body for ops.export_workspace. Runs as the requester; idempotent (re-puts the same blob key). */
export async function runExport(db: Db, deps: OpsDeps, tenant: Tenant | null, exportId: string): Promise<void> {
  if (!tenant) throw new PermanentJobError("Exports run as the member who requested them");
  const exp = await withTenant(db, tenant, async (q) => {
    const r = (await q.query<Record<string, unknown>>("select * from workspace_exports where id = $1", [exportId])).rows[0];
    if (!r || r.status !== "queued") return null;
    const me = await actor(q, tenant);
    requireRole(me, ["owner", "admin"], "export workspace data");
    return { subjectType: (r.subject_type as SubjectType | null) ?? null, subjectId: str(r.subject_id), requestId: str(r.request_id) };
  });
  if (!exp) return;
  const now = deps.now();
  const tables =
    exp.subjectType && exp.subjectId
      ? await withSystem(db, (q) => buildSubjectExport(q, tenant.workspaceId, exp.subjectType!, exp.subjectId!))
      : await withTenant(db, tenant, (q) => buildWorkspaceExport(q, tenant.workspaceId));
  const doc = {
    format: EXPORT_FORMAT,
    workspaceId: tenant.workspaceId,
    requestedBy: tenant.memberId,
    generatedAt: now.toISOString(),
    subject: exp.subjectType ? { type: exp.subjectType, id: exp.subjectId } : null,
    note: exp.subjectType
      ? "Everything this workspace holds about one data subject."
      : "Everything in this workspace that the requesting member can see. Encrypted fields are decrypted; fields marked readable:false could not be.",
    tables,
  };
  const key = blobKey(tenant.workspaceId, exportId);
  const sealed = await withTenant(db, tenant, (q) => encryptFor(q, tenant.workspaceId, encCtx("workspace_exports", "file", exportId), Buffer.from(JSON.stringify(doc, jsonSafe), "utf8")));
  const bytes = Buffer.from(sealed, "utf8");
  await deps.blobs().put(key, bytes, "application/octet-stream");
  const done = await withTenant(db, tenant, async (q) => {
    const { rows } = await q.query("update workspace_exports set status = 'ready', blob_key = $2, bytes = $3, ready_at = $4 where id = $1 and status = 'queued' returning id", [
      exportId,
      key,
      bytes.length,
      now.toISOString(),
    ]);
    if (!rows.length) return false;
    if (exp.requestId) {
      await q.query("update data_subject_requests set status = 'completed', completed_at = $2, completed_by = $3, export_id = $4 where id = $1 and status in ('open', 'in_progress')", [
        exp.requestId,
        now.toISOString(),
        tenant.memberId,
        exportId,
      ]);
    }
    await audit(q, tenant, "export.ready", exportId, { tables: Object.keys(tables).length, bytes: bytes.length }, "system:export");
    return true;
  });
  // Lost a race with expiry or deletion: don't leave the file behind.
  if (!done) await deps.blobs().delete(key);
}

/**
 * Download once. The export is marked downloaded in the same transaction that
 * reads and decrypts it, so two concurrent requests can't both get it, and a
 * failed read leaves it downloadable. The blob is deleted afterwards.
 */
export async function downloadExport(db: Db, store: BlobStore, tenant: Tenant, exportId: string, now: Date): Promise<{ filename: string; body: Buffer }> {
  const out = await withTenant(db, tenant, async (q) => {
    const r = (await q.query<Record<string, unknown>>("select * from workspace_exports where id = $1 for update", [exportId])).rows[0];
    // RLS hides other members' exports entirely.
    if (!r) throw new DomainError("not_found", "Export not found");
    const verdict = canDownload({ status: r.status as ExportStatus, requestedBy: String(r.requested_by), expiresAt: iso(r.expires_at)! }, tenant.memberId, now);
    if (!verdict.ok) throw new DomainError("unavailable", verdict.reason);
    const key = String(r.blob_key);
    const sealed = (await store.get(key)).toString("utf8");
    const body = await decryptBytes(q, tenant.workspaceId, encCtx("workspace_exports", "file", exportId), sealed);
    await q.query("update workspace_exports set status = 'downloaded', downloaded_at = $2 where id = $1", [exportId, now.toISOString()]);
    await audit(q, tenant, "export.downloaded", exportId);
    return { key, body, subject: r.subject_type ? String(r.subject_type) : null };
  });
  try {
    await store.delete(out.key);
    await withTenant(db, tenant, (q) => q.query("update workspace_exports set blob_key = null where id = $1", [exportId]));
  } catch {
    // The retention job deletes blobs of downloaded exports it finds still present.
  }
  const stamp = now.toISOString().slice(0, 10);
  return { filename: `${out.subject ? `subject-${out.subject}` : "workspace"}-export-${stamp}.json`, body: out.body };
}
