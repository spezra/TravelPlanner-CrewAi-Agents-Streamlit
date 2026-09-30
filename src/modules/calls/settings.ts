/**
 * Per-workspace call settings: the consent table (illustrative configuration,
 * not legal advice) and how long raw audio is kept. A workspace without a row
 * uses the example table and a 30-day retention.
 */
import type { Db, Queryable } from "@/db/client";
import { audit } from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { EXAMPLE_CONSENT_TABLE, type ConsentTable } from "@/domain/calls";
import { parseConsentTable } from "@/domain/callTasks";
import { DomainError } from "@/domain/common";

export const DEFAULT_AUDIO_RETENTION_DAYS = 30;

export interface CallSettings {
  consentTable: ConsentTable;
  audioRetentionDays: number;
  /** False when the workspace is still on the defaults. */
  customized: boolean;
  updatedAt: string | null;
}

export async function getCallSettings(q: Queryable): Promise<CallSettings> {
  const { rows } = await q.query<{ consent_table: ConsentTable; audio_retention_days: number; updated_at: unknown }>(
    "select consent_table, audio_retention_days, updated_at from call_settings where workspace_id = app_workspace()",
  );
  const r = rows[0];
  if (!r) return { consentTable: EXAMPLE_CONSENT_TABLE, audioRetentionDays: DEFAULT_AUDIO_RETENTION_DAYS, customized: false, updatedAt: null };
  return {
    consentTable: r.consent_table,
    audioRetentionDays: Number(r.audio_retention_days),
    customized: true,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function updateCallSettings(
  db: Db,
  tenant: Tenant,
  input: { rules: { jurisdiction: string; rule: string }[]; audioRetentionDays: number },
): Promise<CallSettings> {
  const table = parseConsentTable(input.rules);
  if (!Number.isInteger(input.audioRetentionDays) || input.audioRetentionDays < 1 || input.audioRetentionDays > 3650) {
    throw new DomainError("bad_retention", "Audio retention must be between 1 and 3650 days");
  }
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<{ role: string }>("select role from members where id = $1 and disabled_at is null", [tenant.memberId]);
    if (!["owner", "admin"].includes(rows[0]?.role ?? "")) throw new DomainError("forbidden", "Only owners and admins can change call settings");
    await q.query(
      `insert into call_settings (workspace_id, consent_table, audio_retention_days, updated_by, updated_at) values ($1, $2, $3, $4, now())
       on conflict (workspace_id) do update set consent_table = excluded.consent_table, audio_retention_days = excluded.audio_retention_days,
         updated_by = excluded.updated_by, updated_at = now()`,
      [tenant.workspaceId, JSON.stringify(table), input.audioRetentionDays, tenant.memberId],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "calls.settings_updated", tenant.workspaceId, {
      jurisdictions: Object.keys(table).length,
      audioRetentionDays: input.audioRetentionDays,
    });
    return getCallSettings(q);
  });
}
