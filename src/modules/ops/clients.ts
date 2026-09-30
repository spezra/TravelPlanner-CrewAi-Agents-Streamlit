/**
 * Clients, party members and the client brief. Enduring preferences stay
 * separate from one trip's needs; what the client said stays separate from
 * what the expert or an agent inferred; corrections supersede rather than
 * overwrite. Brief extraction from pasted notes runs as a job and produces
 * suggestions the expert accepts, never statements filed on the agent's word.
 */
import { randomUUID } from "node:crypto";
import { extractBrief } from "@/agents/briefExtractor";
import type { Db, Queryable } from "@/db/client";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { promoteToEnduring, type BriefDimension, type BriefStatement } from "@/domain/brief";
import { assertScopeAllowed, canManageClient, canPromote, clientScopeRules, supersede, type ClientScope, type OutcomeKind } from "@/domain/clientBook";
import { DomainError } from "@/domain/common";
import { decryptFor, encryptFor } from "@/server/crypto";
import { enqueueAsTenant, PermanentJobError } from "@/server/jobs/queue";
import { actor, audit, day, encCtx, iso, mapStatement, str, workspaceRow, type OpsDeps } from "./common";

export const DIMENSIONS: BriefDimension[] = ["desired_experience", "practical_constraints", "party_dynamics", "outcomes"];

export interface ClientSummary {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  scope: ClientScope;
  tripCount: number;
  erased: boolean;
}

export async function listClients(db: Db, tenant: Tenant): Promise<ClientSummary[]> {
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>(
      `select c.id, c.name, c.owner_id, m.name as owner_name, c.scope, c.erased_at,
              (select count(*) from trips t where t.client_id = c.id) as trip_count
         from clients c join members m on m.id = c.owner_id
        order by c.erased_at nulls first, c.name`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      ownerId: String(r.owner_id),
      ownerName: String(r.owner_name),
      scope: r.scope as ClientScope,
      tripCount: Number(r.trip_count),
      erased: r.erased_at != null,
    }));
  });
}

export interface ClientInput {
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  scope?: ClientScope;
}

function cleanClient(input: ClientInput): ClientInput {
  const name = input.name.trim();
  if (name.length < 2) throw new DomainError("bad_name", "Client name is too short");
  const email = input.email?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError("bad_email", "Enter a valid email address");
  return { name, email, phone: input.phone?.trim() || null, notes: input.notes?.trim() || null, scope: input.scope };
}

export async function createClient(db: Db, tenant: Tenant, input: ClientInput): Promise<string> {
  const c = cleanClient(input);
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const ws = await workspaceRow(q);
    const scope = c.scope ?? clientScopeRules(ws.bookPortability).defaultScope;
    assertScopeAllowed(ws.bookPortability, scope);
    const id = randomUUID();
    const notes = c.notes ? await encryptFor(q, tenant.workspaceId, encCtx("clients", "notes", id), c.notes) : null;
    await q.query("insert into clients (id, workspace_id, owner_id, name, scope, email, phone, notes_enc) values ($1,$2,$3,$4,$5,$6,$7,$8)", [
      id,
      tenant.workspaceId,
      tenant.memberId,
      c.name,
      scope,
      c.email,
      c.phone,
      notes,
    ]);
    await audit(q, tenant, "client.created", id, { scope });
    return id;
  });
}

async function loadClient(q: Queryable, id: string) {
  const { rows } = await q.query<Record<string, unknown>>("select * from clients where id = $1", [id]);
  const r = rows[0];
  if (!r) throw new DomainError("not_found", "Client not found");
  if (r.erased_at) throw new DomainError("erased", "This client's personal data was erased");
  return { id: String(r.id), ownerId: String(r.owner_id), scope: r.scope as ClientScope, name: String(r.name) };
}

