/**
 * Background work for calls: transcription, commitment extraction, reminders
 * and raw-audio retention. Every handler is idempotent: a job can run more
 * than once (a worker can die after the work but before marking it done).
 */
import { randomUUID } from "node:crypto";
import { extractCommitments, type CommitmentDraft } from "@/agents/commitmentExtractor";
import { audit, listItems } from "@/db/repo";
import { withSystem, withTenant } from "@/db/tenant";
import { evidenceForSource, reminderKind } from "@/domain/callTasks";
import { DeepgramError, transcribe, type TranscriptSegment } from "@/providers/deepgram";
import { config } from "@/server/config";
import { decryptFor, encryptFor } from "@/server/crypto";
import { enqueueAsTenant, PermanentJobError, type JobHandler } from "@/server/jobs/queue";
import type { Schedule } from "@/server/jobs/scheduler";
import { log } from "@/server/log";
import { SYSTEM_FOOTER } from "@/server/mail";
import { fileCommitments } from "@/services/operations";
import { extractJob, noteContext, openAudio, transcriptContext } from "./capture";
import { defaultDeps, type CallDeps } from "./deps";
import * as calls from "./repo";

const MANUAL_DETAIL = "Agents aren't configured, so nothing was extracted automatically. Enter the commitments by hand.";

