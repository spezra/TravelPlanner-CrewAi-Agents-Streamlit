import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { StructuredLLM, StructuredRequest, StructuredResult } from "@/agents/llm";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { captureDecision, EXAMPLE_CONSENT_TABLE, type CallParty } from "@/domain/calls";
import { matchesFilter, modeAfterChange, openFavors, parseConsentTable, partyRules, reminderKind, requestRecordedMode } from "@/domain/callTasks";
import { mapDeepgramResponse, transcribe, DeepgramError, type DeepgramResponse } from "@/providers/deepgram";
import { drain, enqueueAsTenant } from "@/server/jobs/queue";
import { MemoryMailer, SYSTEM_FOOTER } from "@/server/mail";
import { MemoryStore } from "@/server/storage";
import { retryTranscription, saveNotes, uploadRecording, verifyTranscript, getTranscript, extractJob } from "@/modules/calls/capture";
import { addManualCommitment, changeCommitmentState, confirmChecked, listCommitmentsFiltered, markDelivered, prepareRecap, sendRecap } from "@/modules/calls/commitments";
import { createHandlers, schedules } from "@/modules/calls/jobs";
import { listCallTasks, listCommitmentViews } from "@/modules/calls/repo";
import { CALLS_DEMO } from "@/modules/calls/seed";
import { getCallSettings, updateCallSettings } from "@/modules/calls/settings";
import { addParty, closeCallTask, createCallTask, getCallTaskDetail, logConsent, reassignCallTask, setCaptureMode, withdrawConsent, type NewCallTask } from "@/modules/calls/tasks";
import { NOW, useDb } from "./helpers/db";

// The first test in a file builds the migrated+seeded snapshot; give it room on a busy machine.
vi.setConfig({ hookTimeout: 60_000 });

const expert = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
const assistant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
const backup = { workspaceId: DEMO.workspace, memberId: DEMO.backup };
const outsider = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };

const getDb = useDb();
let db: Db;
let store: MemoryStore;
let mail: MemoryMailer;
beforeEach(async () => {
  db = getDb();
  store = new MemoryStore();
  mail = new MemoryMailer();
  // Demo call data comes from the main seed (src/db/seed.ts runs seedCalls).
});

function fakeLLM(output: unknown): StructuredLLM & { calls: number } {
  const fake = {
    calls: 0,
    async generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
      fake.calls++;
      if (output && typeof output === "object" && "ok" in output) return output as StructuredResult<z.infer<S>>;
      return { ok: true as const, value: req.schema.parse(output) as z.infer<S> };
    },
  };
  return fake;
}

const DG_OK: DeepgramResponse = {
  metadata: { request_id: "req-1", duration: 42 },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: "…",
            paragraphs: {
              paragraphs: [
                { speaker: 0, start: 0, end: 4, sentences: [{ text: "Rafael, it's Marisol.", start: 0, end: 2 }, { text: "About casita 4.", start: 2, end: 4 }] },
                { speaker: 1, start: 4, end: 9, sentences: [{ text: "Casita 4 is held for the Whitfields until Friday.", start: 4, end: 9 }] },
                { speaker: 1, start: 9, end: 12, sentences: [{ text: "I'll upgrade them at no charge.", start: 9, end: 12 }] },
              ],
            },
          },
        ],
      },
    ],
  },
};