export async function updateClient(db: Db, tenant: Tenant, id: string, input: ClientInput): Promise<void> {
  const c = cleanClient(input);
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    await loadClient(q, id);
    const notes = c.notes ? await encryptFor(q, tenant.workspaceId, encCtx("clients", "notes", id), c.notes) : null;
    await q.query("update clients set name = $2, email = $3, phone = $4, notes_enc = $5, updated_at = now() where id = $1", [id, c.name, c.email, c.phone, notes]);
    await audit(q, tenant, "client.updated", id);
  });
}

/**
 * Change who holds the client and where the record lives, within the
 * workspace's portability terms. The permission check runs as the member; the
 * update runs as the system role (scoped to the workspace and guarded on the
 * owner it checked), because handing a private client to someone else makes
 * the row invisible to the member doing it, which RLS refuses as an update.
 */
export async function reassignClient(db: Db, tenant: Tenant, id: string, input: { ownerId: string; scope: ClientScope }): Promise<void> {
  const checked = await withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    const ws = await workspaceRow(q);
    const client = await loadClient(q, id);
    if (!canManageClient(ws.bookPortability, me, client.ownerId)) {
      throw new DomainError("forbidden", ws.bookPortability === "advisor_owns" ? "Only the advisor who holds this client can move it" : "Only the client's owner or a workspace owner/admin can move it");
    }
    assertScopeAllowed(ws.bookPortability, input.scope);
    const owner = await q.query("select 1 from members where id = $1 and disabled_at is null", [input.ownerId]);
    if (!owner.rows.length) throw new DomainError("bad_owner", "The new owner must be an active member");
    return client;
  });
  await withSystem(db, async (q) => {
    const { rows } = await q.query("update clients set owner_id = $3, scope = $4, updated_at = now() where id = $1 and workspace_id = $2 and owner_id = $5 returning id", [
      id,
      tenant.workspaceId,
      input.ownerId,
      input.scope,
      checked.ownerId,
    ]);
    if (!rows.length) throw new DomainError("conflict", "The client changed hands meanwhile; reload and try again");
    await audit(q, tenant, "client.reassigned", id, { from: { owner: checked.ownerId, scope: checked.scope }, to: input });
  });
}

/** Removes a client with no trips. A client with history is erased through a data-subject request instead. */
export async function deleteClient(db: Db, tenant: Tenant, id: string): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    const ws = await workspaceRow(q);
    const client = await loadClient(q, id);
    if (!canManageClient(ws.bookPortability, me, client.ownerId)) throw new DomainError("forbidden", "You can't delete this client");
    const trips = await q.query("select 1 from trips where client_id = $1 limit 1", [id]);
    if (trips.rows.length) throw new DomainError("has_trips", "This client has trips. Record a deletion request to erase their personal data instead");
    await q.query("delete from clients where id = $1", [id]);
    await audit(q, tenant, "client.deleted", id);
  });
}

export interface PartyMember {
  id: string;
  name: string;
  relation: string;
  notes: string | null;
  erased: boolean;
}

export interface ClientDetail {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  ownerId: string;
  ownerName: string;
  scope: ClientScope;
  erased: boolean;
  party: PartyMember[];
  statements: ReturnType<typeof mapStatement>[];
  trips: { id: string; title: string; startsOn: string | null; endsOn: string | null }[];
  extractions: { id: string; tripId: string | null; sourceLabel: string; status: string; error: string | null; createdAt: string }[];
  suggestions: { id: string; extractionId: string; tripId: string | null; tripSpecific: boolean; dimension: BriefDimension; text: string; evidence: BriefStatement["evidence"] }[];
}

