/**
 * Capture: call audio (recorded mode, consent permitting), voice debriefs (the
 * expert's own voice only), notes (no audio at all), and the transcripts made
 * from audio. Audio and transcripts are encrypted with the workspace data key
 * before they are stored; transcription and commitment extraction run on the
 * job queue.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { audit } from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { assertMayStoreCallAudio } from "@/domain/callTasks";
import { DomainError } from "@/domain/common";
import type { TranscriptSegment } from "@/providers/deepgram";
import { decryptBytes, decryptFor, encryptFor } from "@/server/crypto";
import { enqueueAsTenant } from "@/server/jobs/queue";
import type { BlobStore } from "@/server/storage";
import * as calls from "./repo";
import { getCallSettings } from "./settings";
import { loadTaskForWork } from "./tasks";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_TYPES = /^(audio\/[a-z0-9.+-]+|video\/(webm|mp4|quicktime))$/;

export const transcribeJob = (recordingId: string, attempt: number) => ({
  kind: "calls.transcribe",
  payload: { recordingId },
  dedupeKey: `calls.transcribe:${recordingId}:${attempt}`,
});

export const extractJob = (sourceRef: string, attempt: number) => ({
  kind: "calls.extract_commitments",
  payload: { sourceRef },
  dedupeKey: `calls.extract:${sourceRef}:${attempt}`,
});

// Audio ciphertext is bound to its recording, so a blob can't be swapped between records.
const audioContext = (recordingId: string) => `call_audio:${recordingId}`;
export const transcriptContext = (transcriptId: string) => `call_transcript:${transcriptId}`;
export const noteContext = (noteId: string) => `call_note:${noteId}`;

export async function sealAudio(q: Queryable, workspaceId: string, recordingId: string, bytes: Buffer): Promise<Buffer> {
  return Buffer.from(await encryptFor(q, workspaceId, audioContext(recordingId), bytes), "utf8");
}

export async function openAudio(q: Queryable, workspaceId: string, recordingId: string, sealed: Buffer): Promise<Buffer> {
  return decryptBytes(q, workspaceId, audioContext(recordingId), sealed.toString("utf8"));
}

export interface UploadInput {
  taskId: string;
  kind: calls.RecordingKind;
  bytes: Buffer;
  contentType: string;
  /** Voice debriefs: the uploader confirms only their own voice is on it. */
  ownVoiceOnly: boolean;
}

