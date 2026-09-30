/**
 * People, role history, texture, client ties, the reciprocity ledger, moves,
 * nudges and notices. Every function runs inside withTenant, so row-level
 * security decides visibility: private people are the owner's alone, and
 * texture is readable by the relationship holder only (and stored encrypted).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "@/db/client";
import { audit } from "@/db/repo";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { DomainError, type Role } from "@/domain/common";
import { chipAdvice, currentRole, nudges, recordMove, type ChipAdvice, type LedgerEntry, type LedgerEntryKind, type Nudge, type Person, type RoleStint } from "@/domain/crm";
import { templateNoteDraft } from "@/domain/crmBrief";
import { moveNudge, normalizeAddress } from "@/domain/crmIngest";
import { decryptFor, encryptFor } from "@/server/crypto";
import { enqueueAsTenant } from "@/server/jobs/queue";
import { draftNudgeNote } from "@/agents/nudgeDrafter";
import type { StructuredLLM } from "@/agents/llm";

export const STORE_GUARDRAIL = "Store only what the subject would be comfortable seeing about themselves.";

export interface PersonRecord extends Person {
  scope: "private" | "workspace";
  emails: string[];
  source: "manual" | "inbound_email" | "google_import";
  ownerName: string;
  /** The owner's notes, decrypted. Null when the viewer isn't the owner. */
  textureVisible: string[] | null;
  clients: { id: string; name: string }[];
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const textureContext = (personId: string) => `person_texture:${personId}`;

function mapPerson(r: Record<string, unknown>): Omit<PersonRecord, "textureVisible" | "clients"> {
  const approach = (r.approach ?? {}) as Partial<Person["approach"]>;
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    ownerName: String(r.owner_name ?? ""),
    name: String(r.name),
    roles: ((r.roles ?? []) as RoleStint[]).map((s) => ({ ...s, propertyId: s.propertyId ?? null, measuredOn: s.measuredOn ?? null, to: s.to ?? null })),
    approach: {
      channel: approach.channel ?? null,
      timeZone: approach.timeZone ?? null,
      language: approach.language ?? null,
      boss: approach.boss ?? null,
      goingOverTheirHeadAcceptable: Boolean(approach.goingOverTheirHeadAcceptable),
    },
    texture: [],
    clientIds: [],
    scope: r.scope as PersonRecord["scope"],
    emails: (r.emails as string[] | null) ?? [],
    source: (r.source as PersonRecord["source"]) ?? "manual",
  };
}

async function memberRole(q: Queryable, memberId: string): Promise<Role | null> {
  const { rows } = await q.query<{ role: Role }>("select role from members where id = $1 and disabled_at is null", [memberId]);
  return rows[0]?.role ?? null;
}

/** The holder edits; a workspace owner or admin may too (never the texture). */
async function assertCanEdit(q: Queryable, tenant: Tenant, person: { ownerId: string }): Promise<void> {
  if (person.ownerId === tenant.memberId) return;
  const role = await memberRole(q, tenant.memberId);
  if (role !== "owner" && role !== "admin") throw new DomainError("forbidden", "Only the relationship holder (or a workspace owner) can change this record");
}

/**
 * Texture written before encryption existed lived in people.texture as
 * plaintext. The owner's first read moves it into the encrypted table.
 */
async function migrateLegacyTexture(q: Queryable, tenant: Tenant, personId: string, legacy: unknown): Promise<void> {
  const lines = Array.isArray(legacy) ? legacy.map(String).filter(Boolean) : [];
  if (!lines.length) return;
  const existing = await readTexture(q, tenant, personId);
  await writeTexture(q, tenant, personId, [...(existing ?? []), ...lines]);
  await q.query("update people set texture = '[]'::jsonb where id = $1", [personId]);
}

async function readTexture(q: Queryable, tenant: Tenant, personId: string): Promise<string[] | null> {
  const { rows } = await q.query<{ sealed: string }>("select sealed from person_texture where person_id = $1", [personId]);
  if (!rows[0]) return null;
  return JSON.parse(await decryptFor(q, tenant.workspaceId, textureContext(personId), rows[0].sealed)) as string[];
}

async function writeTexture(q: Queryable, tenant: Tenant, personId: string, lines: string[]): Promise<void> {
  const sealed = await encryptFor(q, tenant.workspaceId, textureContext(personId), JSON.stringify(lines));
  await q.query(
    `insert into person_texture (person_id, workspace_id, owner_id, sealed, updated_at) values ($1, $2, $3, $4, now())
     on conflict (person_id) do update set sealed = excluded.sealed, updated_at = now()`,
    [personId, tenant.workspaceId, tenant.memberId, sealed],
  );
}