export async function getClientDetail(db: Db, tenant: Tenant, id: string): Promise<ClientDetail | null> {
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>(
      "select c.*, m.name as owner_name from clients c join members m on m.id = c.owner_id where c.id = $1",
      [id],
    );
    const c = rows[0];
    if (!c) return null;
    const ws = tenant.workspaceId;
    const party = (await q.query<Record<string, unknown>>("select * from client_party_members where client_id = $1 order by created_at", [id])).rows;
    const statements = (await q.query<Record<string, unknown>>("select * from brief_statements where client_id = $1 order by recorded_at", [id])).rows;
    const trips = (await q.query<Record<string, unknown>>("select id, title, starts_on, ends_on from trips where client_id = $1 order by starts_on nulls last", [id])).rows;
    const extractions = (
      await q.query<Record<string, unknown>>("select id, trip_id, source_label, status, error, created_at from brief_extractions where client_id = $1 order by created_at desc limit 20", [id])
    ).rows;
    const suggestions = (
      await q.query<Record<string, unknown>>("select * from brief_suggestions where client_id = $1 and status = 'pending' order by extraction_id, position", [id])
    ).rows;
    return {
      id,
      name: String(c.name),
      email: str(c.email),
      phone: str(c.phone),
      notes: c.notes_enc ? await decryptFor(q, ws, encCtx("clients", "notes", id), String(c.notes_enc)) : null,
      ownerId: String(c.owner_id),
      ownerName: String(c.owner_name),
      scope: c.scope as ClientScope,
      erased: c.erased_at != null,
      party: await Promise.all(
        party.map(async (p) => ({
          id: String(p.id),
          name: String(p.name),
          relation: String(p.relation),
          notes: p.notes_enc ? await decryptFor(q, ws, encCtx("client_party_members", "notes", String(p.id)), String(p.notes_enc)) : null,
          erased: p.erased_at != null,
        })),
      ),
      statements: statements.map(mapStatement),
      trips: trips.map((t) => ({ id: String(t.id), title: String(t.title), startsOn: day(t.starts_on), endsOn: day(t.ends_on) })),
      extractions: extractions.map((e) => ({
        id: String(e.id),
        tripId: str(e.trip_id),
        sourceLabel: String(e.source_label),
        status: String(e.status),
        error: str(e.error),
        createdAt: iso(e.created_at)!,
      })),
      suggestions: suggestions.map((s) => ({
        id: String(s.id),
        extractionId: String(s.extraction_id),
        tripId: str(s.trip_id),
        tripSpecific: Boolean(s.trip_specific),
        dimension: s.dimension as BriefDimension,
        text: String(s.text),
        evidence: s.evidence as BriefStatement["evidence"],
      })),
    };
  });
}

export async function addPartyMember(db: Db, tenant: Tenant, clientId: string, input: { name: string; relation: string; notes: string | null }): Promise<string> {
  const name = input.name.trim();
  if (name.length < 1) throw new DomainError("bad_name", "Enter a name");
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    await loadClient(q, clientId);
    const id = randomUUID();
    const notes = input.notes?.trim() ? await encryptFor(q, tenant.workspaceId, encCtx("client_party_members", "notes", id), input.notes.trim()) : null;
    await q.query("insert into client_party_members (id, workspace_id, client_id, name, relation, notes_enc) values ($1,$2,$3,$4,$5,$6)", [
      id,
      tenant.workspaceId,
      clientId,
      name,
      input.relation.trim(),
      notes,
    ]);
    await audit(q, tenant, "client.party_added", clientId, { partyMemberId: id });
    return id;
  });
}

export async function removePartyMember(db: Db, tenant: Tenant, partyMemberId: string): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const { rows } = await q.query<{ client_id: string }>("delete from client_party_members where id = $1 returning client_id", [partyMemberId]);
    if (!rows[0]) throw new DomainError("not_found", "Party member not found");
    await audit(q, tenant, "client.party_removed", rows[0].client_id, { partyMemberId });
  });
}

async function assertTripOfClient(q: Queryable, clientId: string, tripId: string | null): Promise<void> {
  if (!tripId) return;
  const { rows } = await q.query("select 1 from trips where id = $1 and client_id = $2", [tripId, clientId]);
  if (!rows.length) throw new DomainError("bad_trip", "That trip isn't this client's");
}