export function createHandlers(overrides: Partial<CallDeps> = {}): Record<string, JobHandler> {
  const deps = () => defaultDeps(overrides);

  const transcribeHandler: JobHandler = async ({ db, job, tenant }) => {
    if (!tenant) throw new PermanentJobError("calls.transcribe needs a tenant");
    const recordingId = String(job.payload.recordingId ?? "");
    const d = deps();

    const loaded = await withTenant(db, tenant, async (q) => {
      const rec = await calls.getRecording(q, recordingId);
      if (!rec) return { skip: "recording not visible or deleted" } as const;
      if (rec.status === "transcribed" || rec.status === "purged") return { skip: rec.status } as const;
      const existing = await q.query<{ id: string }>("select id from call_transcripts where recording_id = $1", [rec.id]);
      if (existing.rows[0]) {
        await q.query("update call_recordings set status = 'transcribed', last_error = null where id = $1", [rec.id]);
        return { skip: "already transcribed" } as const;
      }
      if (!rec.blobKey) return { skip: "no audio" } as const;
      const audio = await openAudio(q, tenant.workspaceId, rec.id, await d.blobs.get(rec.blobKey));
      return { rec, audio } as const;
    });
    if ("skip" in loaded) return;
    const { rec, audio } = loaded;

    const markFailed = (message: string, final: boolean) =>
      withTenant(db, tenant, (q) =>
        q.query("update call_recordings set status = $2, last_error = $3 where id = $1 and status = 'stored'", [rec.id, final ? "failed" : "stored", message.slice(0, 500)]),
      );

    if (!d.deepgramKey) {
      await markFailed("Transcription isn't configured (DEEPGRAM_API_KEY). Retry once it is.", true);
      throw new PermanentJobError("DEEPGRAM_API_KEY is not configured");
    }
    let result;
    try {
      result = await transcribe(audio, rec.contentType, { apiKey: d.deepgramKey, fetch: d.fetch, diarize: rec.kind === "call_audio" });
    } catch (err) {
      const e = err instanceof DeepgramError ? err : new DeepgramError(err instanceof Error ? err.message : String(err), null, true);
      const final = !e.retryable || job.attempts >= job.maxAttempts;
      await markFailed(e.message, final);
      throw e.retryable ? e : new PermanentJobError(e.message);
    }

    await withTenant(db, tenant, async (q) => {
      const id = randomUUID();
      const inserted = await q.query<{ id: string }>(
        `insert into call_transcripts (id, workspace_id, call_task_id, recording_id, source, body_enc, provider)
         values ($1,$2,$3,$4,$5,$6,'deepgram') on conflict (recording_id) where recording_id is not null do nothing returning id`,
        [id, tenant.workspaceId, rec.callTaskId, rec.id, rec.kind, await encryptFor(q, tenant.workspaceId, transcriptContext(id), JSON.stringify(result.segments))],
      );
      const transcriptId =
        inserted.rows[0]?.id ?? (await q.query<{ id: string }>("select id from call_transcripts where recording_id = $1", [rec.id])).rows[0]!.id;
      await q.query("update call_recordings set status = 'transcribed', last_error = null where id = $1", [rec.id]);
      await enqueueAsTenant(q, extractJob(`call_transcript:${transcriptId}`, 1));
      await audit(q, tenant.workspaceId, "agent:transcription", "call.transcribed", rec.callTaskId, {
        transcriptId,
        segments: result.segments.length,
        durationSeconds: result.durationSeconds,
      });
    });
  };

  const extractHandler: JobHandler = async ({ db, job, tenant }) => {
    if (!tenant) throw new PermanentJobError("calls.extract_commitments needs a tenant");
    const sourceRef = String(job.payload.sourceRef ?? "");
    const m = /^(call_transcript|call_note):([0-9a-f-]{36})$/.exec(sourceRef);
    if (!m) throw new PermanentJobError(`Bad source ref ${sourceRef}`);
    const [, kind, sourceId] = m as unknown as [string, "call_transcript" | "call_note", string];
    const d = deps();

    const prepared = await withTenant(db, tenant, async (q) => {
      const done = await calls.getExtraction(q, sourceRef);
      if (done?.status === "done") return null;
      let taskId: string;
      let text: string;
      let source: "call_audio" | "voice_debrief" | "notes";
      let verified = false;
      if (kind === "call_transcript") {
        const [t] = await calls.listTranscripts(q, { id: sourceId });
        if (!t) throw new PermanentJobError("Transcript not visible or deleted");
        const segments = JSON.parse(await decryptFor(q, tenant.workspaceId, transcriptContext(t.id), t.bodyEnc)) as TranscriptSegment[];
        taskId = t.callTaskId;
        text = segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
        source = t.source;
        verified = Boolean(t.verifiedAt);
      } else {
        const [n] = await calls.listNotes(q, { id: sourceId });
        if (!n?.filedAt) throw new PermanentJobError("Note not visible, deleted or not filed");
        taskId = n.callTaskId;
        text = await decryptFor(q, tenant.workspaceId, noteContext(n.id), n.bodyEnc);
        source = "notes";
      }
      // Filed by an earlier run that died before recording its outcome: link and finish.
      const already = await q.query<{ n: number }>("select count(*)::int as n from commitments where evidence_ref = $1", [sourceRef]);
      if (Number(already.rows[0]?.n) > 0) {
        await q.query("update commitments set call_task_id = $2 where evidence_ref = $1 and call_task_id is null", [sourceRef, taskId]);
        await calls.upsertExtraction(q, tenant.workspaceId, { sourceRef, callTaskId: taskId, status: "done", filedCount: Number(already.rows[0]!.n), unclearEnc: null, detail: null });
        return null;
      }
      if (!d.llm) {
        await calls.upsertExtraction(q, tenant.workspaceId, { sourceRef, callTaskId: taskId, status: "manual", filedCount: 0, unclearEnc: null, detail: MANUAL_DETAIL });
        return null;
      }
      const task = (await calls.getCallTask(q, taskId))!;
      const items = task.tripId ? await listItems(q, task.tripId) : [];
      return { task, text, source, verified, items };
    });
    if (!prepared) return;
    const { task, text, source, verified, items } = prepared;

    const resolveItem = (hint: string | null) => {
      if (!hint) return null;
      const h = hint.toLowerCase();
      const hit = items.filter((i) => [i.title, i.supplierName ?? ""].some((s) => s && (s.toLowerCase().includes(h) || h.includes(s.toLowerCase()))));
      return hit.length === 1 ? hit[0]!.id : null;
    };
    const evidence = evidenceForSource(source);
    const out = await extractCommitments(d.llm!, text, { tripId: task.tripId, evidence, evidenceRef: sourceRef, resolveItem });
    if ("error" in out) {
      await withTenant(db, tenant, (q) =>
        calls.upsertExtraction(q, tenant.workspaceId, { sourceRef, callTaskId: task.id, status: "failed", filedCount: 0, unclearEnc: null, detail: out.error.slice(0, 500) }),
      );
      // A refusal or unusable output won't change on retry; the expert enters commitments by hand.
      throw new PermanentJobError(`Extraction failed: ${out.error}`);
    }
    const firstName = task.personName?.split(/\s+/)[0]?.toLowerCase() ?? null;
    const drafts = out.drafts.map(
      (c): Omit<CommitmentDraft, "reviewStatus"> => ({
        ...c,
        transcriptVerified: evidence === "machine_transcript" && verified,
        promisorPersonId: firstName && task.personId && c.promisor.toLowerCase().includes(firstName) ? task.personId : null,
      }),
    );
    const filed = drafts.length ? await fileCommitments(db, tenant, drafts) : [];

    await withTenant(db, tenant, async (q) => {
      await q.query("update commitments set call_task_id = $2 where evidence_ref = $1 and call_task_id is null", [sourceRef, task.id]);
      await calls.upsertExtraction(q, tenant.workspaceId, {
        sourceRef,
        callTaskId: task.id,
        status: "done",
        filedCount: filed.length,
        unclearEnc: out.unclear.length ? await encryptFor(q, tenant.workspaceId, `call_extraction:${sourceRef}`, JSON.stringify(out.unclear)) : null,
        detail: null,
      });
      await audit(q, tenant.workspaceId, "agent:commitments", "call.commitments_extracted", task.id, {
        sourceRef,
        filed: filed.length,
        needsReview: filed.filter((c) => c.reviewStatus === "needs_review").length,
      });
    });
  };

  /** Email the relationship holder once per commitment when it is due within 24h, and once when it is overdue. */
  const remindersHandler: JobHandler = async ({ db }) => {
    const d = deps();
    const now = d.now();
    const horizon = new Date(now.getTime() + 24 * 3_600_000).toISOString();
    const due = await withSystem(db, (q) =>
      q.query<{ id: string; workspace_id: string; state: string; due_by: Date | string; promisor: string; promise: string; trip_title: string | null; holder: string | null }>(
        `select c.id, c.workspace_id, c.state, c.due_by, c.promisor, c.promise, t.title as trip_title,
                coalesce(pp.owner_id, tp.owner_id, ct.owner_id, t.owner_id) as holder
           from commitments c
           left join people pp on pp.id = c.promisor_person_id
           left join call_tasks ct on ct.id = c.call_task_id
           left join people tp on tp.id = ct.person_id
           left join trips t on t.id = c.trip_id
          where c.state = 'pending' and c.due_by is not null and c.due_by <= $1
            and not exists (select 1 from commitment_reminders r where r.commitment_id = c.id
                              and r.kind = case when c.due_by <= $2 then 'overdue' else 'due_soon' end)`,
        [horizon, now.toISOString()],
      ),
    );
    let sent = 0;
    for (const c of due.rows) {
      const dueBy = c.due_by instanceof Date ? c.due_by.toISOString() : new Date(c.due_by).toISOString();
      const kind = reminderKind({ state: "pending", dueBy }, now);
      if (!kind) continue;
      // One transaction per commitment: the reminder row and the email succeed or fail together.
      await withSystem(db, async (q) => {
        const member = c.holder
          ? (await q.query<{ id: string; email: string; name: string }>("select id, email, name from members where id = $1 and disabled_at is null", [c.holder])).rows[0]
          : undefined;
        const claimed = await q.query("insert into commitment_reminders (workspace_id, commitment_id, kind, sent_to, sent_at) values ($1,$2,$3,$4,$5) on conflict do nothing returning commitment_id", [
          c.workspace_id,
          c.id,
          kind,
          member?.id ?? null,
          now.toISOString(),
        ]);
        if (!claimed.rows.length || !member) return;
        const when = kind === "overdue" ? `was due ${dueBy.slice(0, 16).replace("T", " ")} UTC and is still pending` : `is due ${dueBy.slice(0, 16).replace("T", " ")} UTC`;
        await d.mailer.send({
          to: member.email,
          subject: kind === "overdue" ? `Overdue commitment: ${c.promisor}` : `Commitment due within 24 hours: ${c.promisor}`,
          text:
            `${c.promisor} promised: ${c.promise}\n` +
            `${c.trip_title ? `Trip: ${c.trip_title}\n` : ""}` +
            `It ${when}.\n\nReview it: ${config().APP_URL}/commitments?filter=${kind === "overdue" ? "overdue" : "pending"}${SYSTEM_FOOTER}`,
        });
        await audit(q, c.workspace_id, "system:reminders", `commitment.reminder_${kind}`, c.id, { to: member.id });
        sent++;
      });
    }
    log.info({ candidates: due.rows.length, sent }, "commitment reminders");
  };

  /** Delete raw audio past the workspace's retention period. Transcripts stay. */
  const purgeHandler: JobHandler = async ({ db }) => {
    const d = deps();
    const now = d.now();
    const { rows } = await withSystem(db, (q) =>
      q.query<{ id: string; workspace_id: string; call_task_id: string; blob_key: string | null }>(
        `select r.id, r.workspace_id, r.call_task_id, r.blob_key
           from call_recordings r left join call_settings s on s.workspace_id = r.workspace_id
          where r.purged_at is null
            and r.uploaded_at <= $1::timestamptz - make_interval(days => coalesce(s.audio_retention_days, 30))
          order by r.uploaded_at limit 500`,
        [now.toISOString()],
      ),
    );
    for (const r of rows) {
      // Blob first: if the update fails, the next run deletes again (a no-op) and records it.
      if (r.blob_key) await d.blobs.delete(r.blob_key);
      await withSystem(db, async (q) => {
        await q.query("update call_recordings set status = 'purged', blob_key = null, purged_at = $2 where id = $1 and purged_at is null", [r.id, now.toISOString()]);
        await audit(q, r.workspace_id, "system:retention", "call.audio_purged", r.call_task_id, { recordingId: r.id });
      });
    }
    if (rows.length) log.info({ purged: rows.length }, "purged raw call audio");
  };

  return {
    "calls.transcribe": transcribeHandler,
    "calls.extract_commitments": extractHandler,
    "calls.commitment_reminders": remindersHandler,
    "calls.purge_audio": purgeHandler,
  };
}

export const handlers: Record<string, JobHandler> = createHandlers();

export const schedules: Schedule[] = [
  { kind: "calls.commitment_reminders", everyMinutes: 60 },
  { kind: "calls.purge_audio", everyMinutes: 60 },
];

