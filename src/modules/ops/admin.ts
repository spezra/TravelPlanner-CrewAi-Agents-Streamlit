/**
 * Workspace administration: settings (including book portability, which is
 * owner-only and audited), the audit log, failed background work, and
 * retention.
 */
import { EXAMPLE_CONSENT_TABLE } from "@/domain/calls";
import type { Db } from "@/db/client";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import { DEFAULT_RETENTION, retentionCutoff, validateRetention, type BookPortability, type RetentionSettings } from "@/domain/privacy";
import type { BlobStore } from "@/server/storage";
import { log } from "@/server/log";
import { actor, audit, iso, requireRole, str, workspaceRow } from "./common";

const ADMINS = ["owner", "admin"] as const;

export interface WorkspaceSettings {
  name: string;
  dataRegion: "us" | "eu";
  bookPortability: BookPortability;
  retention: RetentionSettings;
  deletionRequestedAt: string | null;
}

export async function getSettings(db: Db, tenant: Tenant): Promise<WorkspaceSettings> {
  return withTenant(db, tenant, async (q) => {
    const r = (await q.query<Record<string, unknown>>("select name, data_region, book_portability, retention, deletion_requested_at from workspaces where id = app_workspace()")).rows[0];
    if (!r) throw new DomainError("not_found", "Workspace not found");
    return {
      name: String(r.name),
      dataRegion: r.data_region as "us" | "eu",
      bookPortability: r.book_portability as BookPortability,
      retention: {
        ...DEFAULT_RETENTION,
        ...((r.retention as Partial<RetentionSettings>) ?? {}),
        // Raw audio is purged by the calls module from call_settings; that row is the one source of truth.
        ...(await audioRetentionDays(q)),
      },
      deletionRequestedAt: iso(r.deletion_requested_at),
    };
  });
}

export async function updateSettings(
  db: Db,
  tenant: Tenant,
  input: { name: string; dataRegion: "us" | "eu"; bookPortability: BookPortability; retention: RetentionSettings },
): Promise<void> {
  const name = input.name.trim();
  if (name.length < 2) throw new DomainError("bad_name", "Workspace name is too short");
  const retention = validateRetention(input.retention);
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    requireRole(me, ADMINS, "change workspace settings");
    const before = await getSettingsTx(q);
    if (input.bookPortability !== before.bookPortability && me.role !== "owner") {
      throw new DomainError("forbidden", "Only an owner can change book portability; it was agreed at signup");
    }
    await q.query("update workspaces set name = $1, data_region = $2, book_portability = $3, retention = $4 where id = app_workspace()", [
      name,
      input.dataRegion,
      input.bookPortability,
      JSON.stringify(retention),
    ]);
    await q.query(
      `insert into call_settings (workspace_id, consent_table, audio_retention_days, updated_by, updated_at)
       values (app_workspace(), $1, $2, app_member(), now())
       on conflict (workspace_id) do update set audio_retention_days = excluded.audio_retention_days, updated_by = excluded.updated_by, updated_at = now()`,
      [JSON.stringify(EXAMPLE_CONSENT_TABLE), retention.rawAudioDays],
    );
    if (input.bookPortability !== before.bookPortability) {
      await audit(q, tenant, "workspace.portability_changed", tenant.workspaceId, { from: before.bookPortability, to: input.bookPortability });
    }
    await audit(q, tenant, "workspace.settings_updated", tenant.workspaceId, {
      name: name !== before.name,
      dataRegion: before.dataRegion !== input.dataRegion ? { from: before.dataRegion, to: input.dataRegion } : undefined,
      retention,
    });
  });
}

async function audioRetentionDays(q: import("@/db/client").Queryable): Promise<{ rawAudioDays?: number }> {
  const { rows } = await q.query<{ d: number }>("select audio_retention_days as d from call_settings where workspace_id = app_workspace()");
  return rows[0] ? { rawAudioDays: Number(rows[0].d) } : {};
}

async function getSettingsTx(q: import("@/db/client").Queryable) {
  const ws = await workspaceRow(q);
  return { name: ws.name, dataRegion: ws.dataRegion, bookPortability: ws.bookPortability };
}

// ---------------------------------------------------------------------------
// Audit log

export interface AuditFilter {
  actor?: string | null;
  action?: string | null;
  from?: string | null; // yyyy-mm-dd, inclusive
  to?: string | null; // yyyy-mm-dd, inclusive
  /** Keyset pagination: rows with id below this. */
  before?: number | null;
  limit?: number;
}

export interface AuditPage {
  rows: { id: number; at: string; actor: string; actorName: string | null; action: string; subject: string; data: unknown }[];
  nextBefore: number | null;
  actions: string[];
}