async function insertStatement(q: Queryable, workspaceId: string, s: BriefStatement & { outcomeKind?: OutcomeKind | null; recordedBy?: string | null; originDecisionId?: string | null }) {
  await q.query(
    `insert into brief_statements (id, workspace_id, client_id, trip_id, dimension, text, evidence, source, recorded_at, superseded_by, outcome_kind, recorded_by, origin_decision_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (origin_decision_id) do nothing`,
    [s.id, workspaceId, s.clientId, s.tripId, s.dimension, s.text, s.evidence, s.source, s.recordedAt, s.supersededBy, s.outcomeKind ?? null, s.recordedBy ?? null, s.originDecisionId ?? null],
  );
}
export { insertStatement as insertBriefStatement };

export interface StatementInput {
  clientId: string;
  tripId: string | null;
  dimension: BriefDimension;
  text: string;
  /** People record what the client said or what they infer; only agents produce agent_inferred. */
  evidence: "client_said" | "expert_inferred";
  source: string;
  outcomeKind?: OutcomeKind | null;
}

export async function addStatement(db: Db, tenant: Tenant, input: StatementInput, now: Date): Promise<string> {
  const text = input.text.trim();
  if (text.length < 3) throw new DomainError("bad_text", "Write the statement out");
  if (input.dimension === "outcomes" && !input.tripId) throw new DomainError("bad_trip", "Outcomes belong to a trip");
  if (input.outcomeKind && input.dimension !== "outcomes") throw new DomainError("bad_dimension", "Only outcomes carry enjoyed/regretted/would repeat");
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    await loadClient(q, input.clientId);
    await assertTripOfClient(q, input.clientId, input.tripId);
    const id = randomUUID();
    await insertStatement(q, tenant.workspaceId, {
      id,
      clientId: input.clientId,
      tripId: input.tripId,
      dimension: input.dimension,
      text,
      evidence: input.evidence,
      source: input.source.trim() || "entered by hand",
      recordedAt: now.toISOString(),
      supersededBy: null,
      outcomeKind: input.outcomeKind ?? null,
      recordedBy: tenant.memberId,
    });
    await audit(q, tenant, "brief.statement_added", input.clientId, { statementId: id, tripId: input.tripId, dimension: input.dimension, evidence: input.evidence });
    return id;
  });
}

/** Post-trip outcomes: what they enjoyed, regretted or would repeat. Recorded against the trip. */
export async function recordOutcome(db: Db, tenant: Tenant, input: { clientId: string; tripId: string; kind: OutcomeKind; text: string; evidence: StatementInput["evidence"] }, now: Date) {
  return addStatement(db, tenant, { clientId: input.clientId, tripId: input.tripId, dimension: "outcomes", text: input.text, evidence: input.evidence, source: "post-trip debrief", outcomeKind: input.kind }, now);
}

async function loadStatement(q: Queryable, id: string) {
  const { rows } = await q.query<Record<string, unknown>>("select * from brief_statements where id = $1 for update", [id]);
  if (!rows[0]) throw new DomainError("not_found", "Statement not found");
  return mapStatement(rows[0]);
}

/** Correct a statement: the original stays for history and points at the correction. */
export async function supersedeStatement(db: Db, tenant: Tenant, id: string, input: { text: string; evidence: StatementInput["evidence"] }, now: Date): Promise<string> {
  const text = input.text.trim();
  if (text.length < 3) throw new DomainError("bad_text", "Write the statement out");
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const original = await loadStatement(q, id);
    const { original: old, replacement } = supersede(
      original,
      { id: randomUUID(), tripId: original.tripId, dimension: original.dimension, text, evidence: input.evidence, source: "correction" },
      now,
    );
    await insertStatement(q, tenant.workspaceId, { ...replacement, outcomeKind: (original.outcomeKind as OutcomeKind | null) ?? null, recordedBy: tenant.memberId });
    await q.query("update brief_statements set superseded_by = $2 where id = $1", [old.id, old.supersededBy]);
    await audit(q, tenant, "brief.statement_superseded", original.clientId, { from: id, to: replacement.id });
    return replacement.id;
  });
}

