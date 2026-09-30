/**
 * Supplier observations: dated, sourced, with applicability, request and
 * outcome (failures too), and an optional photo stored encrypted. Fresh
 * expertise is a first-class input: every recommendation shows where it came
 * from, when, and what was actually validated.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { audit } from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import {
  provenance,
  requestTrackRecord,
  trustTier,
  type Applicability,
  type Observation,
  type ObservationSource,
  type TrustTier,
} from "@/domain/knowledge";
import { decryptBytes, encryptFor } from "@/server/crypto";
import type { BlobStore } from "@/server/storage";
import { day, likePattern, str } from "./util";

export const SOURCES: readonly ObservationSource[] = ["firsthand", "written_confirmation", "supplier_claim", "secondhand"];
export const SOURCE_LABEL: Record<ObservationSource, string> = {
  firsthand: "Firsthand",
  written_confirmation: "Written confirmation",
  supplier_claim: "Supplier claim",
  secondhand: "Secondhand",
};
export const OUTCOMES = ["granted", "partial", "denied"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

export interface ObservationRow extends Observation {
  supplierName: string;
  ownerId: string;
  ownerName: string;
  scope: "private" | "workspace";
  hasPhoto: boolean;
}

function mapObservation(r: Record<string, unknown>): ObservationRow {
  const a = (r.applicability ?? {}) as Partial<Applicability>;
  return {
    id: String(r.id),
    supplierId: String(r.supplier_name),
    supplierName: String(r.supplier_name),
    observedAt: day(r.observed_at)!,
    source: r.source as ObservationSource,
    personallyInspected: Boolean(r.personally_inspected),
    statement: String(r.statement),
    applicability: {
      program: a.program ?? null,
      roomCategory: a.roomCategory ?? null,
      season: a.season ?? null,
      relationshipInvolved: Boolean(a.relationshipInvolved),
    },
    request: str(r.request),
    outcome: (r.outcome as Observation["outcome"]) ?? null,
    bookingRef: str(r.booking_ref),
    ownerId: String(r.owner_id),
    ownerName: String(r.owner_name ?? ""),
    scope: r.scope as ObservationRow["scope"],
    hasPhoto: Boolean(r.photo_key),
  };
}

const SELECT = "select o.*, m.name as owner_name from observations o join members m on m.id = o.owner_id";

export async function listObservations(q: Queryable, supplier?: string): Promise<ObservationRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `${SELECT} ${supplier ? "where lower(o.supplier_name) = lower($1)" : ""} order by o.observed_at desc, o.created_at desc`,
    supplier ? [supplier] : [],
  );
  return rows.map(mapObservation);
}

export async function getObservation(q: Queryable, id: string): Promise<ObservationRow | null> {
  const { rows } = await q.query<Record<string, unknown>>(`${SELECT} where o.id = $1`, [id]);
  return rows[0] ? mapObservation(rows[0]) : null;
}

export async function listSuppliers(q: Queryable, search?: string | null): Promise<{ supplierName: string; count: number; lastObservedAt: string; failures: number }[]> {
  const params: unknown[] = [];
  const where = search?.trim() ? `where supplier_name ilike $${params.push(likePattern(search))}` : "";
  const { rows } = await q.query<Record<string, unknown>>(
    `select min(supplier_name) as supplier_name, count(*)::int as count, max(observed_at) as last_observed_at,
            count(*) filter (where outcome = 'denied')::int as failures
       from observations ${where} group by lower(supplier_name) order by max(observed_at) desc limit 200`,
    params,
  );
  return rows.map((r) => ({ supplierName: String(r.supplier_name), count: Number(r.count), lastObservedAt: day(r.last_observed_at)!, failures: Number(r.failures) }));
}

export interface ObservationInput {
  supplierName: string;
  observedAt: string; // YYYY-MM-DD, the date of the observation itself
  source: ObservationSource;
  personallyInspected: boolean;
  statement: string;
  applicability: Applicability;
  request: string | null;
  outcome: Outcome | null;
  bookingRef: string | null;
  scope: "private" | "workspace";
}

function checkInput(input: ObservationInput, now: Date): void {
  if (!input.supplierName.trim()) throw new DomainError("no_supplier", "Name the supplier");
  if (!input.statement.trim()) throw new DomainError("no_statement", "Say what was observed");
  const observed = new Date(`${input.observedAt}T00:00:00Z`);
  if (Number.isNaN(observed.getTime())) throw new DomainError("bad_date", "Give the date of the observation");
  if (observed.getTime() > now.getTime() + 86_400_000) throw new DomainError("future_date", "An observation can't be dated in the future");
  if (input.outcome && !input.request) throw new DomainError("outcome_without_request", "An outcome needs the request it answers");
}

function params(input: ObservationInput) {
  return [
    input.supplierName.trim(),
    input.observedAt,
    input.source,
    input.personallyInspected,
    input.statement.trim(),
    JSON.stringify(input.applicability),
    input.request?.trim() || null,
    input.request ? input.outcome : null,
    input.bookingRef?.trim() || null,
    input.scope,
  ];
}

export async function createObservation(db: Db, tenant: Tenant, input: ObservationInput, now: Date): Promise<string> {
  checkInput(input, now);
  const id = randomUUID();
  await withTenant(db, tenant, async (q) => {
    await q.query(
      `insert into observations (supplier_name, observed_at, source, personally_inspected, statement, applicability, request, outcome, booking_ref, scope,
         id, workspace_id, owner_id, created_by, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$14)`,
      [...params(input), id, tenant.workspaceId, tenant.memberId, now.toISOString()],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "observation.created", id, { source: input.source, outcome: input.outcome });
  });
  return id;
}

async function requireOwned(q: Queryable, tenant: Tenant, id: string): Promise<ObservationRow> {
  const row = await getObservation(q, id);
  if (!row) throw new DomainError("not_found", "Observation not found");
  if (row.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the person who recorded this observation can change it");
  return row;
}

export async function updateObservation(db: Db, tenant: Tenant, id: string, input: ObservationInput, now: Date): Promise<void> {
  checkInput(input, now);
  await withTenant(db, tenant, async (q) => {
    await requireOwned(q, tenant, id);
    await q.query(
      `update observations set supplier_name = $1, observed_at = $2, source = $3, personally_inspected = $4, statement = $5, applicability = $6,
         request = $7, outcome = $8, booking_ref = $9, scope = $10, updated_at = $12 where id = $11`,
      [...params(input), id, now.toISOString()],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "observation.updated", id);
  });
}

export async function deleteObservation(db: Db, tenant: Tenant, id: string, store: BlobStore): Promise<void> {
  const key = await withTenant(db, tenant, async (q) => {
    const row = await requireOwned(q, tenant, id);
    const { rows } = await q.query<{ photo_key: string | null }>("delete from observations where id = $1 returning photo_key", [row.id]);
    await audit(q, tenant.workspaceId, tenant.memberId, "observation.deleted", id);
    return rows[0]?.photo_key ?? null;
  });
  // After commit: a failed blob delete leaves unreadable ciphertext, never a dangling reference.
  if (key) await store.delete(key).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Photos: encrypted with the workspace data key before they reach storage.

const photoContext = (id: string) => `observation-photo:${id}`;

export async function attachPhoto(db: Db, tenant: Tenant, id: string, photo: { bytes: Buffer; contentType: string }, store: BlobStore, now: Date): Promise<void> {
  if (!(PHOTO_TYPES as readonly string[]).includes(photo.contentType)) throw new DomainError("bad_photo", "Photos must be JPEG, PNG, WebP or HEIC");
  if (photo.bytes.length === 0) throw new DomainError("bad_photo", "The photo is empty");
  if (photo.bytes.length > MAX_PHOTO_BYTES) throw new DomainError("bad_photo", "Photos must be under 12 MB");
  const key = `${tenant.workspaceId}/observations/${id}/${randomUUID()}`;
  let old: string | null = null;
  try {
    await withTenant(db, tenant, async (q) => {
      const row = await requireOwned(q, tenant, id);
      const { rows } = await q.query<{ photo_key: string | null }>("select photo_key from observations where id = $1", [row.id]);
      old = rows[0]?.photo_key ?? null;
      const sealed = await encryptFor(q, tenant.workspaceId, photoContext(id), photo.bytes);
      await store.put(key, Buffer.from(sealed, "utf8"), "application/octet-stream");
      await q.query("update observations set photo_key = $2, photo_content_type = $3, updated_at = $4 where id = $1", [id, key, photo.contentType, now.toISOString()]);
      await audit(q, tenant.workspaceId, tenant.memberId, "observation.photo_attached", id, { bytes: photo.bytes.length });
    });
  } catch (err) {
    await store.delete(key).catch(() => undefined);
    throw err;
  }
  if (old) await store.delete(old).catch(() => undefined);
}

export async function removePhoto(db: Db, tenant: Tenant, id: string, store: BlobStore, now: Date): Promise<void> {
  const key = await withTenant(db, tenant, async (q) => {
    await requireOwned(q, tenant, id);
    const { rows } = await q.query<{ photo_key: string | null }>("select photo_key from observations where id = $1", [id]);
    await q.query("update observations set photo_key = null, photo_content_type = null, updated_at = $2 where id = $1", [id, now.toISOString()]);
    await audit(q, tenant.workspaceId, tenant.memberId, "observation.photo_removed", id);
    return rows[0]?.photo_key ?? null;
  });
  if (key) await store.delete(key).catch(() => undefined);
}

/** Readable by whoever can see the observation (RLS decides). */
export async function readPhoto(db: Db, tenant: Tenant, id: string, store: BlobStore): Promise<{ bytes: Buffer; contentType: string } | null> {
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<{ workspace_id: string; photo_key: string | null; photo_content_type: string | null }>(
      "select workspace_id, photo_key, photo_content_type from observations where id = $1",
      [id],
    );
    const r = rows[0];
    if (!r?.photo_key) return null;
    const sealed = (await store.get(r.photo_key)).toString("utf8");
    return { bytes: await decryptBytes(q, r.workspace_id, photoContext(id), sealed), contentType: r.photo_content_type ?? "application/octet-stream" };
  });
}

