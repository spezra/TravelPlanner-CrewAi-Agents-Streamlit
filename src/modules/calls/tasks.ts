/**
 * Call tasks: creation and routing by relationship, parties and consent,
 * capture mode, and closing. One tenant-bound transaction per operation and an
 * audit event for every consequential step.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { audit, getTrip, listItems } from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { captureDecision, routeCall, type CaptureMode } from "@/domain/calls";
import {
  modeAfterChange,
  noteTemplate,
  normalizeJurisdiction,
  partyRules,
  preCallBrief,
  requestRecordedMode,
  type PartyRule,
  type PreCallBrief,
} from "@/domain/callTasks";
import { DomainError } from "@/domain/common";
import type { TripItem } from "@/domain/bookings";
import { decryptFor } from "@/server/crypto";
import * as calls from "./repo";
import { getCallSettings, type CallSettings } from "./settings";

export interface NewParty {
  name: string;
  jurisdiction: string | null;
  side: "ours" | "theirs";
}

export interface NewCallTask {
  tripId: string | null;
  personId: string | null;
  purpose: string;
  ask: string;
  leverage: string | null;
  fallback: string | null;
  doneWhen: string;
  spendsRelationshipCapital: boolean;
  importance: calls.Importance;
  /** Offer routine calls to disclosed automation. Relationship-capital calls always go to the holder. */
  automationPermitted: boolean;
  scope: "private" | "workspace";
  parties: NewParty[];
}

const required = (v: string, field: string) => {
  if (!v.trim()) throw new DomainError("missing_field", `${field} is required`);
  return v.trim();
};

