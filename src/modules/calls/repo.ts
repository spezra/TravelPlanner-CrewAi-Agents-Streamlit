/**
 * Row <-> domain mapping for call tasks and their capture records. Every
 * function takes a tenant-bound Queryable, so row-level security has already
 * decided what is visible.
 */
import type { Queryable } from "@/db/client";
import type { CallParty, CallRoute, CallTask, CaptureMode } from "@/domain/calls";
import type { Commitment, CommitmentState, EvidenceType } from "@/domain/commitments";
import type { Scope } from "@/domain/common";
import type { LedgerEntry, Person } from "@/domain/crm";

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const str = (v: unknown): string | null => (v == null ? null : String(v));

export type Importance = "routine" | "important" | "critical";
export type TaskStatus = "open" | "done" | "canceled";

export interface CallTaskRow extends CallTask {
  ownerId: string;
  ownerName: string;
  createdBy: string;
  importance: Importance;
  automationPermitted: boolean;
  route: CallRoute;
  assigneeId: string | null;
  assigneeName: string | null;
  disclosure: string | null;
  captureMode: CaptureMode;
  status: TaskStatus;
  outcome: string | null;
  scope: Exclude<Scope, "network">;
  createdAt: string;
  closedAt: string | null;
  tripTitle: string | null;
  personName: string | null;
}

const TASK_SELECT = `
  select ct.*, o.name as owner_name, a.name as assignee_name, t.title as trip_title, p.name as person_name
    from call_tasks ct
    join members o on o.id = ct.owner_id
    left join members a on a.id = ct.assignee_id
    left join trips t on t.id = ct.trip_id
    left join people p on p.id = ct.person_id`;

function mapTask(r: Record<string, unknown>): CallTaskRow {
  return {
    id: String(r.id),
    tripId: str(r.trip_id),
    personId: str(r.person_id),
    purpose: String(r.purpose),
    spendsRelationshipCapital: Boolean(r.spends_relationship_capital),
    ask: String(r.ask),
    leverage: str(r.leverage),
    fallback: str(r.fallback),
    doneWhen: String(r.done_when),
    ownerId: String(r.owner_id),
    ownerName: String(r.owner_name),
    createdBy: String(r.created_by),
    importance: r.importance as Importance,
    automationPermitted: Boolean(r.automation_permitted),
    route: r.route as CallRoute,
    assigneeId: str(r.assignee_id),
    assigneeName: str(r.assignee_name),
    disclosure: str(r.disclosure),
    captureMode: r.capture_mode as CaptureMode,
    status: r.status as TaskStatus,
    outcome: str(r.outcome),
    scope: r.scope as CallTaskRow["scope"],
    createdAt: iso(r.created_at)!,
    closedAt: iso(r.closed_at),
    tripTitle: str(r.trip_title),
    // A private person the viewer can't see stays hidden even when the task is visible.
    personName: str(r.person_name),
  };
}

export async function listCallTasks(q: Queryable, filter: { status?: TaskStatus; tripId?: string } = {}): Promise<CallTaskRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) where.push(`ct.status = $${params.push(filter.status)}`);
  if (filter.tripId) where.push(`ct.trip_id = $${params.push(filter.tripId)}`);
  const { rows } = await q.query<Record<string, unknown>>(
    `${TASK_SELECT} ${where.length ? `where ${where.join(" and ")}` : ""} order by ct.status = 'open' desc, ct.created_at desc`,
    params,
  );
  return rows.map(mapTask);
}