function fakeFetch(responses: (() => Response)[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof globalThis.fetch;
  return { fetch: f, seen };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const EXTRACTED = {
  commitments: [
    { promisor: "Rafael (GM)", promise: "Casita 4 held for the Whitfields", conditions: "Until Friday", due_by: "2026-10-02T17:00:00Z", booking_hint: "Hacienda Tierra Roja", consequential: true, confidence: 0.9, quote: "Casita 4 is held for the Whitfields" },
    { promisor: "Rafael (GM)", promise: "Upgrade at no charge", conditions: null, due_by: null, booking_hint: null, consequential: false, confidence: 0.95, quote: "I'll upgrade them at no charge." },
  ],
  unclear_points: ["Which Friday?"],
};

const baseTask = (over: Partial<NewCallTask> = {}): NewCallTask => ({
  tripId: DEMO.trip,
  personId: DEMO.gm,
  purpose: "Hold casita 4",
  ask: "Hold and upgrade",
  leverage: "Six nights in August",
  fallback: "Casita 3",
  doneWhen: "Written confirmation",
  spendsRelationshipCapital: true,
  importance: "important",
  automationPermitted: false,
  scope: "private",
  parties: [
    { name: "Marisol Vega", jurisdiction: "US-NY", side: "ours" },
    { name: "Rafael Montes", jurisdiction: "us-ca", side: "theirs" },
  ],
  ...over,
});

const AUDIO = Buffer.from("RIFF....WAVEfmt fake-audio-bytes Casita 4 is held");

async function consentAll(taskId: string, who: Tenant = expert) {
  const parties = await withTenant(db, who, (q) => q.query<{ id: string }>("select id from call_parties where call_task_id = $1 and consent_logged_at is null", [taskId]));
  for (const p of parties.rows) await logConsent(db, who, { taskId, partyId: p.id, method: "Said so at the start of the call" }, NOW);
}

describe("consent rules", () => {
  const p = (name: string, jurisdiction: string | null, consent = false): CallParty => ({ name, jurisdiction, consentLoggedAt: consent ? NOW.toISOString() : null });

  it("shows each party's rule, applying the stricter rule to unknown jurisdictions", () => {
    const rules = partyRules([p("A", "US-NY"), p("B", "US-CA"), p("C", null), p("D", "ZZ")], EXAMPLE_CONSENT_TABLE);
    expect(rules.map((r) => [r.name, r.rule, r.known])).toEqual([
      ["A", "one_party", true],
      ["B", "all_party", true],
      ["C", "all_party", false],
      ["D", "all_party", false],
    ]);
  });

  it("records only after consent is logged where all parties must consent", () => {
    expect(() => requestRecordedMode([p("A", "US-NY"), p("B", "US-CA")], EXAMPLE_CONSENT_TABLE)).toThrow(/consent logged for: A, B/);
    expect(requestRecordedMode([p("A", "US-NY", true), p("B", "US-CA", true)], EXAMPLE_CONSENT_TABLE)).toBe("recorded");
    expect(requestRecordedMode([p("A", "US-NY"), p("B", "US-TX")], EXAMPLE_CONSENT_TABLE)).toBe("recorded");
    expect(() => requestRecordedMode([], EXAMPLE_CONSENT_TABLE)).toThrow(/parties/);
  });

  it("a party joining can only downgrade", () => {
    const consented = [p("A", "US-NY", true), p("B", "US-CA", true)];
    expect(modeAfterChange("recorded", [...consented, p("C", "FR")], EXAMPLE_CONSENT_TABLE)).toBe("notes");
    expect(modeAfterChange("notes", [...consented, p("C", "US-NY", true)], EXAMPLE_CONSENT_TABLE)).toBe("notes");
    expect(captureDecision([...consented, p("C", "US-NY", true)], EXAMPLE_CONSENT_TABLE).mode).toBe("recorded");
  });

  it("validates an edited consent table", () => {
    expect(parseConsentTable([{ jurisdiction: " fr ", rule: "all_party" }, { jurisdiction: "", rule: "one_party" }])).toEqual({ FR: "all_party" });
    expect(() => parseConsentTable([{ jurisdiction: "California", rule: "all_party" }])).toThrow(/jurisdiction code/);
    expect(() => parseConsentTable([{ jurisdiction: "FR", rule: "all_party" }, { jurisdiction: "fr", rule: "one_party" }])).toThrow(/twice/);
  });

  it("open favors and reminder timing", () => {
    const e = (kind: "favor_asked" | "favor_granted", daysAgo: number, askType: string) => ({
      id: `${kind}${daysAgo}`, personId: "p", kind, at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), note: "", askType, roomNights: null, revenueMinor: null,
    });
    expect(openFavors([e("favor_asked", 10, "upgrade"), e("favor_granted", 9, "upgrade"), e("favor_asked", 3, "table")], NOW).map((f) => f.entry.askType)).toEqual(["table"]);
    const due = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
    expect(reminderKind({ state: "pending", dueBy: due(5) }, NOW)).toBe("due_soon");
    expect(reminderKind({ state: "pending", dueBy: due(-1) }, NOW)).toBe("overdue");
    expect(reminderKind({ state: "pending", dueBy: due(30) }, NOW)).toBeNull();
    expect(reminderKind({ state: "fulfilled", dueBy: due(-1) }, NOW)).toBeNull();
    expect(matchesFilter({ state: "pending", dueBy: due(-1), reviewStatus: "auto_filed" }, "overdue", NOW)).toBe(true);
  });
});

describe("call tasks", () => {
  it("routes relationship-capital calls to the holder and routine ones to an authorized delegate", async () => {
    // The assistant can't see Rafael (private to Marisol), so can't create a task against him.
    await expect(createCallTask(db, assistant, baseTask(), NOW)).rejects.toThrow(/Contact not found/);
    const id = await createCallTask(db, expert, baseTask(), NOW);
    const detail = (await getCallTaskDetail(db, expert, id, NOW))!;
    expect(detail.task).toMatchObject({ route: "relationship_holder", assigneeId: DEMO.expert, ownerId: DEMO.expert });
    expect(detail.parties.map((x) => x.jurisdiction)).toEqual(["US-NY", "US-CA"]);
    expect(detail.brief?.chip).toMatchObject({ advice: expect.any(String) });
    expect(detail.brief?.openFavors.length).toBeGreaterThan(0);
    await expect(reassignCallTask(db, expert, id, DEMO.backup, NOW)).rejects.toThrow(/relationship capital/);

    const routine = await createCallTask(db, assistant, baseTask({ personId: DEMO.concierge, spendsRelationshipCapital: false, importance: "routine", automationPermitted: true, scope: "workspace" }), NOW);
    const r = (await getCallTaskDetail(db, assistant, routine, NOW))!;
    expect(r.task).toMatchObject({ route: "automated", assigneeId: null });
    expect(r.task.disclosure).toMatch(/automated/);
    await reassignCallTask(db, assistant, routine, DEMO.backup, NOW);
    expect((await getCallTaskDetail(db, assistant, routine, NOW))!.task).toMatchObject({ route: "delegate", assigneeId: DEMO.backup });
    await expect(reassignCallTask(db, assistant, routine, DEMO.assistant, NOW)).rejects.toThrow(/authorized/);
  });

  it("blocks recording until consent is logged for every party, and downgrades when someone joins", async () => {
    const id = await createCallTask(db, expert, baseTask(), NOW);
    await expect(setCaptureMode(db, expert, { taskId: id, mode: "recorded" }, NOW)).rejects.toThrow(/consent logged for: Marisol Vega, Rafael Montes/);
    await expect(uploadRecording(db, expert, store, { taskId: id, kind: "call_audio", bytes: AUDIO, contentType: "audio/wav", ownVoiceOnly: false }, NOW)).rejects.toThrow(/notes mode/);
    expect(store.items.size).toBe(0);

    await consentAll(id);
    const logged = (await getCallTaskDetail(db, expert, id, NOW))!.parties[0]!;
    expect(logged).toMatchObject({ consentLoggedBy: DEMO.expert, consentLoggedByName: "Marisol Vega", consentMethod: "Said so at the start of the call" });
    await setCaptureMode(db, expert, { taskId: id, mode: "recorded" }, NOW);
    await uploadRecording(db, expert, store, { taskId: id, kind: "call_audio", bytes: AUDIO, contentType: "audio/wav", ownVoiceOnly: false }, NOW);

    // A transfer to someone whose consent isn't logged: back to notes, and recording is refused.
    const detail = (await getCallTaskDetail(db, expert, id, NOW))!;
    const mode = await addParty(db, expert, { taskId: id, name: "Front office", jurisdiction: null, side: "theirs", reason: "transferred", replacesPartyId: detail.parties[1]!.id }, NOW);
    expect(mode).toBe("notes");
    await expect(uploadRecording(db, expert, store, { taskId: id, kind: "call_audio", bytes: AUDIO, contentType: "audio/wav", ownVoiceOnly: false }, NOW)).rejects.toThrow(/notes mode/);
    await consentAll(id);
    // Consent logged again, but the downgrade doesn't reverse itself: the expert must switch back explicitly.
    expect((await getCallTaskDetail(db, expert, id, NOW))!.task.captureMode).toBe("notes");
    await setCaptureMode(db, expert, { taskId: id, mode: "recorded" }, NOW);

    const withdrawn = await withdrawConsent(db, expert, { taskId: id, partyId: detail.parties[1]!.id }, NOW);
    expect(withdrawn).toBe("notes");

    // A voice debrief holds only the expert's own voice: allowed in notes mode, but only with that confirmation.
    await expect(uploadRecording(db, expert, store, { taskId: id, kind: "voice_debrief", bytes: AUDIO, contentType: "audio/webm", ownVoiceOnly: false }, NOW)).rejects.toThrow(/own voice/);
    await uploadRecording(db, expert, store, { taskId: id, kind: "voice_debrief", bytes: AUDIO, contentType: "audio/webm", ownVoiceOnly: true }, NOW);
    await expect(uploadRecording(db, expert, store, { taskId: id, kind: "voice_debrief", bytes: AUDIO, contentType: "text/plain", ownVoiceOnly: true }, NOW)).rejects.toThrow(/audio file/);

    const audits = await withTenant(db, expert, (q) => q.query<{ action: string }>("select action from audit_events where subject = $1 order by id", [id]));
    expect(audits.rows.map((a) => a.action)).toEqual(
      expect.arrayContaining(["call_task.created", "call.consent_logged", "call.capture_mode_set", "call.party_transferred", "call.capture_downgraded", "call.consent_withdrawn", "call.recording_uploaded"]),
    );
  });

  it("a call ends as a record before it can be marked done", async () => {
    const id = await createCallTask(db, expert, baseTask(), NOW);
    await expect(closeCallTask(db, expert, { taskId: id, status: "done", outcome: null }, NOW)).rejects.toThrow(/Every call ends as a record/);
    await saveNotes(db, expert, { taskId: id, noteId: null, body: "Rafael agreed to hold casita 4.", file: true }, NOW);
    await closeCallTask(db, expert, { taskId: id, status: "done", outcome: "Held" }, NOW);
    await expect(logConsent(db, expert, { taskId: id, partyId: "00000000-0000-4000-8000-000000000000", method: null }, NOW)).rejects.toThrow(/done/);
  });

  it("notes are encrypted, pre-filled from the task, and immutable once filed", async () => {
    const detail = (await getCallTaskDetail(db, expert, CALLS_DEMO.gmCall, NOW))!;
    expect(detail.draftNote.body).toContain("Our ask: Hold casita 4 and upgrade");
    expect(detail.draftNote.body).toContain("Done when: Rafael confirms casita 4");
    const noteId = await saveNotes(db, expert, { taskId: CALLS_DEMO.gmCall, noteId: null, body: "Secret: casita 4 at USD 1,200", file: false }, NOW);
    const raw = await withSystem(db, (q) => q.query<{ body_enc: string }>("select body_enc from call_notes where id = $1", [noteId]));
    expect(raw.rows[0]!.body_enc).not.toContain("casita");
    await saveNotes(db, expert, { taskId: CALLS_DEMO.gmCall, noteId, body: "Casita 4 held until Friday", file: true }, NOW);
    await expect(saveNotes(db, expert, { taskId: CALLS_DEMO.gmCall, noteId, body: "changed", file: false }, NOW)).rejects.toThrow(/Filed notes/);
    const after = (await getCallTaskDetail(db, expert, CALLS_DEMO.gmCall, NOW))!;
    expect(after.filedNotes.map((n) => n.body)).toEqual(["Casita 4 held until Friday"]);
    expect(after.draftNote.id).toBeNull();
  });
});

describe("deepgram adapter", () => {
  it("maps diarized paragraphs to speaker-labeled turns", () => {
    const t = mapDeepgramResponse(DG_OK);
    expect(t.segments).toEqual([
      { speaker: "Speaker 1", start: 0, end: 4, text: "Rafael, it's Marisol. About casita 4." },
      { speaker: "Speaker 2", start: 4, end: 12, text: "Casita 4 is held for the Whitfields until Friday. I'll upgrade them at no charge." },
    ]);
    expect(t).toMatchObject({ durationSeconds: 42, requestId: "req-1" });
  });

  it("falls back to words with speakers", () => {
    const t = mapDeepgramResponse({
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "hello there yes",
                words: [
                  { word: "hello", punctuated_word: "Hello", start: 0, end: 0.5, speaker: 0 },
                  { word: "there", punctuated_word: "there.", start: 0.5, end: 1, speaker: 0 },
                  { word: "yes", punctuated_word: "Yes.", start: 1.2, end: 1.5, speaker: 1 },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(t.segments.map((s) => `${s.speaker}: ${s.text}`)).toEqual(["Speaker 1: Hello there.", "Speaker 2: Yes."]);
    expect(() => mapDeepgramResponse({ results: { channels: [] } })).toThrow(DeepgramError);
  });

  it("sends the documented request and classifies errors", async () => {
    const { fetch, seen } = fakeFetch([json(DG_OK), json({ err_msg: "busy" }, 503), json({ err_msg: "bad audio" }, 400)]);
    await transcribe(AUDIO, "audio/wav", { apiKey: "dg-key", fetch });
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toEqual({ model: "nova-3", diarize: "true", smart_format: "true", punctuate: "true" });
    expect(seen[0]!.init.headers).toMatchObject({ Authorization: "Token dg-key", "Content-Type": "audio/wav" });
    expect(seen[0]!.init.method).toBe("POST");
    await expect(transcribe(AUDIO, "audio/wav", { apiKey: "k", fetch })).rejects.toMatchObject({ status: 503, retryable: true });
    await expect(transcribe(AUDIO, "audio/wav", { apiKey: "k", fetch })).rejects.toMatchObject({ status: 400, retryable: false });
  });
});

describe("capture pipeline", () => {
  async function recordedTask() {
    const id = await createCallTask(db, expert, baseTask(), NOW);
    await consentAll(id);
    await setCaptureMode(db, expert, { taskId: id, mode: "recorded" }, NOW);
    return id;
  }
  const makeDue = () => withSystem(db, (q) => q.query("update jobs set run_at = now() - interval '1 second' where status = 'queued'"));

  it("encrypts audio, retries a transient Deepgram error, stores an encrypted transcript and extracts commitments", async () => {
    const id = await recordedTask();
    const recId = await uploadRecording(db, expert, store, { taskId: id, kind: "call_audio", bytes: AUDIO, contentType: "audio/wav", ownVoiceOnly: false }, NOW);
    const [blob] = [...store.items.values()];
    expect(blob!.toString("utf8")).not.toContain("Casita");
    expect(blob!.includes(AUDIO)).toBe(false);

    const { fetch, seen } = fakeFetch([json({ err_msg: "overloaded" }, 503), json(DG_OK)]);
    const llm = fakeLLM(EXTRACTED);
    const handlers = createHandlers({ blobs: store, fetch, llm, deepgramKey: "dg-key", mailer: mail, now: () => NOW });

    await drain(db, handlers);
    let rec = await withSystem(db, (q) => q.query<{ status: string; last_error: string | null }>("select status, last_error from call_recordings where id = $1", [recId]));
    expect(rec.rows[0]).toMatchObject({ status: "stored" });
    expect(rec.rows[0]!.last_error).toMatch(/503/);
    const job = await withSystem(db, (q) => q.query<{ status: string; attempts: number }>("select status, attempts from jobs where kind = 'calls.transcribe'"));
    expect(job.rows[0]).toMatchObject({ status: "queued", attempts: 1 });

    await makeDue();
    await drain(db, handlers);
    expect(seen).toHaveLength(2);
    // The audio sent to Deepgram is the decrypted original.
    expect(Buffer.from(seen[1]!.init.body as Uint8Array).equals(AUDIO)).toBe(true);
    rec = await withSystem(db, (q) => q.query("select status, last_error from call_recordings where id = $1", [recId]));
    expect(rec.rows[0]).toMatchObject({ status: "transcribed", last_error: null });

    const raw = await withSystem(db, (q) => q.query<{ id: string; body_enc: string; verified_at: unknown }>("select id, body_enc, verified_at from call_transcripts"));
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]!.body_enc).not.toContain("Whitfields");
    expect(raw.rows[0]!.body_enc).not.toContain("Speaker");
    expect(raw.rows[0]!.verified_at).toBeNull();
    const tid = raw.rows[0]!.id;
    const view = (await getTranscript(db, expert, tid))!;
    expect(view.segments[1]!.text).toContain("held for the Whitfields");

    const filed = await withTenant(db, expert, (q) => listCommitmentViews(q, { callTaskId: id }));
    expect(filed.map((c) => [c.evidence, c.transcriptVerified, c.reviewStatus, c.itemId, c.promisorPersonId])).toEqual([
      ["machine_transcript", false, "needs_review", DEMO.hotelOaxaca, DEMO.gm],
      ["machine_transcript", false, "needs_review", null, DEMO.gm],
    ]);
    expect(filed.every((c) => c.evidenceRef === `call_transcript:${tid}`)).toBe(true);

    // Checking the transcript: speakers renamed, and its commitments become "checked".
    await expect(verifyTranscript(db, expert, { transcriptId: tid, checked: false, speakers: {}, texts: [] }, NOW)).rejects.toThrow(/Confirm/);
    await verifyTranscript(db, expert, { transcriptId: tid, checked: true, speakers: { "Speaker 1": "Marisol Vega", "Speaker 2": "Rafael Montes" }, texts: [] }, NOW);
    const checked = (await getTranscript(db, expert, tid))!;
    expect(checked.segments.map((s) => s.speaker)).toEqual(["Marisol Vega", "Rafael Montes"]);
    expect(checked.meta.verifiedBy).toBe(DEMO.expert);
    expect((await withTenant(db, expert, (q) => listCommitmentViews(q, { callTaskId: id }))).every((c) => c.transcriptVerified)).toBe(true);
  });

  it("marks transcription failed without a key, and retries on request", async () => {
    const id = await recordedTask();
    const recId = await uploadRecording(db, expert, store, { taskId: id, kind: "call_audio", bytes: AUDIO, contentType: "audio/wav", ownVoiceOnly: false }, NOW);
    await drain(db, createHandlers({ blobs: store, llm: null, deepgramKey: null }));
    const rec = await withSystem(db, (q) => q.query<{ status: string; last_error: string }>("select status, last_error from call_recordings where id = $1", [recId]));
    expect(rec.rows[0]!.status).toBe("failed");
    expect(rec.rows[0]!.last_error).toMatch(/DEEPGRAM_API_KEY/);
    await retryTranscription(db, expert, recId, NOW);
    const { fetch } = fakeFetch([json(DG_OK)]);
    await drain(db, createHandlers({ blobs: store, llm: null, deepgramKey: "k", fetch }));
    const after = await withSystem(db, (q) => q.query<{ status: string }>("select status from call_recordings where id = $1", [recId]));
    expect(after.rows[0]!.status).toBe("transcribed");
    // No agents: extraction waits for manual entry instead of failing.
    const ex = await withSystem(db, (q) => q.query<{ status: string }>("select status from call_extractions"));
    expect(ex.rows.map((r) => r.status)).toEqual(["manual"]);
  });

  it("extraction is idempotent per source, including after a crash before its outcome was recorded", async () => {
    const noteId = await saveNotes(db, expert, { taskId: CALLS_DEMO.gmCall, noteId: null, body: "Casita 4 is held for the Whitfields. I'll upgrade them at no charge.", file: true }, NOW);
    const llm = fakeLLM(EXTRACTED);
    const handlers = createHandlers({ blobs: store, llm, deepgramKey: null });
    await drain(db, handlers);
    const count = async () => (await withSystem(db, (q) => q.query("select id from commitments where evidence_ref = $1", [`call_note:${noteId}`]))).rows.length;
    expect(await count()).toBe(2);
    expect(llm.calls).toBe(1);
    const filed = await withTenant(db, expert, (q) => listCommitmentViews(q, { callTaskId: CALLS_DEMO.gmCall }));
    expect(filed.map((c) => c.evidence)).toEqual(["expert_notes", "expert_notes"]);
    expect(filed.map((c) => c.reviewStatus)).toEqual(["needs_review", "auto_filed"]);

    // Same source queued again (a duplicate delivery): nothing new, no model call.
    await withTenant(db, expert, (q) => enqueueAsTenant(q, extractJob(`call_note:${noteId}`, 2)));
    await drain(db, handlers);
    expect(await count()).toBe(2);
    expect(llm.calls).toBe(1);

    // A run that filed but died before recording the outcome: the rerun links and finishes without filing twice.
    await withSystem(db, (q) => q.query("delete from call_extractions"));
    await withSystem(db, (q) => q.query("update commitments set call_task_id = null where evidence_ref = $1", [`call_note:${noteId}`]));
    await withTenant(db, expert, (q) => enqueueAsTenant(q, extractJob(`call_note:${noteId}`, 3)));
    await drain(db, handlers);
    expect(await count()).toBe(2);
    expect(llm.calls).toBe(1);
    const ex = await withSystem(db, (q) => q.query<{ status: string; filed_count: number }>("select status, filed_count from call_extractions"));
    expect(ex.rows[0]).toMatchObject({ status: "done", filed_count: 2 });
    expect((await withTenant(db, expert, (q) => listCommitmentViews(q, { callTaskId: CALLS_DEMO.gmCall }))).length).toBe(2);
  });

  it("a refused extraction is recorded as failed for manual entry", async () => {
    await saveNotes(db, expert, { taskId: CALLS_DEMO.gmCall, noteId: null, body: "Nothing much.", file: true }, NOW);
    await drain(db, createHandlers({ blobs: store, llm: fakeLLM({ ok: false, reason: "refused", detail: "x" }), deepgramKey: null }));
    const ex = await withSystem(db, (q) => q.query<{ status: string; detail: string }>("select status, detail from call_extractions"));
    expect(ex.rows[0]).toMatchObject({ status: "failed", detail: "refused: x" });
  });
});

describe("commitments", () => {
  it("manual entry, transitions, review and delivery", async () => {
    await expect(
      addManualCommitment(db, expert, { callTaskId: CALLS_DEMO.gmCall, tripId: null, itemId: DEMO.hotelCdmx, promisor: "Rafael", promisorPersonId: DEMO.gm, promise: "x", conditions: null, dueBy: null, evidence: "verbal_statement", evidenceRef: null, consequential: false }, NOW),
    ).resolves.toBeTruthy();
    await expect(
      addManualCommitment(db, expert, { callTaskId: null, tripId: DEMO.trip, itemId: "00000000-0000-4000-8000-0000000000e9", promisor: "Rafael", promisorPersonId: null, promise: "x", conditions: null, dueBy: null, evidence: "verbal_statement", evidenceRef: null, consequential: false }, NOW),
    ).rejects.toThrow(/isn't on this trip/);
    const id = await addManualCommitment(
      db,
      expert,
      { callTaskId: CALLS_DEMO.gmCall, tripId: null, itemId: DEMO.hotelOaxaca, promisor: "Rafael Montes (GM)", promisorPersonId: DEMO.gm, promise: "Welcome mezcal tasting", conditions: "Arrival before 18:00", dueBy: "2026-10-01T18:00", evidence: "verbal_statement", evidenceRef: null, consequential: false },
      NOW,
    );
    const [c] = await withTenant(db, expert, (q) => listCommitmentViews(q, { ids: [id] }));
    expect(c).toMatchObject({ tripId: DEMO.trip, callTaskId: CALLS_DEMO.gmCall, reviewStatus: "reviewed", state: "pending", confidence: 1 });

    await changeCommitmentState(db, expert, { id, to: "disputed" });
    await changeCommitmentState(db, expert, { id, to: "pending" });
    await markDelivered(db, expert, id, NOW);
    const [d] = await withTenant(db, expert, (q) => listCommitmentViews(q, { ids: [id] }));
    expect(d).toMatchObject({ state: "fulfilled", deliveredToTravelerAt: NOW.toISOString() });
    await expect(changeCommitmentState(db, expert, { id, to: "canceled" })).rejects.toThrow(/cannot move from fulfilled to canceled/);

    await confirmChecked(db, expert, "00000000-0000-4000-8000-000000000301");
    const [seeded] = await withTenant(db, expert, (q) => listCommitmentViews(q, { ids: ["00000000-0000-4000-8000-000000000301"] }));
    expect(seeded).toMatchObject({ reviewStatus: "reviewed", transcriptVerified: true });
    expect((await listCommitmentsFiltered(db, expert, "needs_review", NOW)).map((x) => x.id)).not.toContain(seeded!.id);
  });

  it("recaps are labeled as the system's record of our understanding; assistants can't send them for someone else's call", async () => {
    const draft = await prepareRecap(db, expert, null, ["00000000-0000-4000-8000-000000000301"]);
    expect(draft.drafted).toBe("template");
    expect(draft.body).toContain("Casita 4 held");
    expect(draft.header).toMatch(/booking system on behalf of Marisol Vega.*our understanding.*not a confirmation of your agreement/);

    const agentDraft = await prepareRecap(db, expert, fakeLLM({ subject: "Casita 4", body: "We understand casita 4 is held." }), ["00000000-0000-4000-8000-000000000301"]);
    expect(agentDraft).toMatchObject({ drafted: "agent", subject: "Casita 4" });

    await expect(sendRecap(db, expert, mail, { ids: ["00000000-0000-4000-8000-000000000301"], to: "not-an-email", subject: "s", body: "b" }, NOW)).rejects.toThrow(/email/);
    await sendRecap(db, expert, mail, { ids: ["00000000-0000-4000-8000-000000000301"], to: "Rafael@Example.com", subject: "Recap", body: "Edited: casita 4 held." }, NOW);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("rafael@example.com");
    expect(mail.sent[0]!.text).toMatch(/^This recap is sent by Marisol Vega Travel's booking system/);
    expect(mail.sent[0]!.text).toContain("Edited: casita 4 held.");
    expect(mail.sent[0]!.text.endsWith(SYSTEM_FOOTER)).toBe(true);
    const [c] = await withTenant(db, expert, (q) => listCommitmentViews(q, { ids: ["00000000-0000-4000-8000-000000000301"] }));
    expect(c!.recapSentAt).toBe(NOW.toISOString());
    const recap = await withSystem(db, (q) => q.query<{ body_enc: string }>("select body_enc from call_recaps"));
    expect(recap.rows[0]!.body_enc).not.toContain("casita");

    await expect(sendRecap(db, assistant, mail, { ids: ["00000000-0000-4000-8000-000000000302"], to: "ines@example.com", subject: "Recap", body: "b" }, NOW)).rejects.toThrow(/Assistants prepare/);
  });

  it("reminds the relationship holder once per commitment per state", async () => {
    const plus = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
    const soon = await addManualCommitment(db, expert, { callTaskId: CALLS_DEMO.gmCall, tripId: null, itemId: null, promisor: "Rafael", promisorPersonId: DEMO.gm, promise: "Send the casita floor plan", conditions: null, dueBy: plus(5), evidence: "verbal_statement", evidenceRef: null, consequential: false }, NOW);
    await addManualCommitment(db, assistant, { callTaskId: CALLS_DEMO.conciergeCall, tripId: null, itemId: null, promisor: "Inés", promisorPersonId: DEMO.concierge, promise: "Confirm amenity", conditions: null, dueBy: plus(-3), evidence: "verbal_statement", evidenceRef: null, consequential: false }, NOW);
    await addManualCommitment(db, expert, { callTaskId: null, tripId: DEMO.trip, itemId: null, promisor: "Rafael", promisorPersonId: null, promise: "Later thing", conditions: null, dueBy: plus(72), evidence: "verbal_statement", evidenceRef: null, consequential: false }, NOW);

    const run = (now: Date) => createHandlers({ mailer: mail, now: () => now })["calls.commitment_reminders"]!({ db, job: { id: 0, kind: "calls.commitment_reminders", payload: {}, workspaceId: null, memberId: null, attempts: 1, maxAttempts: 3 }, tenant: null });
    await run(NOW);
    await run(NOW);
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual(
      expect.arrayContaining([
        ["marisol@example.com", "Commitment due within 24 hours: Rafael"],
        ["marisol@example.com", "Overdue commitment: Inés"], // Inés is Marisol's contact
      ]),
    );
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[0]!.text.endsWith(SYSTEM_FOOTER)).toBe(true);

    // Past due now: one more email for the same commitment in its new state, then silence.
    await run(new Date(NOW.getTime() + 6 * 3_600_000));
    await run(new Date(NOW.getTime() + 7 * 3_600_000));
    expect(mail.sent).toHaveLength(3);
    expect(mail.sent[2]!.subject).toBe("Overdue commitment: Rafael");
    // Fulfilled commitments are never chased.
    await changeCommitmentState(db, expert, { id: soon, to: "fulfilled" });
    const reminders = await withSystem(db, (q) => q.query("select kind from commitment_reminders where commitment_id = $1 order by kind", [soon]));
    expect(reminders.rows).toEqual([{ kind: "due_soon" }, { kind: "overdue" }]);
    expect(schedules.map((s) => [s.kind, s.everyMinutes])).toEqual([
      ["calls.commitment_reminders", 60],
      ["calls.purge_audio", 60],
    ]);
  });
});

describe("retention", () => {
  it("purges raw audio past the retention period and keeps transcripts", async () => {
    const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    const oldRec = await uploadRecording(db, expert, store, { taskId: CALLS_DEMO.gmCall, kind: "voice_debrief", bytes: AUDIO, contentType: "audio/webm", ownVoiceOnly: true }, days(31));
    const newRec = await uploadRecording(db, expert, store, { taskId: CALLS_DEMO.gmCall, kind: "voice_debrief", bytes: AUDIO, contentType: "audio/webm", ownVoiceOnly: true }, days(2));
    const { fetch } = fakeFetch([json(DG_OK), json(DG_OK)]);
    await drain(db, createHandlers({ blobs: store, fetch, deepgramKey: "k", llm: null }));
    expect(store.items.size).toBe(2);

    const purge = (now: Date) => createHandlers({ blobs: store, now: () => now })["calls.purge_audio"]!({ db, job: { id: 0, kind: "calls.purge_audio", payload: {}, workspaceId: null, memberId: null, attempts: 1, maxAttempts: 3 }, tenant: null });
    await purge(NOW);
    await purge(NOW); // idempotent
    const rows = await withSystem(db, (q) => q.query<{ id: string; status: string; blob_key: string | null }>("select id, status, blob_key from call_recordings order by uploaded_at"));
    expect(rows.rows).toEqual([
      { id: oldRec, status: "purged", blob_key: null },
      { id: newRec, status: "transcribed", blob_key: expect.any(String) },
    ]);
    expect(store.items.size).toBe(1);
    const transcripts = await withSystem(db, (q) => q.query("select id from call_transcripts"));
    expect(transcripts.rows).toHaveLength(2);

    // A shorter retention set by an owner applies to existing audio.
    await expect(updateCallSettings(db, assistant, { rules: [], audioRetentionDays: 1 })).rejects.toThrow(/owners and admins/);
    await updateCallSettings(db, expert, { rules: [{ jurisdiction: "US-CA", rule: "all_party" }], audioRetentionDays: 1 });
    await purge(NOW);
    expect(store.items.size).toBe(0);
  });
});

describe("row-level security", () => {
  it("private call tasks and their records are visible only to the holder and members authorized on the trip", async () => {
    await uploadRecording(db, expert, store, { taskId: CALLS_DEMO.gmCall, kind: "voice_debrief", bytes: AUDIO, contentType: "audio/webm", ownVoiceOnly: true }, NOW);
    await saveNotes(db, expert, { taskId: CALLS_DEMO.gmCall, noteId: null, body: "notes", file: true }, NOW);
    await addManualCommitment(db, expert, { callTaskId: CALLS_DEMO.gmCall, tripId: null, itemId: null, promisor: "Rafael", promisorPersonId: DEMO.gm, promise: "Private promise", conditions: null, dueBy: null, evidence: "expert_notes", evidenceRef: null, consequential: false }, NOW);

    const ids = async (who: Tenant) => (await withTenant(db, who, (q) => listCallTasks(q))).map((t) => t.id).sort();
    expect(await ids(expert)).toEqual([CALLS_DEMO.gmCall, CALLS_DEMO.conciergeCall].sort());
    // Lena is the trip's named backup (an unexpired delegation), so she's authorized on the trip.
    expect(await ids(backup)).toEqual([CALLS_DEMO.gmCall, CALLS_DEMO.conciergeCall].sort());
    // Diego can see the (workspace) trip but isn't authorized on it: only the workspace-scoped task.
    expect(await ids(assistant)).toEqual([CALLS_DEMO.conciergeCall]);
    expect(await ids(outsider)).toEqual([]);

    for (const table of ["call_parties", "call_recordings", "call_notes", "call_extractions"]) {
      const seen = await withTenant(db, assistant, (q) => q.query(`select 1 from ${table} where call_task_id = $1`, [CALLS_DEMO.gmCall]));
      expect(seen.rows, table).toEqual([]);
      const theirs = await withTenant(db, outsider, (q) => q.query(`select 1 from ${table}`));
      expect(theirs.rows, table).toEqual([]);
    }
    expect((await withTenant(db, backup, (q) => q.query("select 1 from call_recordings where call_task_id = $1", [CALLS_DEMO.gmCall]))).rows).toHaveLength(1);
    // Commitments from a private call are as private as the call.
    const promises = async (who: Tenant) => (await withTenant(db, who, (q) => listCommitmentViews(q))).map((c) => c.promise);
    expect(await promises(expert)).toContain("Private promise");
    expect(await promises(assistant)).not.toContain("Private promise");
    expect(await promises(outsider)).toEqual([]);
    expect(await getCallTaskDetail(db, assistant, CALLS_DEMO.gmCall, NOW)).toBeNull();
    await expect(saveNotes(db, assistant, { taskId: CALLS_DEMO.gmCall, noteId: null, body: "x", file: false }, NOW)).rejects.toThrow(/not found/);

    // Once the delegation expires, Lena loses the private task.
    await withTenant(db, expert, (q) => q.query("update trip_delegations set expires_at = $2 where trip_id = $1", [DEMO.trip, new Date(Date.now() - 1000).toISOString()]));
    expect(await ids(backup)).toEqual([CALLS_DEMO.conciergeCall]);
  });

  it("call settings: the workspace reads, only owners/admins write, other workspaces see nothing", async () => {
    expect((await withTenant(db, assistant, (q) => getCallSettings(q))).customized).toBe(true);
    const other = await withTenant(db, outsider, (q) => getCallSettings(q));
    expect(other).toMatchObject({ customized: false, audioRetentionDays: 30, consentTable: EXAMPLE_CONSENT_TABLE });
    await expect(
      withTenant(db, assistant, (q) => q.query("update call_settings set audio_retention_days = 5 returning workspace_id")).then((r) => r.rows.length),
    ).resolves.toBe(0);
    await expect(
      withTenant(db, outsider, (q) => q.query("insert into call_settings (workspace_id, consent_table) values ($1, '{}')", [DEMO.workspace])),
    ).rejects.toThrow(/row-level security/);
    await expect(withTenant(db, outsider, (q) => q.query("select 1 from call_tasks"))).resolves.toMatchObject({ rows: [] });
  });
});