const PERSON_SELECT = `select p.*, m.name as owner_name from people p join members m on m.id = p.owner_id`;

export async function listPeople(q: Queryable, tenant: Tenant): Promise<PersonRecord[]> {
  const { rows } = await q.query<Record<string, unknown>>(`${PERSON_SELECT} order by p.name`);
  const ties = await q.query<{ person_id: string; client_id: string; name: string }>(
    "select pc.person_id, pc.client_id, c.name from person_clients pc join clients c on c.id = pc.client_id order by c.name",
  );
  const out: PersonRecord[] = [];
  for (const r of rows) {
    const p = mapPerson(r);
    const mine = p.ownerId === tenant.memberId;
    if (mine) await migrateLegacyTexture(q, tenant, p.id, r.texture);
    const clients = ties.rows.filter((t) => t.person_id === p.id).map((t) => ({ id: t.client_id, name: t.name }));
    const texture = mine ? ((await readTexture(q, tenant, p.id)) ?? []) : null;
    out.push({ ...p, texture: texture ?? [], textureVisible: texture, clients, clientIds: clients.map((c) => c.id) });
  }
  return out;
}

export async function getPerson(q: Queryable, tenant: Tenant, id: string): Promise<PersonRecord | null> {
  const { rows } = await q.query<Record<string, unknown>>(`${PERSON_SELECT} where p.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  const p = mapPerson(r);
  const mine = p.ownerId === tenant.memberId;
  if (mine) await migrateLegacyTexture(q, tenant, p.id, r.texture);
  const ties = await q.query<{ client_id: string; name: string }>(
    "select pc.client_id, c.name from person_clients pc join clients c on c.id = pc.client_id where pc.person_id = $1 order by c.name",
    [id],
  );
  const clients = ties.rows.map((t) => ({ id: t.client_id, name: t.name }));
  const texture = mine ? ((await readTexture(q, tenant, id)) ?? []) : null;
  return { ...p, texture: texture ?? [], textureVisible: texture, clients, clientIds: clients.map((c) => c.id) };
}

export async function listLedger(q: Queryable, personId?: string): Promise<(LedgerEntry & { importance: string | null; source: string })[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from ledger_entries ${personId ? "where person_id = $1" : ""} order by at desc, created_at desc`,
    personId ? [personId] : [],
  );
  return rows.map((r) => ({
    id: String(r.id),
    personId: String(r.person_id),
    kind: r.kind as LedgerEntryKind,
    at: iso(r.at),
    note: String(r.note ?? ""),
    askType: (r.ask_type as string | null) ?? null,
    roomNights: r.room_nights == null ? null : Number(r.room_nights),
    revenueMinor: r.revenue_minor == null ? null : Number(r.revenue_minor),
    importance: (r.importance as string | null) ?? null,
    source: String(r.source ?? "manual"),
  }));
}

// ---------------------------------------------------------------------------
// Create / update

const trimmed = (max: number) => z.string().trim().max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

export const PersonInput = z.object({
  name: trimmed(200).min(1, "Name is required"),
  scope: z.enum(["private", "workspace"]).default("private"),
  emails: z
    .array(z.string().trim().toLowerCase().email("Enter valid email addresses"))
    .max(10)
    .default([])
    .transform((l) => [...new Set(l.map(normalizeAddress))]),
  approach: z.object({
    channel: optional(80),
    timeZone: optional(64),
    language: optional(40),
    boss: optional(200),
    goingOverTheirHeadAcceptable: z.boolean().default(false),
  }),
  /** Only used on create; later changes go through recordMove so history is kept. */
  role: z
    .object({ organization: trimmed(200).min(1), title: trimmed(200).min(1), measuredOn: optional(200), from: isoDate })
    .nullish(),
  texture: z.array(trimmed(500).min(1)).max(50).optional(),
});
export type PersonInput = z.input<typeof PersonInput>;

async function assertEmailsFree(q: Queryable, emails: string[], exceptId: string | null): Promise<void> {
  if (!emails.length) return;
  const { rows } = await q.query<{ name: string }>("select name from people where emails && $1::text[] and ($2::uuid is null or id <> $2)", [emails, exceptId]);
  if (rows[0]) throw new DomainError("duplicate_email", `That email already belongs to ${rows[0].name}; merge instead of creating a duplicate`);
}

