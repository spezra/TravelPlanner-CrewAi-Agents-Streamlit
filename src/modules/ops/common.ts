/**
 * Shared plumbing for the ops module: who the current member is, row mapping
 * helpers, injectable dependencies for jobs, and the encryption contexts used
 * for this module's encrypted columns.
 */
import type { StructuredLLM } from "@/agents/llm";
import type { Queryable } from "@/db/client";
import type { Tenant } from "@/db/tenant";
import type { BriefStatement } from "@/domain/brief";
import { DomainError, type Role } from "@/domain/common";
import type { BookPortability } from "@/domain/privacy";
import type { Mailer } from "@/server/mail";
import type { BlobStore } from "@/server/storage";

export const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
export const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
export const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Encryption context for a column of a row: binds ciphertext to where it is stored. */
export const encCtx = (table: string, column: string, id: string) => `${table}.${column}:${id}`;

export interface Actor {
  id: string;
  role: Role;
  name: string;
  email: string;
}

/** The acting member, read under RLS. Disabled members act as nobody. */
export async function actor(q: Queryable, tenant: Tenant): Promise<Actor> {
  const { rows } = await q.query<{ id: string; role: Role; name: string; email: string }>(
    "select id, role, name, email from members where id = $1 and disabled_at is null",
    [tenant.memberId],
  );
  if (!rows[0]) throw new DomainError("forbidden", "Your membership is no longer active");
  return rows[0];
}

export function requireRole(a: Actor, roles: readonly Role[], what: string): void {
  if (!roles.includes(a.role)) throw new DomainError("forbidden", `Only ${roles.join(" or ")} members can ${what}`);
}

export async function workspaceRow(q: Queryable): Promise<{ id: string; name: string; bookPortability: BookPortability; dataRegion: string; deletedAt: string | null }> {
  const { rows } = await q.query<Record<string, unknown>>("select id, name, book_portability, data_region, deleted_at from workspaces where id = app_workspace()");
  const r = rows[0];
  if (!r) throw new DomainError("not_found", "Workspace not found");
  return { id: String(r.id), name: String(r.name), bookPortability: r.book_portability as BookPortability, dataRegion: String(r.data_region), deletedAt: iso(r.deleted_at) };
}

export async function audit(q: Queryable, tenant: Tenant | { workspaceId: string; memberId: string | null }, action: string, subject: string, data: unknown = {}, actorLabel?: string): Promise<void> {
  await q.query("insert into audit_events (workspace_id, actor, action, subject, data) values ($1, $2, $3, $4, $5)", [
    tenant.workspaceId,
    actorLabel ?? tenant.memberId ?? "system",
    action,
    subject,
    JSON.stringify(data),
  ]);
}

export function mapStatement(r: Record<string, unknown>): BriefStatement & { outcomeKind: string | null; recordedBy: string | null } {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    tripId: r.trip_id ? String(r.trip_id) : null,
    dimension: r.dimension as BriefStatement["dimension"],
    text: String(r.text),
    evidence: r.evidence as BriefStatement["evidence"],
    source: String(r.source),
    recordedAt: iso(r.recorded_at)!,
    supersededBy: r.superseded_by ? String(r.superseded_by) : null,
    outcomeKind: str(r.outcome_kind),
    recordedBy: str(r.recorded_by),
  };
}

/** External dependencies of the ops jobs; tests pass fakes. */
export interface OpsDeps {
  llm: () => StructuredLLM;
  mailer: () => Mailer;
  blobs: () => BlobStore;
  now: () => Date;
  agentsConfigured: () => boolean;
}

export async function defaultDeps(): Promise<OpsDeps> {
  const [{ ClaudeLLM, agentsConfigured }, { mailer }, { blobs }] = await Promise.all([import("@/agents/llm"), import("@/server/mail"), import("@/server/storage")]);
  let llm: StructuredLLM | undefined;
  return {
    llm: () => (llm ??= new ClaudeLLM()),
    mailer,
    blobs,
    now: () => new Date(),
    agentsConfigured: () => agentsConfigured(),
  };
}