// ---------------------------------------------------------------------------
// Supplier view

export interface ObservationView extends ObservationRow {
  provenance: string;
  tier: TrustTier;
}

export interface ApplicabilityFilter {
  program?: string | null;
  roomCategory?: string | null;
  season?: string | null;
  relationshipInvolved?: boolean | null;
}

/**
 * Everything the supplier page shows: each observation with its provenance
 * line and the highest use it supports, and a track record per request type
 * that counts failures alongside successes, pooled only across observations
 * whose applicability matches the filter.
 */
export function supplierView(observations: readonly ObservationRow[], now: Date, filter: ApplicabilityFilter = {}) {
  const match: Partial<Applicability> = {};
  if (filter.program) match.program = filter.program;
  if (filter.roomCategory) match.roomCategory = filter.roomCategory;
  if (filter.season) match.season = filter.season;
  if (typeof filter.relationshipInvolved === "boolean") match.relationshipInvolved = filter.relationshipInvolved;
  const views: ObservationView[] = observations.map((o) => ({ ...o, provenance: provenance(o), tier: trustTier(o, now, o.bookingRef) }));
  const requests = [...new Set(observations.filter((o) => o.request && o.outcome).map((o) => o.request!))].sort();
  const trackRecords = requests.map((request) => ({ request, ...requestTrackRecord(observations, request, match) }));
  const options = {
    programs: [...new Set(observations.map((o) => o.applicability.program).filter((v): v is string => !!v))].sort(),
    roomCategories: [...new Set(observations.map((o) => o.applicability.roomCategory).filter((v): v is string => !!v))].sort(),
    seasons: [...new Set(observations.map((o) => o.applicability.season).filter((v): v is string => !!v))].sort(),
  };
  return {
    observations: views,
    trackRecords,
    options,
    inspected: observations.some((o) => o.personallyInspected),
    lastObservedAt: observations[0]?.observedAt ?? null,
  };
}