export async function createPersonTx(
  q: Queryable,
  tenant: Tenant,
  raw: PersonInput,
  opts: { source?: PersonRecord["source"]; now: Date },
): Promise<string> {
  const input = PersonInput.parse(raw);
  await assertEmailsFree(q, input.emails, null);
  const id = randomUUID();
  const roles: RoleStint[] = input.role ? [{ ...input.role, propertyId: null, to: null }] : [];
  await q.query(
    `insert into people (id, workspace_id, owner_id, name, roles, approach, texture, scope, emails, source, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, '[]', $7, $8, $9, $10, $10)`,
    [id, tenant.workspaceId, tenant.memberId, input.name, JSON.stringify(roles), JSON.stringify(input.approach), input.scope, input.emails, opts.source ?? "manual", opts.now.toISOString()],
  );
  if (input.texture?.length) await writeTexture(q, tenant, id, input.texture);
  await audit(q, tenant.workspaceId, tenant.memberId, "person.created", id, { scope: input.scope, source: opts.source ?? "manual" });
  return id;
}

export function createPerson(db: Db, tenant: Tenant, raw: PersonInput, now: Date): Promise<string> {
  return withTenant(db, tenant, (q) => createPersonTx(q, tenant, raw, { now }));
}

export function updatePerson(db: Db, tenant: Tenant, id: string, raw: Omit<PersonInput, "role">, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const person = await getPerson(q, tenant, id);
    if (!person) throw new DomainError("not_found", "Person not found");
    await assertCanEdit(q, tenant, person);
    const input = PersonInput.parse(raw);
    await assertEmailsFree(q, input.emails, id);
    await q.query("update people set name = $2, scope = $3, emails = $4, approach = $5, updated_at = $6 where id = $1", [
      id,
      input.name,
      input.scope,
      input.emails,
      JSON.stringify(input.approach),
      now.toISOString(),
    ]);
    if (input.texture !== undefined) {
      if (person.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the relationship holder keeps texture notes");
      await writeTexture(q, tenant, id, input.texture);
    }
    await audit(q, tenant.workspaceId, tenant.memberId, "person.updated", id, { scope: input.scope, scopeChanged: input.scope !== person.scope });
  });
}

/** Adds emails (and optionally a first role) to an existing person: the merge path for suggestions. */
export async function mergeIntoPersonTx(q: Queryable, tenant: Tenant, id: string, add: { emails: string[] }, now: Date): Promise<void> {
  const person = await getPerson(q, tenant, id);
  if (!person) throw new DomainError("not_found", "Person to merge into not found");
  await assertCanEdit(q, tenant, person);
  const emails = [...new Set([...person.emails, ...add.emails.map(normalizeAddress)])];
  await assertEmailsFree(q, emails, id);
  await q.query("update people set emails = $2, updated_at = $3 where id = $1", [id, emails, now.toISOString()]);
  await audit(q, tenant.workspaceId, tenant.memberId, "person.merged", id, { added: add.emails.length });
}

export function deletePerson(db: Db, tenant: Tenant, id: string): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const person = await getPerson(q, tenant, id);
    if (!person) throw new DomainError("not_found", "Person not found");
    if (person.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the relationship holder can delete this record");
    const { rows } = await q.query<{ n: number }>("select count(*)::int as n from commitments where promisor_person_id = $1", [id]);
    if ((rows[0]?.n ?? 0) > 0) throw new DomainError("in_use", "Commitments reference this person; keep the record for their history");
    await q.query("delete from people where id = $1", [id]);
    await audit(q, tenant.workspaceId, tenant.memberId, "person.deleted", id);
  });
}

export function setClientTie(db: Db, tenant: Tenant, input: { personId: string; clientId: string; note?: string; remove?: boolean }): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const person = await getPerson(q, tenant, input.personId);
    if (!person) throw new DomainError("not_found", "Person not found");
    await assertCanEdit(q, tenant, person);
    if (input.remove) {
      await q.query("delete from person_clients where person_id = $1 and client_id = $2", [input.personId, input.clientId]);
    } else {
      const { rows } = await q.query("select 1 from clients where id = $1", [input.clientId]);
      if (!rows[0]) throw new DomainError("not_found", "Client not found");
      await q.query(
        `insert into person_clients (person_id, client_id, workspace_id, note) values ($1, $2, $3, $4)
         on conflict (person_id, client_id) do update set note = excluded.note`,
        [input.personId, input.clientId, tenant.workspaceId, (input.note ?? "").slice(0, 300)],
      );
    }
    await audit(q, tenant.workspaceId, tenant.memberId, input.remove ? "person.client_untied" : "person.client_tied", input.personId, { clientId: input.clientId });
  });
}