/** Make a trip need an enduring preference. The expert's call only. */
export async function promoteStatement(db: Db, tenant: Tenant, id: string, now: Date): Promise<string> {
  return withTenant(db, tenant, async (q) => {
    const me = await actor(q, tenant);
    if (!canPromote(me.role)) throw new DomainError("forbidden", "Only owners and advisors can make a preference enduring");
    const s = await loadStatement(q, id);
    if (s.supersededBy) throw new DomainError("already_superseded", "That statement was already replaced");
    if (s.tripId === null) throw new DomainError("already_enduring", "That preference is already enduring");
    if (s.dimension === "outcomes") throw new DomainError("bad_dimension", "Outcomes stay with their trip; record a preference instead");
    const { promoted, original } = promoteToEnduring(s, randomUUID(), now);
    await insertStatement(q, tenant.workspaceId, { ...promoted, recordedBy: tenant.memberId });
    await q.query("update brief_statements set superseded_by = $2 where id = $1", [original.id, original.supersededBy]);
    await audit(q, tenant, "brief.statement_promoted", s.clientId, { from: id, to: promoted.id });
    return promoted.id;
  });
}

// ---------------------------------------------------------------------------
// Extraction from pasted call notes and emails

export const EXTRACT_KIND = "ops.extract_brief";

export async function requestBriefExtraction(
  db: Db,
  tenant: Tenant,
  input: { clientId: string; tripId: string | null; sourceLabel: string; text: string },
  agentsOn: boolean,
): Promise<string> {
  if (!agentsOn) throw new DomainError("agents_unavailable", "The extraction agent isn't configured. Add statements by hand");
  const text = input.text.trim();
  if (text.length < 20) throw new DomainError("bad_source", "Paste the call notes or email to extract from");
  if (text.length > 100_000) throw new DomainError("bad_source", "That source is too long; paste the relevant part");
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    await loadClient(q, input.clientId);
    await assertTripOfClient(q, input.clientId, input.tripId);
    const id = randomUUID();
    const source = await encryptFor(q, tenant.workspaceId, encCtx("brief_extractions", "source", id), text);
    await q.query(
      "insert into brief_extractions (id, workspace_id, client_id, trip_id, source_label, source_enc, status, requested_by) values ($1,$2,$3,$4,$5,$6,'queued',$7)",
      [id, tenant.workspaceId, input.clientId, input.tripId, input.sourceLabel.trim() || "pasted notes", source, tenant.memberId],
    );
    await enqueueAsTenant(q, { kind: EXTRACT_KIND, payload: { extractionId: id }, dedupeKey: `${EXTRACT_KIND}:${id}` });
    await audit(q, tenant, "brief.extraction_requested", input.clientId, { extractionId: id });
    return id;
  });
}

/**
 * Job body. Runs as the member who asked, so the agent sees nothing they
 * couldn't. Idempotent: suggestions are filed only while the extraction is
 * still queued, in the same transaction that marks it done.
 */