export async function getCallTask(q: Queryable, id: string): Promise<CallTaskRow | null> {
  const { rows } = await q.query<Record<string, unknown>>(`${TASK_SELECT} where ct.id = $1`, [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

export interface PartyRow extends CallParty {
  id: string;
  side: "ours" | "theirs";
  joinedReason: "initial" | "joined" | "transferred";
  consentLoggedBy: string | null;
  consentLoggedByName: string | null;
  consentMethod: string | null;
  leftAt: string | null;
}

export async function listParties(q: Queryable, taskId: string): Promise<PartyRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select cp.*, m.name as logged_by_name from call_parties cp left join members m on m.id = cp.consent_logged_by
      where cp.call_task_id = $1 order by cp.position, cp.created_at`,
    [taskId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    jurisdiction: str(r.jurisdiction),
    consentLoggedAt: iso(r.consent_logged_at),
    side: r.side as PartyRow["side"],
    joinedReason: r.joined_reason as PartyRow["joinedReason"],
    consentLoggedBy: str(r.consent_logged_by),
    consentLoggedByName: str(r.logged_by_name),
    consentMethod: str(r.consent_method),
    leftAt: iso(r.left_at),
  }));
}

export async function insertParty(
  q: Queryable,
  workspaceId: string,
  p: { id: string; taskId: string; name: string; jurisdiction: string | null; side: PartyRow["side"]; joinedReason: PartyRow["joinedReason"]; position: number },
): Promise<void> {
  await q.query(
    `insert into call_parties (id, workspace_id, call_task_id, name, jurisdiction, side, joined_reason, position) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [p.id, workspaceId, p.taskId, p.name, p.jurisdiction, p.side, p.joinedReason, p.position],
  );
}

export type RecordingKind = "call_audio" | "voice_debrief";

export interface RecordingRow {
  id: string;
  callTaskId: string;
  kind: RecordingKind;
  blobKey: string | null;
  contentType: string;
  byteSize: number;
  uploadedBy: string;
  uploadedByName: string | null;
  uploadedAt: string;
  status: "stored" | "transcribed" | "failed" | "purged";
  transcribeAttempt: number;
  lastError: string | null;
  purgedAt: string | null;
}

function mapRecording(r: Record<string, unknown>): RecordingRow {
  return {
    id: String(r.id),
    callTaskId: String(r.call_task_id),
    kind: r.kind as RecordingKind,
    blobKey: str(r.blob_key),
    contentType: String(r.content_type),
    byteSize: Number(r.byte_size),
    uploadedBy: String(r.uploaded_by),
    uploadedByName: str(r.uploaded_by_name),
    uploadedAt: iso(r.uploaded_at)!,
    status: r.status as RecordingRow["status"],
    transcribeAttempt: Number(r.transcribe_attempt),
    lastError: str(r.last_error),
    purgedAt: iso(r.purged_at),
  };
}

export async function listRecordings(q: Queryable, taskId: string): Promise<RecordingRow[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select r.*, m.name as uploaded_by_name from call_recordings r left join members m on m.id = r.uploaded_by
      where r.call_task_id = $1 order by r.uploaded_at`,
    [taskId],
  );
  return rows.map(mapRecording);
}

export async function getRecording(q: Queryable, id: string): Promise<RecordingRow | null> {
  const { rows } = await q.query<Record<string, unknown>>("select r.*, null as uploaded_by_name from call_recordings r where r.id = $1", [id]);
  return rows[0] ? mapRecording(rows[0]) : null;
}

export interface TranscriptMeta {
  id: string;
  callTaskId: string;
  recordingId: string | null;
  source: RecordingKind;
  provider: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  createdAt: string;
  bodyEnc: string;
}

export async function listTranscripts(q: Queryable, filter: { taskId?: string; id?: string }): Promise<TranscriptMeta[]> {
  const where = filter.id ? "tr.id = $1" : "tr.call_task_id = $1";
  const { rows } = await q.query<Record<string, unknown>>(
    `select tr.*, m.name as verified_by_name from call_transcripts tr left join members m on m.id = tr.verified_by where ${where} order by tr.created_at`,
    [filter.id ?? filter.taskId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    callTaskId: String(r.call_task_id),
    recordingId: str(r.recording_id),
    source: r.source as RecordingKind,
    provider: String(r.provider),
    verifiedAt: iso(r.verified_at),
    verifiedBy: str(r.verified_by),
    verifiedByName: str(r.verified_by_name),
    createdAt: iso(r.created_at)!,
    bodyEnc: String(r.body_enc),
  }));
}

export interface NoteRecord {
  id: string;
  callTaskId: string;
  authorId: string;
  authorName: string | null;
  bodyEnc: string;
  updatedAt: string;
  filedAt: string | null;
}

export async function listNotes(q: Queryable, filter: { taskId?: string; id?: string }): Promise<NoteRecord[]> {
  const where = filter.id ? "n.id = $1" : "n.call_task_id = $1";
  const { rows } = await q.query<Record<string, unknown>>(
    `select n.*, m.name as author_name from call_notes n left join members m on m.id = n.author_id where ${where} order by n.created_at`,
    [filter.id ?? filter.taskId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    callTaskId: String(r.call_task_id),
    authorId: String(r.author_id),
    authorName: str(r.author_name),
    bodyEnc: String(r.body_enc),
    updatedAt: iso(r.updated_at)!,
    filedAt: iso(r.filed_at),
  }));
}

export interface ExtractionRow {
  sourceRef: string;
  callTaskId: string;
  status: "done" | "manual" | "failed";
  filedCount: number;
  unclearEnc: string | null;
  detail: string | null;
  attempt: number;
}

export async function listExtractions(q: Queryable, taskId: string): Promise<ExtractionRow[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from call_extractions where call_task_id = $1 order by updated_at", [taskId]);
  return rows.map(mapExtraction);
}

export async function getExtraction(q: Queryable, sourceRef: string): Promise<ExtractionRow | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from call_extractions where source_ref = $1", [sourceRef]);
  return rows[0] ? mapExtraction(rows[0]) : null;
}

function mapExtraction(r: Record<string, unknown>): ExtractionRow {
  return {
    sourceRef: String(r.source_ref),
    callTaskId: String(r.call_task_id),
    status: r.status as ExtractionRow["status"],
    filedCount: Number(r.filed_count),
    unclearEnc: str(r.unclear_enc),
    detail: str(r.detail),
    attempt: Number(r.attempt),
  };
}

export async function upsertExtraction(
  q: Queryable,
  workspaceId: string,
  e: { sourceRef: string; callTaskId: string; status: ExtractionRow["status"]; filedCount: number; unclearEnc: string | null; detail: string | null },
): Promise<void> {
  await q.query(
    `insert into call_extractions (workspace_id, source_ref, call_task_id, status, filed_count, unclear_enc, detail) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (workspace_id, source_ref) do update
       set status = excluded.status, filed_count = excluded.filed_count, unclear_enc = coalesce(excluded.unclear_enc, call_extractions.unclear_enc),
           detail = excluded.detail, updated_at = now()`,
    [workspaceId, e.sourceRef, e.callTaskId, e.status, e.filedCount, e.unclearEnc, e.detail],
  );
}

/** Commitments with where they came from, for the commitments page and a call's own list. */
export interface CommitmentView extends Commitment {
  callTaskId: string | null;
  tripTitle: string | null;
  itemTitle: string | null;
  taskPurpose: string | null;
}

export async function listCommitmentViews(q: Queryable, filter: { callTaskId?: string; ids?: string[] } = {}): Promise<CommitmentView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.callTaskId) where.push(`c.call_task_id = $${params.push(filter.callTaskId)}`);
  if (filter.ids) where.push(`c.id = any($${params.push(filter.ids)}::uuid[])`);
  const { rows } = await q.query<Record<string, unknown>>(
    `select c.*, t.title as trip_title, i.title as item_title, ct.purpose as task_purpose
       from commitments c
       left join trips t on t.id = c.trip_id
       left join trip_items i on i.id = c.item_id
       left join call_tasks ct on ct.id = c.call_task_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by c.due_by nulls last, c.promisor`,
    params,
  );
  return rows.map((r) => ({
    id: String(r.id),
    tripId: str(r.trip_id),
    itemId: str(r.item_id),
    promisor: String(r.promisor),
    promisorPersonId: str(r.promisor_person_id),
    promise: String(r.promise),
    conditions: str(r.conditions),
    dueBy: iso(r.due_by),
    evidence: r.evidence as EvidenceType,
    evidenceRef: str(r.evidence_ref),
    state: r.state as CommitmentState,
    transcriptVerified: Boolean(r.transcript_verified),
    confidence: Number(r.confidence),
    consequential: Boolean(r.consequential),
    reviewStatus: r.review_status as Commitment["reviewStatus"],
    recapSentAt: iso(r.recap_sent_at),
    deliveredToTravelerAt: iso(r.delivered_to_traveler_at),
    callTaskId: str(r.call_task_id),
    tripTitle: str(r.trip_title),
    itemTitle: str(r.item_title),
    taskPurpose: str(r.task_purpose),
  }));
}

/** A person visible to the caller, with their ledger. */
export async function getPersonWithLedger(q: Queryable, personId: string): Promise<{ person: Person; ledger: LedgerEntry[] } | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from people where id = $1", [personId]);
  const r = rows[0];
  if (!r) return null;
  const person: Person = {
    id: String(r.id),
    ownerId: String(r.owner_id),
    name: String(r.name),
    roles: r.roles as Person["roles"],
    approach: r.approach as Person["approach"],
    texture: r.texture as string[],
    clientIds: [],
  };
  const ledger = (
    await q.query<Record<string, unknown>>("select * from ledger_entries where person_id = $1 order by at desc", [personId])
  ).rows.map(
    (e): LedgerEntry => ({
      id: String(e.id),
      personId: String(e.person_id),
      kind: e.kind as LedgerEntry["kind"],
      at: iso(e.at)!,
      note: String(e.note),
      askType: str(e.ask_type),
      roomNights: e.room_nights == null ? null : Number(e.room_nights),
      revenueMinor: e.revenue_minor == null ? null : Number(e.revenue_minor),
    }),
  );
  return { person, ledger };
}

export async function memberRole(q: Queryable, memberId: string): Promise<string | null> {
  const { rows } = await q.query<{ role: string }>("select role from members where id = $1 and disabled_at is null", [memberId]);
  return rows[0]?.role ?? null;
}

/** Members who may take a routine call on this trip: unexpired delegates, active. */
export async function tripDelegateIds(q: Queryable, tripId: string, now: Date): Promise<string[]> {
  const { rows } = await q.query<{ member_id: string }>(
    `select d.member_id from trip_delegations d join members m on m.id = d.member_id
      where d.trip_id = $1 and (d.expires_at is null or d.expires_at > $2) and m.disabled_at is null
      order by case d.purpose when 'assistant' then 0 when 'backup' then 1 else 2 end, m.name`,
    [tripId, now.toISOString()],
  );
  return rows.map((r) => r.member_id);
}