// ---------------------------------------------------------------------------
// Moves

export const MoveInput = z.object({
  organization: trimmed(200).min(1, "Organization is required"),
  title: trimmed(200).min(1, "Title is required"),
  measuredOn: optional(200),
  from: isoDate,
});

/**
 * Close the current stint, open the new one, surface the new door to the
 * owner and flag shared knowledge that depended on this person. The flagging
 * crosses private scopes (a colleague's knowledge may depend on this contact),
 * so it runs as a platform step, immediately and again as a queued job in case
 * this process dies between the two.
 */
export async function recordPersonMove(db: Db, tenant: Tenant, personId: string, raw: z.input<typeof MoveInput>, now: Date): Promise<{ newDoor: string; flagged: number }> {
  const next = MoveInput.parse(raw);
  const moveId = randomUUID();
  const { newDoor, ownerId } = await withTenant(db, tenant, async (q) => {
    const person = await getPerson(q, tenant, personId);
    if (!person) throw new DomainError("not_found", "Person not found");
    await assertCanEdit(q, tenant, person);
    const cur = currentRole(person);
    if (cur && next.from <= cur.from.slice(0, 10)) throw new DomainError("bad_date", `The move must start after ${cur.from.slice(0, 10)}, when the current role began`);
    const moved = recordMove(person, { ...next, propertyId: null }, []);
    await q.query("update people set roles = $2, updated_at = $3 where id = $1", [personId, JSON.stringify(moved.person.roles), now.toISOString()]);
    await audit(q, tenant.workspaceId, tenant.memberId, "person.moved", personId, { to: next.organization, title: next.title, moveId });
    await enqueueAsTenant(q, { kind: "crm.flag_dependent_knowledge", payload: { personId, moveId, newDoor: moved.newDoor }, dedupeKey: `crm.move:${moveId}` });
    return { newDoor: moved.newDoor, ownerId: person.ownerId };
  });
  const flagged = await flagDependentKnowledge(db, { workspaceId: tenant.workspaceId, personId, moveId, newDoor, ownerId, now });
  return { newDoor, flagged: flagged.length };
}

/** Idempotent: re-running flags nothing new and inserts no duplicate notices. */
export function flagDependentKnowledge(
  db: Db,
  p: { workspaceId: string; personId: string; moveId: string; newDoor: string; ownerId?: string; now: Date },
): Promise<string[]> {
  return withSystem(db, async (q) => {
    const person = await q.query<{ owner_id: string; name: string }>("select owner_id, name from people where id = $1 and workspace_id = $2", [p.personId, p.workspaceId]);
    const row = person.rows[0];
    if (!row) return [];
    const reason = `Depended on ${row.name}, who has moved: ${p.newDoor}`;
    const { rows } = await q.query<{ id: string; owner_id: string }>(
      `update knowledge_items set needs_review = true, review_reason = $3, review_flagged_at = $4
        where workspace_id = $1 and depends_on_person_id = $2 and not needs_review returning id, owner_id`,
      [p.workspaceId, p.personId, reason, p.now.toISOString()],
    );
    const notice = (memberId: string, kind: string, message: string, key: string, data: unknown = {}) =>
      q.query(
        `insert into crm_notices (id, workspace_id, member_id, person_id, kind, message, data, dedupe_key) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (workspace_id, dedupe_key) do nothing`,
        [randomUUID(), p.workspaceId, memberId, p.personId, kind, message, JSON.stringify(data), key],
      );
    await notice(row.owner_id, "new_door", p.newDoor, `move:${p.moveId}:door`);
    const byOwner = new Map<string, string[]>();
    for (const r of rows) byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) ?? []), r.id]);
    for (const [owner, ids] of byOwner) {
      await notice(owner, "knowledge_review", `${ids.length} knowledge item${ids.length > 1 ? "s" : ""} depended on ${row.name} and need review after their move.`, `move:${p.moveId}:knowledge:${owner}`, { knowledgeIds: ids });
    }
    if (rows.length) await audit(q, p.workspaceId, "system:crm", "knowledge.flagged_for_review", p.personId, { moveId: p.moveId, knowledgeIds: rows.map((r) => r.id) });
    return rows.map((r) => r.id);
  });
}

// ---------------------------------------------------------------------------
// Ledger