export async function uploadRecording(db: Db, tenant: Tenant, store: BlobStore, input: UploadInput, now: Date): Promise<string> {
  if (input.bytes.length === 0) throw new DomainError("empty_file", "The file is empty");
  if (input.bytes.length > MAX_AUDIO_BYTES) throw new DomainError("too_large", `Audio files are limited to ${MAX_AUDIO_BYTES / 1024 / 1024} MB`);
  const contentType = input.contentType.split(";")[0]!.trim().toLowerCase();
  if (!AUDIO_TYPES.test(contentType)) throw new DomainError("bad_type", "Upload an audio file (mp3, m4a, wav, webm …)");
  if (input.kind === "voice_debrief" && !input.ownVoiceOnly) {
    throw new DomainError("debrief_attestation", "A voice debrief may contain only your own voice. Confirm that before uploading.");
  }
  return withTenant(db, tenant, async (q) => {
    const task = await loadTaskForWork(q, tenant, input.taskId, now);
    if (task.status === "canceled") throw new DomainError("closed", "This call task was canceled");
    if (input.kind === "call_audio") {
      const settings = await getCallSettings(q);
      assertMayStoreCallAudio(task.captureMode, await calls.listParties(q, task.id), settings.consentTable);
    }
    const id = randomUUID();
    const key = `calls/${tenant.workspaceId}/${task.id}/${id}.enc`;
    await q.query(
      `insert into call_recordings (id, workspace_id, call_task_id, kind, blob_key, content_type, byte_size, uploaded_by, uploaded_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, tenant.workspaceId, task.id, input.kind, key, contentType, input.bytes.length, tenant.memberId, now.toISOString()],
    );
    await enqueueAsTenant(q, transcribeJob(id, 1));
    await audit(q, tenant.workspaceId, tenant.memberId, "call.recording_uploaded", task.id, { recordingId: id, kind: input.kind, bytes: input.bytes.length });
    // Stored last: if this fails the row and the job roll back with it.
    await store.put(key, await sealAudio(q, tenant.workspaceId, id, input.bytes), "application/octet-stream");
    return id;
  });
}

/** After a permanent failure (e.g. transcription wasn't configured yet), try again. */
export async function retryTranscription(db: Db, tenant: Tenant, recordingId: string, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const rec = await calls.getRecording(q, recordingId);
    if (!rec) throw new DomainError("not_found", "Recording not found");
    await loadTaskForWork(q, tenant, rec.callTaskId, now);
    if (rec.status !== "failed") throw new DomainError("not_failed", "Only a failed transcription can be retried");
    const attempt = rec.transcribeAttempt + 1;
    await q.query("update call_recordings set status = 'stored', transcribe_attempt = $2, last_error = null where id = $1", [rec.id, attempt]);
    await enqueueAsTenant(q, transcribeJob(rec.id, attempt));
    await audit(q, tenant.workspaceId, tenant.memberId, "call.transcription_retried", rec.callTaskId, { recordingId: rec.id, attempt });
  });
}

/**
 * Notes mode. Saves the caller's draft; filing makes it immutable and queues
 * commitment extraction from exactly that text.
 */
export async function saveNotes(db: Db, tenant: Tenant, input: { taskId: string; noteId: string | null; body: string; file: boolean }, now: Date): Promise<string> {
  const body = input.body.trim();
  if (!body) throw new DomainError("empty_notes", "Notes are empty");
  if (body.length > 50_000) throw new DomainError("too_long", "Notes are limited to 50,000 characters");
  return withTenant(db, tenant, async (q) => {
    const task = await loadTaskForWork(q, tenant, input.taskId, now);
    if (task.status === "canceled") throw new DomainError("closed", "This call task was canceled");
    let id = input.noteId;
    if (id) {
      const [note] = await calls.listNotes(q, { id });
      if (!note || note.callTaskId !== task.id || note.authorId !== tenant.memberId) throw new DomainError("not_found", "Note not found");
      if (note.filedAt) throw new DomainError("filed", "Filed notes can't be edited; start a new note instead");
      await q.query("update call_notes set body_enc = $2, updated_at = $3 where id = $1", [id, await encryptFor(q, tenant.workspaceId, noteContext(id), body), now.toISOString()]);
    } else {
      id = randomUUID();
      await q.query(
        "insert into call_notes (id, workspace_id, call_task_id, author_id, body_enc, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$6)",
        [id, tenant.workspaceId, task.id, tenant.memberId, await encryptFor(q, tenant.workspaceId, noteContext(id), body), now.toISOString()],
      );
    }
    if (input.file) {
      await q.query("update call_notes set filed_at = $2 where id = $1", [id, now.toISOString()]);
      await enqueueAsTenant(q, extractJob(`call_note:${id}`, 1));
      await audit(q, tenant.workspaceId, tenant.memberId, "call.notes_filed", task.id, { noteId: id });
    }
    return id;
  });
}

export interface TranscriptView {
  meta: Omit<calls.TranscriptMeta, "bodyEnc">;
  segments: TranscriptSegment[];
  task: calls.CallTaskRow;
}

export async function getTranscript(db: Db, tenant: Tenant, transcriptId: string): Promise<TranscriptView | null> {
  return withTenant(db, tenant, async (q) => {
    const [t] = await calls.listTranscripts(q, { id: transcriptId });
    if (!t) return null;
    const task = await calls.getCallTask(q, t.callTaskId);
    if (!task) return null;
    const { bodyEnc, ...meta } = t;
    const segments = JSON.parse(await decryptFor(q, tenant.workspaceId, transcriptContext(t.id), bodyEnc)) as TranscriptSegment[];
    return { meta, segments, task };
  });
}

/**
 * A person checked names, amounts, dates and speakers. Speaker labels and
 * segment text may be corrected in the same step. Commitments extracted from
 * this transcript become "checked" too.
 */
export async function verifyTranscript(
  db: Db,
  tenant: Tenant,
  input: { transcriptId: string; checked: boolean; speakers: Record<string, string>; texts: (string | null)[] },
  now: Date,
): Promise<void> {
  if (!input.checked) throw new DomainError("not_checked", "Confirm that names, amounts, dates and speakers were checked");
  await withTenant(db, tenant, async (q) => {
    const [t] = await calls.listTranscripts(q, { id: input.transcriptId });
    if (!t) throw new DomainError("not_found", "Transcript not found");
    await loadTaskForWork(q, tenant, t.callTaskId, now);
    const segments = JSON.parse(await decryptFor(q, tenant.workspaceId, transcriptContext(t.id), t.bodyEnc)) as TranscriptSegment[];
    const corrected = segments.map((s, i) => ({
      ...s,
      speaker: input.speakers[s.speaker]?.trim() || s.speaker,
      text: input.texts[i]?.trim() || s.text,
    }));
    await q.query("update call_transcripts set body_enc = $2, verified_at = $3, verified_by = $4 where id = $1", [
      t.id,
      await encryptFor(q, tenant.workspaceId, transcriptContext(t.id), JSON.stringify(corrected)),
      now.toISOString(),
      tenant.memberId,
    ]);
    await q.query("update commitments set transcript_verified = true where evidence_ref = $1", [`call_transcript:${t.id}`]);
    await audit(q, tenant.workspaceId, tenant.memberId, "call.transcript_verified", t.callTaskId, {
      transcriptId: t.id,
      speakersRenamed: Object.values(input.speakers).filter((v) => v.trim()).length,
      segmentsEdited: corrected.filter((s, i) => s.text !== segments[i]!.text).length,
    });
  });
}

/** Run extraction again for a source whose extraction failed or waited for agents to be configured. */
export async function rerunExtraction(db: Db, tenant: Tenant, input: { taskId: string; sourceRef: string }, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    await loadTaskForWork(q, tenant, input.taskId, now);
    const e = await calls.getExtraction(q, input.sourceRef);
    if (!e || e.callTaskId !== input.taskId) throw new DomainError("not_found", "Nothing to re-run");
    if (e.status === "done") throw new DomainError("already_done", "Commitments were already extracted from this source");
    const attempt = e.attempt + 1;
    await q.query("update call_extractions set attempt = $2, detail = 'queued', updated_at = now() where source_ref = $1", [e.sourceRef, attempt]);
    await enqueueAsTenant(q, extractJob(e.sourceRef, attempt));
    await audit(q, tenant.workspaceId, tenant.memberId, "call.extraction_requeued", input.taskId, { sourceRef: e.sourceRef, attempt });
  });
}