export async function createCallTask(db: Db, tenant: Tenant, input: NewCallTask, now: Date): Promise<string> {
  const purpose = required(input.purpose, "Purpose");
  const ask = required(input.ask, "The ask");
  const doneWhen = required(input.doneWhen, "What counts as done");
  const parties = input.parties.map((p) => ({ ...p, name: required(p.name, "Party name"), jurisdiction: normalizeJurisdiction(p.jurisdiction) }));
  return withTenant(db, tenant, async (q) => {
    if (input.tripId && !(await getTrip(q, input.tripId))) throw new DomainError("not_found", "Trip not found");
    let holderId = tenant.memberId;
    if (input.personId) {
      const found = await calls.getPersonWithLedger(q, input.personId);
      if (!found) throw new DomainError("not_found", "Contact not found");
      // Asks route through the human who holds the relationship.
      holderId = found.person.ownerId;
    }
    const delegates = input.tripId ? (await calls.tripDelegateIds(q, input.tripId, now)).filter((id) => id !== holderId) : [];
    const routed = routeCall(
      { spendsRelationshipCapital: input.spendsRelationshipCapital },
      { holderId, authorizedDelegateIds: delegates, automationPermitted: input.automationPermitted && !input.spendsRelationshipCapital },
    );
    const id = randomUUID();
    await q.query(
      `insert into call_tasks (id, workspace_id, owner_id, created_by, trip_id, person_id, purpose, ask, leverage, fallback, done_when,
         spends_relationship_capital, importance, automation_permitted, route, assignee_id, disclosure, scope, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id, tenant.workspaceId, holderId, tenant.memberId, input.tripId, input.personId, purpose, ask, input.leverage?.trim() || null,
        input.fallback?.trim() || null, doneWhen, input.spendsRelationshipCapital, input.importance, input.automationPermitted,
        routed.route, routed.assignee, routed.disclosure, input.scope, now.toISOString(),
      ],
    );
    for (const [i, p] of parties.entries()) {
      await calls.insertParty(q, tenant.workspaceId, { id: randomUUID(), taskId: id, name: p.name, jurisdiction: p.jurisdiction, side: p.side, joinedReason: "initial", position: i });
    }
    await audit(q, tenant.workspaceId, tenant.memberId, "call_task.created", id, { route: routed.route, assignee: routed.assignee, scope: input.scope });
    return id;
  });
}

/**
 * Who may work a call: the relationship holder, whoever created or was
 * assigned it, members authorized on its trip, and workspace owners/admins.
 * Row-level security has already hidden private tasks from everyone else.
 */
async function assertCanWork(q: Queryable, tenant: Tenant, task: calls.CallTaskRow, now: Date): Promise<void> {
  const me = tenant.memberId;
  if ([task.ownerId, task.createdBy, task.assigneeId].includes(me)) return;
  const role = await calls.memberRole(q, me);
  if (role === "owner" || role === "admin") return;
  if (task.tripId) {
    const trip = await getTrip(q, task.tripId);
    if (trip?.ownerId === me || (await calls.tripDelegateIds(q, task.tripId, now)).includes(me)) return;
  }
  throw new DomainError("forbidden", "Only the relationship holder, the assignee or someone authorized on this trip can work this call");
}

export async function loadTaskForWork(q: Queryable, tenant: Tenant, taskId: string, now: Date, opts: { open?: boolean } = {}): Promise<calls.CallTaskRow> {
  const task = await calls.getCallTask(q, taskId);
  if (!task) throw new DomainError("not_found", "Call task not found");
  await assertCanWork(q, tenant, task, now);
  if (opts.open && task.status !== "open") throw new DomainError("closed", `This call task is ${task.status}`);
  return task;
}

/** Routine calls can move between the holder, an authorized delegate, and disclosed automation. */
export async function reassignCallTask(db: Db, tenant: Tenant, taskId: string, to: string, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const task = await loadTaskForWork(q, tenant, taskId, now, { open: true });
    if (task.spendsRelationshipCapital) throw new DomainError("holder_only", "This call spends relationship capital, so it stays with the relationship holder");
    const delegates = task.tripId ? await calls.tripDelegateIds(q, task.tripId, now) : [];
    let route: "relationship_holder" | "delegate" | "automated";
    let assignee: string | null;
    let disclosure: string | null = null;
    if (to === "automated") {
      if (!task.automationPermitted) throw new DomainError("automation_not_permitted", "Automation wasn't permitted for this call");
      const r = routeCall(task, { holderId: task.ownerId, authorizedDelegateIds: delegates, automationPermitted: true });
      ({ route, assignee, disclosure } = r);
    } else if (to === task.ownerId) {
      route = "relationship_holder";
      assignee = to;
    } else if (delegates.includes(to)) {
      route = "delegate";
      assignee = to;
    } else {
      throw new DomainError("not_authorized_delegate", "Routine calls go to the relationship holder or a delegate authorized on this trip");
    }
    await q.query("update call_tasks set route = $2, assignee_id = $3, disclosure = $4 where id = $1", [taskId, route, assignee, disclosure]);
    await audit(q, tenant.workspaceId, tenant.memberId, "call_task.reassigned", taskId, { route, assignee });
  });
}

async function reevaluate(q: Queryable, tenant: Tenant, task: calls.CallTaskRow, settings: CallSettings, why: string): Promise<CaptureMode> {
  const parties = await calls.listParties(q, task.id);
  const next = modeAfterChange(task.captureMode, parties, settings.consentTable);
  if (next !== task.captureMode) {
    await q.query("update call_tasks set capture_mode = $2 where id = $1", [task.id, next]);
    await audit(q, tenant.workspaceId, tenant.memberId, "call.capture_downgraded", task.id, { from: task.captureMode, to: next, why });
  }
  return next;
}

/** Log a party's consent: when, who logged it, and how the expert disclosed. */
export async function logConsent(db: Db, tenant: Tenant, input: { taskId: string; partyId: string; method: string | null }, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    await loadTaskForWork(q, tenant, input.taskId, now, { open: true });
    const { rows } = await q.query(
      `update call_parties set consent_logged_at = $3, consent_logged_by = $4, consent_method = $5
        where id = $1 and call_task_id = $2 and consent_logged_at is null returning id`,
      [input.partyId, input.taskId, now.toISOString(), tenant.memberId, input.method?.trim() || null],
    );
    if (!rows.length) throw new DomainError("already_logged", "Consent is already logged for that party");
    await audit(q, tenant.workspaceId, tenant.memberId, "call.consent_logged", input.taskId, { partyId: input.partyId, method: input.method?.trim() || null });
  });
}

/** A party withdrew consent. Recording stops being allowed if their rule requires it. */
export async function withdrawConsent(db: Db, tenant: Tenant, input: { taskId: string; partyId: string }, now: Date): Promise<CaptureMode> {
  return withTenant(db, tenant, async (q) => {
    const task = await loadTaskForWork(q, tenant, input.taskId, now);
    const { rows } = await q.query(
      "update call_parties set consent_logged_at = null, consent_logged_by = null, consent_method = null where id = $1 and call_task_id = $2 returning id",
      [input.partyId, input.taskId],
    );
    if (!rows.length) throw new DomainError("not_found", "Party not found");
    await audit(q, tenant.workspaceId, tenant.memberId, "call.consent_withdrawn", input.taskId, { partyId: input.partyId });
    return reevaluate(q, tenant, task, await getCallSettings(q), "consent withdrawn");
  });
}

/**
 * Someone joined, or the call was transferred to someone new. The mode is
 * re-evaluated under the stricter rule and can only go down.
 */
export async function addParty(
  db: Db,
  tenant: Tenant,
  input: { taskId: string; name: string; jurisdiction: string | null; side: "ours" | "theirs"; reason: "joined" | "transferred" | "initial"; replacesPartyId?: string | null },
  now: Date,
): Promise<CaptureMode> {
  const name = required(input.name, "Party name");
  const jurisdiction = normalizeJurisdiction(input.jurisdiction);
  return withTenant(db, tenant, async (q) => {
    const task = await loadTaskForWork(q, tenant, input.taskId, now, { open: true });
    const existing = await calls.listParties(q, task.id);
    await calls.insertParty(q, tenant.workspaceId, { id: randomUUID(), taskId: task.id, name, jurisdiction, side: input.side, joinedReason: input.reason, position: existing.length });
    if (input.reason === "transferred" && input.replacesPartyId) {
      // The person who handed off stays in the consent evaluation: their voice may already be on the recording.
      await q.query("update call_parties set left_at = $3 where id = $1 and call_task_id = $2 and left_at is null", [input.replacesPartyId, task.id, now.toISOString()]);
    }
    await audit(q, tenant.workspaceId, tenant.memberId, `call.party_${input.reason}`, task.id, { jurisdiction });
    return reevaluate(q, tenant, task, await getCallSettings(q), `party ${input.reason}`);
  });
}

/** Recorded mode only when the system says consent allows it; notes mode is always available. */
export async function setCaptureMode(db: Db, tenant: Tenant, input: { taskId: string; mode: CaptureMode }, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const task = await loadTaskForWork(q, tenant, input.taskId, now, { open: true });
    if (task.captureMode === input.mode) return;
    if (input.mode === "recorded") {
      const settings = await getCallSettings(q);
      requestRecordedMode(await calls.listParties(q, task.id), settings.consentTable);
    }
    await q.query("update call_tasks set capture_mode = $2 where id = $1", [task.id, input.mode]);
    await audit(q, tenant.workspaceId, tenant.memberId, "call.capture_mode_set", task.id, { from: task.captureMode, to: input.mode });
  });
}

/** Every interaction ends as a commitment record, recorded or not. */
export async function closeCallTask(db: Db, tenant: Tenant, input: { taskId: string; status: "done" | "canceled"; outcome: string | null }, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const task = await loadTaskForWork(q, tenant, input.taskId, now, { open: true });
    if (input.status === "done") {
      const { rows } = await q.query<{ n: number }>(
        `select (select count(*) from call_notes where call_task_id = $1 and filed_at is not null)
              + (select count(*) from call_transcripts where call_task_id = $1)
              + (select count(*) from commitments where call_task_id = $1) as n`,
        [task.id],
      );
      if (Number(rows[0]?.n ?? 0) === 0) {
        throw new DomainError("no_record", "Every call ends as a record: file notes, upload a debrief, or enter the commitments before marking it done");
      }
    }
    await q.query("update call_tasks set status = $2, outcome = $3, closed_at = $4 where id = $1", [task.id, input.status, input.outcome?.trim() || null, now.toISOString()]);
    await audit(q, tenant.workspaceId, tenant.memberId, `call_task.${input.status}`, task.id);
  });
}

export interface CallTaskDetail {
  task: calls.CallTaskRow;
  parties: calls.PartyRow[];
  rules: PartyRule[];
  decision: ReturnType<typeof captureDecision>;
  settings: CallSettings;
  brief: PreCallBrief | null;
  personCommitments: calls.CommitmentView[];
  recordings: calls.RecordingRow[];
  transcripts: Omit<calls.TranscriptMeta, "bodyEnc">[];
  draftNote: { id: string | null; body: string };
  filedNotes: { id: string; authorName: string | null; filedAt: string; body: string }[];
  extractions: calls.ExtractionRow[];
  commitments: calls.CommitmentView[];
  items: TripItem[];
  assignable: { id: string; name: string; route: "relationship_holder" | "delegate" }[];
  canWork: boolean;
}

/** Everything the call task page shows, decrypted inside the tenant transaction. */
export async function getCallTaskDetail(db: Db, tenant: Tenant, taskId: string, now: Date): Promise<CallTaskDetail | null> {
  return withTenant(db, tenant, async (q) => {
    const task = await calls.getCallTask(q, taskId);
    if (!task) return null;
    let canWork = true;
    try {
      await assertCanWork(q, tenant, task, now);
    } catch {
      canWork = false;
    }
    const settings = await getCallSettings(q);
    const parties = await calls.listParties(q, task.id);
    const person = task.personId ? await calls.getPersonWithLedger(q, task.personId) : null;
    const brief = person ? preCallBrief(person.person, person.ledger, task, now) : null;
    const personCommitments = person
      ? (await calls.listCommitmentViews(q)).filter((c) => c.promisorPersonId === person.person.id && (c.state === "pending" || c.state === "disputed"))
      : [];
    const notes = await calls.listNotes(q, { taskId: task.id });
    const decrypt = (id: string, body: string) => decryptFor(q, tenant.workspaceId, `call_note:${id}`, body);
    const draft = notes.find((n) => !n.filedAt && n.authorId === tenant.memberId);
    const filedNotes = await Promise.all(
      notes.filter((n) => n.filedAt).map(async (n) => ({ id: n.id, authorName: n.authorName, filedAt: n.filedAt!, body: await decrypt(n.id, n.bodyEnc) })),
    );
    const members = (await q.query<{ id: string; name: string }>("select id, name from members where disabled_at is null")).rows;
    const delegates = task.tripId ? await calls.tripDelegateIds(q, task.tripId, now) : [];
    const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? "—";
    return {
      task,
      parties,
      rules: partyRules(parties, settings.consentTable),
      decision: captureDecision(parties, settings.consentTable),
      settings,
      brief,
      personCommitments,
      recordings: await calls.listRecordings(q, task.id),
      transcripts: (await calls.listTranscripts(q, { taskId: task.id })).map(({ bodyEnc: _omit, ...t }) => t),
      draftNote: draft ? { id: draft.id, body: await decrypt(draft.id, draft.bodyEnc) } : { id: null, body: noteTemplate(task, task.personName) },
      filedNotes,
      extractions: await calls.listExtractions(q, task.id),
      commitments: await calls.listCommitmentViews(q, { callTaskId: task.id }),
      items: task.tripId ? await listItems(q, task.tripId) : [],
      assignable: [
        { id: task.ownerId, name: nameOf(task.ownerId), route: "relationship_holder" as const },
        ...delegates.filter((d) => d !== task.ownerId).map((d) => ({ id: d, name: nameOf(d), route: "delegate" as const })),
      ],
      canWork,
    };
  });
}