export const LedgerInput = z
  .object({
    personId: z.string().uuid(),
    kind: z.enum(["favor_asked", "favor_granted", "favor_declined", "business_sent", "recognition_given", "touch"]),
    at: z.string().min(10),
    note: trimmed(500).default(""),
    askType: optional(60),
    importance: z.enum(["routine", "important", "critical"]).nullish(),
    roomNights: z.coerce.number().int().min(0).max(10_000).nullish(),
    revenueMinor: z.coerce.number().int().min(0).nullish(),
    /** The member saw the chip advice and still wants to log the ask. */
    acknowledgeAdvice: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (Number.isNaN(Date.parse(v.at))) ctx.addIssue({ code: "custom", message: "Enter a valid date", path: ["at"] });
    if (v.kind === "favor_asked" && !v.importance) ctx.addIssue({ code: "custom", message: "Say how much this ask matters", path: ["importance"] });
  });

export class ChipAdviceError extends DomainError {
  constructor(readonly advice: ChipAdvice) {
    super("chip_advice", advice.reason);
  }
}

export async function logLedgerEntryTx(
  q: Queryable,
  tenant: Tenant,
  raw: z.input<typeof LedgerInput>,
  now: Date,
  source: { source: "manual" | "inbound_email" | "google_import"; sourceRef: string | null } = { source: "manual", sourceRef: null },
): Promise<{ id: string; advice: ChipAdvice | null; duplicate: boolean }> {
  const input = LedgerInput.parse(raw);
  const { rows } = await q.query("select 1 from people where id = $1", [input.personId]);
  if (!rows[0]) throw new DomainError("not_found", "Person not found");
  let advice: ChipAdvice | null = null;
  if (input.kind === "favor_asked") {
    advice = chipAdvice(await listLedger(q, input.personId), now, { importance: input.importance! });
    // Before a favor is requested, the ledger speaks. The member decides.
    if (advice.advice !== "ask" && !input.acknowledgeAdvice) throw new ChipAdviceError(advice);
  }
  const id = randomUUID();
  const ins = await q.query<{ id: string }>(
    `insert into ledger_entries (id, workspace_id, person_id, kind, at, note, ask_type, room_nights, revenue_minor, importance, source, source_ref, logged_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (workspace_id, source_ref) where source_ref is not null do nothing returning id`,
    [
      id, tenant.workspaceId, input.personId, input.kind, new Date(input.at).toISOString(), input.note, input.askType,
      input.roomNights ?? null, input.revenueMinor ?? null, input.importance ?? null, source.source, source.sourceRef, tenant.memberId,
    ],
  );
  if (!ins.rows[0]) return { id, advice, duplicate: true };
  await audit(q, tenant.workspaceId, tenant.memberId, `ledger.${input.kind}`, input.personId, {
    entryId: id,
    source: source.source,
    advice: advice?.advice ?? null,
    overrodeAdvice: advice !== null && advice.advice !== "ask",
  });
  return { id, advice, duplicate: false };
}

export function logLedgerEntry(db: Db, tenant: Tenant, raw: z.input<typeof LedgerInput>, now: Date) {
  return withTenant(db, tenant, (q) => logLedgerEntryTx(q, tenant, raw, now));
}

export function deleteLedgerEntry(db: Db, tenant: Tenant, entryId: string): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<{ person_id: string; logged_by: string | null }>("select person_id, logged_by from ledger_entries where id = $1", [entryId]);
    const e = rows[0];
    if (!e) throw new DomainError("not_found", "Entry not found");
    const person = await getPerson(q, tenant, e.person_id);
    if (!person) throw new DomainError("not_found", "Person not found");
    if (e.logged_by !== tenant.memberId) await assertCanEdit(q, tenant, person);
    await q.query("delete from ledger_entries where id = $1", [entryId]);
    await audit(q, tenant.workspaceId, tenant.memberId, "ledger.deleted", e.person_id, { entryId });
  });
}

// ---------------------------------------------------------------------------
// Nudges, drafts and notices

/** Nudges for the relationships the viewer holds. */
export function nudgesFor(person: PersonRecord, entries: readonly LedgerEntry[], tenant: Tenant, now: Date): Nudge[] {
  if (person.ownerId !== tenant.memberId) return [];
  const out = nudges(person, entries, now);
  const moved = moveNudge(person, now);
  if (moved) out.unshift(moved);
  return out;
}

export interface NoteDraft {
  id: string;
  personId: string;
  nudgeKind: string;
  subject: string;
  body: string;
  draftedBy: "agent" | "template";
  createdAt: string;
}