export async function auditLog(db: Db, tenant: Tenant, f: AuditFilter): Promise<AuditPage> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    requireRole(me, ADMINS, "read the audit log");
    const where: string[] = ["a.workspace_id = app_workspace()"];
    const params: unknown[] = [];
    if (f.actor) where.push(`a.actor = $${params.push(f.actor)}`);
    if (f.action) where.push(`a.action like $${params.push(`${f.action.replace(/[%_\\]/g, "\\$&")}%`)}`);
    if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) where.push(`a.at >= $${params.push(`${f.from}T00:00:00Z`)}::timestamptz`);
    if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) where.push(`a.at < ($${params.push(`${f.to}T00:00:00Z`)}::timestamptz + interval '1 day')`);
    if (f.before) where.push(`a.id < $${params.push(f.before)}`);
    const { rows } = await q.query<Record<string, unknown>>(
      `select a.id, a.at, a.actor, a.action, a.subject, a.data, m.name as actor_name
         from audit_events a left join members m on m.id::text = a.actor
        where ${where.join(" and ")} order by a.id desc limit ${limit + 1}`,
      params,
    );
    const page = rows.slice(0, limit).map((r) => ({
      id: Number(r.id),
      at: iso(r.at)!,
      actor: String(r.actor),
      actorName: str(r.actor_name),
      action: String(r.action),
      subject: String(r.subject),
      data: r.data,
    }));
    const actions = (await q.query<{ action: string }>("select distinct action from audit_events order by action")).rows.map((r) => r.action);
    return { rows: page, nextBefore: rows.length > limit ? page.at(-1)!.id : null, actions };
  });
}

// ---------------------------------------------------------------------------
// Failed background work

export interface FailedJob {
  id: number;
  kind: string;
  status: "failed" | "dead";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

async function assertAdmin(db: Db, tenant: Tenant, what: string): Promise<void> {
  await withTenant(db, tenant, async (q) => requireRole(await actor(q, tenant), ADMINS, what));
}

/** The jobs table is platform-only; this reads the current workspace's rows through the system role. */
export async function failedJobs(db: Db, tenant: Tenant): Promise<FailedJob[]> {
  await assertAdmin(db, tenant, "see failed jobs");
  return withSystem(db, async (q) =>
    (
      await q.query<Record<string, unknown>>(
        `select id, kind, status, attempts, max_attempts, last_error, created_at, finished_at from jobs
          where workspace_id = $1 and status in ('failed', 'dead') order by id desc limit 200`,
        [tenant.workspaceId],
      )
    ).rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind),
      status: r.status as FailedJob["status"],
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      lastError: str(r.last_error),
      createdAt: iso(r.created_at)!,
      finishedAt: iso(r.finished_at),
    })),
  );
}

export async function retryJob(db: Db, tenant: Tenant, jobId: number, now: Date): Promise<void> {
  await assertAdmin(db, tenant, "retry jobs");
  await withSystem(db, async (q) => {
    const { rows } = await q.query<{ kind: string }>(
      `update jobs set status = 'queued', attempts = 0, run_at = $3, locked_at = null, locked_by = null, finished_at = null
        where id = $1 and workspace_id = $2 and status in ('failed', 'dead') returning kind`,
      [jobId, tenant.workspaceId, now.toISOString()],
    );
    if (!rows[0]) throw new DomainError("not_found", "No failed job with that id in this workspace");
    await audit(q, tenant, "job.retried", String(jobId), { kind: rows[0].kind });
  });
}

// ---------------------------------------------------------------------------
// Retention (ops.retention, hourly)

/**
 * Deletes expired exports and purges source text past each workspace's
 * retention limit. Platform work across workspaces, so every statement names
 * its workspace.
 */
export async function runRetention(db: Db, store: BlobStore, now: Date): Promise<{ exportsExpired: number; sourcesPurged: number }> {
  // Expire first; the blob key stays until the blob is actually gone, so a failed delete is retried next run.
  const expired = await withSystem(db, async (q) => {
    const n = await q.query("update workspace_exports set status = 'expired' where status in ('queued', 'ready') and expires_at <= $1 returning id", [now.toISOString()]);
    const blobs = await q.query<{ id: string; blob_key: string }>("select id, blob_key from workspace_exports where blob_key is not null and status in ('expired', 'downloaded', 'failed')");
    return { count: n.rows.length, blobs: blobs.rows };
  });
  let sourcesPurged = 0;
  await withSystem(db, async (q) => {
    const wss = (await q.query<{ id: string; retention: Partial<RetentionSettings> | null }>("select id, retention from workspaces where deleted_at is null")).rows;
    for (const ws of wss) {
      const days = { ...DEFAULT_RETENTION, ...(ws.retention ?? {}) }.sourceTextDays;
      const cutoff = retentionCutoff(days, now).toISOString();
      const a = await q.query("update brief_extractions set source_enc = null where workspace_id = $1 and source_enc is not null and status <> 'queued' and created_at < $2 returning id", [ws.id, cutoff]);
      const b = await q.query("update decisions set conversation_enc = null where workspace_id = $1 and conversation_enc is not null and status <> 'classifying' and decided_at < $2 returning id", [
        ws.id,
        cutoff,
      ]);
      const n = a.rows.length + b.rows.length;
      if (n) await audit(q, { workspaceId: ws.id, memberId: null }, "retention.purged_source_text", ws.id, { count: n, olderThanDays: days }, "system:retention");
      sourcesPurged += n;
    }
  });
  for (const e of expired.blobs) {
    try {
      await store.delete(e.blob_key);
      await withSystem(db, (q) => q.query("update workspace_exports set blob_key = null where id = $1", [e.id]));
    } catch (err) {
      log.warn({ exportId: e.id, err: err instanceof Error ? err.message : String(err) }, "export blob delete failed; will retry");
    }
  }
  return { exportsExpired: expired.count, sourcesPurged };
}