export async function runBriefExtraction(db: Db, deps: OpsDeps, tenant: Tenant | null, extractionId: string): Promise<void> {
  if (!tenant) throw new PermanentJobError("Brief extraction needs the requesting member");
  const job = await withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>("select * from brief_extractions where id = $1", [extractionId]);
    const r = rows[0];
    if (!r || r.status !== "queued") return null;
    if (!r.source_enc) return { id: String(r.id), clientId: String(r.client_id), tripId: str(r.trip_id), label: String(r.source_label), text: null };
    const text = await decryptFor(q, tenant.workspaceId, encCtx("brief_extractions", "source", extractionId), String(r.source_enc));
    return { id: String(r.id), clientId: String(r.client_id), tripId: str(r.trip_id), label: String(r.source_label), text };
  });
  if (!job) return;
  const finish = (status: "done" | "failed", error: string | null, suggestions: (BriefStatement & { tripSpecific: boolean })[]) =>
    withTenant(db, tenant, async (q) => {
      const claimed = await q.query("update brief_extractions set status = $2, error = $3, finished_at = $4 where id = $1 and status = 'queued' returning id", [
        extractionId,
        status,
        error,
        deps.now().toISOString(),
      ]);
      if (!claimed.rows.length) return;
      for (const [i, s] of suggestions.entries()) {
        await q.query(
          "insert into brief_suggestions (id, workspace_id, extraction_id, client_id, trip_id, dimension, text, evidence, trip_specific, position) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [randomUUID(), tenant.workspaceId, extractionId, job.clientId, s.tripId, s.dimension, s.text, s.evidence, s.tripSpecific, i],
        );
      }
      await audit(q, tenant, `brief.extraction_${status}`, job.clientId, { extractionId, suggestions: suggestions.length }, "agent:brief");
    });
  if (job.text === null) return finish("failed", "Source text was purged under the retention policy", []);
  if (!deps.agentsConfigured()) return finish("failed", "The extraction agent isn't configured", []);
  // Without a trip, "this trip" statements carry an empty trip id here and the expert picks the trip on accept.
  const result = await extractBrief(deps.llm(), job.text, {
    clientId: job.clientId,
    tripId: job.tripId ?? "",
    sourceLabel: job.label,
    now: deps.now(),
    newId: randomUUID,
  });
  if ("error" in result) return finish("failed", result.error, []);
  return finish(
    "done",
    null,
    result.map((s) => ({ ...s, tripId: s.tripId || null, tripSpecific: s.tripId !== null })),
  );
}

/** Accept a suggestion as a brief statement. Agent inferences stay marked as such. */
export async function acceptSuggestion(db: Db, tenant: Tenant, suggestionId: string, now: Date, chosenTripId: string | null = null): Promise<string> {
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const { rows } = await q.query<Record<string, unknown>>(
      "select s.*, e.source_label from brief_suggestions s join brief_extractions e on e.id = s.extraction_id where s.id = $1 and s.status = 'pending' for update of s",
      [suggestionId],
    );
    const s = rows[0];
    if (!s) throw new DomainError("not_found", "That suggestion was already handled");
    await loadClient(q, String(s.client_id));
    let tripId = str(s.trip_id);
    if (s.trip_specific && !tripId) {
      if (!chosenTripId) throw new DomainError("trip_required", "This applies to one trip; choose which");
      await assertTripOfClient(q, String(s.client_id), chosenTripId);
      tripId = chosenTripId;
    }
    const id = randomUUID();
    await insertStatement(q, tenant.workspaceId, {
      id,
      clientId: String(s.client_id),
      tripId,
      dimension: s.dimension as BriefDimension,
      text: String(s.text),
      evidence: s.evidence as BriefStatement["evidence"],
      source: `extracted: ${String(s.source_label)}`,
      recordedAt: now.toISOString(),
      supersededBy: null,
      recordedBy: tenant.memberId,
    });
    await q.query("update brief_suggestions set status = 'accepted', statement_id = $2, decided_by = $3, decided_at = $4 where id = $1", [
      suggestionId,
      id,
      tenant.memberId,
      now.toISOString(),
    ]);
    await audit(q, tenant, "brief.suggestion_accepted", String(s.client_id), { suggestionId, statementId: id, evidence: s.evidence });
    return id;
  });
}

export async function dismissSuggestion(db: Db, tenant: Tenant, suggestionId: string, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    await actor(q, tenant);
    const { rows } = await q.query<{ client_id: string }>(
      "update brief_suggestions set status = 'dismissed', decided_by = $2, decided_at = $3 where id = $1 and status = 'pending' returning client_id",
      [suggestionId, tenant.memberId, now.toISOString()],
    );
    if (!rows[0]) throw new DomainError("not_found", "That suggestion was already handled");
    await audit(q, tenant, "brief.suggestion_dismissed", rows[0].client_id, { suggestionId });
  });
}