/**
 * Draft the note behind a nudge. The agent drafts when configured; otherwise a
 * plain template. Stored encrypted for the owner; never sent by the system.
 */
export async function draftNote(db: Db, tenant: Tenant, personId: string, nudgeKind: Nudge["kind"], llm: StructuredLLM | null, now: Date): Promise<string> {
  const ctx = await withTenant(db, tenant, async (q) => {
    const person = await getPerson(q, tenant, personId);
    if (!person) throw new DomainError("not_found", "Person not found");
    if (person.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the relationship holder drafts notes to this person");
    const entries = await listLedger(q, personId);
    const nudge = nudgesFor(person, entries, tenant, now).find((n) => n.kind === nudgeKind) ?? {
      personId,
      kind: nudgeKind,
      message: `A note to ${person.name}`,
    };
    const { rows } = await q.query<{ name: string }>("select name from members where id = $1", [tenant.memberId]);
    return { person, entries, nudge, ownerName: rows[0]?.name ?? "" };
  });
  const role = currentRole(ctx.person);
  let draft = templateNoteDraft(ctx.person, ctx.nudge, ctx.ownerName);
  let draftedBy: NoteDraft["draftedBy"] = "template";
  if (llm) {
    const r = await draftNudgeNote(llm, {
      nudge: ctx.nudge,
      personName: ctx.person.name,
      role: role ? `${role.title}, ${role.organization}` : null,
      language: ctx.person.approach.language,
      ownerName: ctx.ownerName,
      recentNotes: ctx.entries.slice(0, 5).map((e) => `${e.at.slice(0, 10)} ${e.kind}: ${e.note}`),
    });
    if (!("error" in r)) {
      draft = r;
      draftedBy = "agent";
    }
  }
  return withTenant(db, tenant, async (q) => {
    const id = randomUUID();
    await q.query(
      `insert into crm_note_drafts (id, workspace_id, owner_id, person_id, nudge_kind, subject, body_sealed, drafted_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, tenant.workspaceId, tenant.memberId, personId, nudgeKind, draft.subject.slice(0, 200), await encryptFor(q, tenant.workspaceId, `crm_note_draft:${id}`, draft.body), draftedBy, now.toISOString()],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "crm.note_drafted", personId, { draftId: id, draftedBy });
    return id;
  });
}

export async function listDrafts(q: Queryable, tenant: Tenant, personId: string): Promise<NoteDraft[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from crm_note_drafts where person_id = $1 order by created_at desc limit 5", [personId]);
  const out: NoteDraft[] = [];
  for (const r of rows) {
    out.push({
      id: String(r.id),
      personId: String(r.person_id),
      nudgeKind: String(r.nudge_kind),
      subject: String(r.subject),
      body: await decryptFor(q, tenant.workspaceId, `crm_note_draft:${String(r.id)}`, String(r.body_sealed)),
      draftedBy: r.drafted_by as NoteDraft["draftedBy"],
      createdAt: iso(r.created_at),
    });
  }
  return out;
}

export function discardDraft(db: Db, tenant: Tenant, draftId: string): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    await q.query("delete from crm_note_drafts where id = $1", [draftId]);
  });
}

export interface Notice {
  id: string;
  kind: string;
  personId: string | null;
  message: string;
  createdAt: string;
}

export async function listNotices(q: Queryable): Promise<Notice[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    "select id, kind, person_id, message, created_at from crm_notices where dismissed_at is null order by created_at desc limit 50",
  );
  return rows.map((r) => ({ id: String(r.id), kind: String(r.kind), personId: r.person_id ? String(r.person_id) : null, message: String(r.message), createdAt: iso(r.created_at) }));
}

export function dismissNotice(db: Db, tenant: Tenant, id: string, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    await q.query("update crm_notices set dismissed_at = $2 where id = $1 and dismissed_at is null", [id, now.toISOString()]);
  });
}

/** Knowledge items that depend on a person (for the detail page). */
export async function dependentKnowledge(q: Queryable, personId: string): Promise<{ id: string; category: string; needsReview: boolean; reviewReason: string | null }[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    "select id, category, needs_review, review_reason from knowledge_items where depends_on_person_id = $1 order by needs_review desc, category",
    [personId],
  );
  return rows.map((r) => ({ id: String(r.id), category: String(r.category), needsReview: Boolean(r.needs_review), reviewReason: (r.review_reason as string | null) ?? null }));
}
