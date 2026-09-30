"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/common";
import { getDb, requireMember } from "@/lib/server";
import { rerunExtraction, retryTranscription, saveNotes, uploadRecording, verifyTranscript } from "@/modules/calls/capture";
import { addManualCommitment } from "@/modules/calls/commitments";
import { updateCallSettings } from "@/modules/calls/settings";
import { addParty, closeCallTask, createCallTask, logConsent, reassignCallTask, setCaptureMode, withdrawConsent } from "@/modules/calls/tasks";
import { blobs } from "@/server/storage";

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);
const optUuid = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .pipe(uuid.nullable());

const fields = (form: FormData) => Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;

const withParam = (path: string, key: string, value: string) => `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

/**
 * Runs a mutation, then redirects: back with ?error= for expected failures (bad input, domain rules),
 * otherwise to `to(result)` or back with an optional ?ok= message.
 */
async function act<T>(back: string, fn: () => Promise<T>, opts: { ok?: string; to?: (result: T) => string } = {}): Promise<never> {
  let error: string | null = null;
  let result: T | undefined;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof DomainError) error = err.message;
    else if (err instanceof z.ZodError) error = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    else throw err;
  }
  revalidatePath("/calls", "layout");
  revalidatePath("/commitments");
  if (error) redirect(withParam(back, "error", error));
  if (opts.to) redirect(opts.to(result as T));
  redirect(opts.ok ? withParam(back, "ok", opts.ok) : back);
}

/** Where to send the user back to; a tampered id falls back to the list. */
const taskPath = (id: string | undefined) => (uuid.safeParse(id).success ? `/calls/${id}` : "/calls");
const taskIdOf = (f: Record<string, string>) => uuid.parse(f.taskId);

const CreateTask = z.object({
  tripId: optUuid,
  personId: optUuid,
  purpose: text(300).min(1, "Purpose is required"),
  ask: text(2000).min(1, "The ask is required"),
  leverage: optText(2000),
  fallback: optText(2000),
  doneWhen: text(1000).min(1, "What counts as done is required"),
  importance: z.enum(["routine", "important", "critical"]),
  scope: z.enum(["private", "workspace"]),
});

export async function createTaskAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await act(
    "/calls/new",
    async () => {
      const input = CreateTask.parse(fields(form));
      const names = form.getAll("partyName").map(String);
      const jurisdictions = form.getAll("partyJurisdiction").map(String);
      const sides = form.getAll("partySide").map(String);
      const parties = names
        .map((name, i) => ({ name: name.trim().slice(0, 200), jurisdiction: jurisdictions[i] ?? "", side: sides[i] === "ours" ? ("ours" as const) : ("theirs" as const) }))
        .filter((p) => p.name);
      return createCallTask(
        await getDb(),
        tenant,
        { ...input, spendsRelationshipCapital: form.get("spendsRelationshipCapital") === "on", automationPermitted: form.get("automationPermitted") === "on", parties },
        new Date(),
      );
    },
    { to: (id) => `/calls/${id}` },
  );
}

export async function reassignAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(taskPath(f.taskId), async () => reassignCallTask(await getDb(), tenant, taskIdOf(f), z.union([z.literal("automated"), uuid]).parse(f.to), new Date()));
}

export async function logConsentAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(taskPath(f.taskId), async () =>
    logConsent(await getDb(), tenant, { taskId: taskIdOf(f), partyId: uuid.parse(f.partyId), method: optText(300).parse(f.method) }, new Date()),
  );
}

export async function withdrawConsentAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(taskPath(f.taskId), async () => withdrawConsent(await getDb(), tenant, { taskId: taskIdOf(f), partyId: uuid.parse(f.partyId) }, new Date()));
}

const AddParty = z.object({
  taskId: uuid,
  name: text(200).min(1, "Name is required"),
  jurisdiction: text(10),
  side: z.enum(["ours", "theirs"]),
  reason: z.enum(["joined", "transferred"]),
  replacesPartyId: optUuid,
});

export async function addPartyAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(taskPath(f.taskId), async () => {
    const input = AddParty.parse(f);
    await addParty(await getDb(), tenant, input, new Date());
  });
}

export async function setModeAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(taskPath(f.taskId), async () => setCaptureMode(await getDb(), tenant, { taskId: taskIdOf(f), mode: z.enum(["notes", "recorded"]).parse(f.mode) }, new Date()));
}

export async function uploadAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(
    taskPath(f.taskId),
    async () => {
      const file = form.get("audio");
      if (!(file instanceof File) || file.size === 0) throw new DomainError("no_file", "Choose an audio file");
      await uploadRecording(
        await getDb(),
        tenant,
        blobs(),
        {
          taskId: taskIdOf(f),
          kind: z.enum(["call_audio", "voice_debrief"]).parse(f.kind),
          bytes: Buffer.from(await file.arrayBuffer()),
          contentType: file.type || "application/octet-stream",
          ownVoiceOnly: f.ownVoiceOnly === "on",
        },
        new Date(),
      );
    },
    { ok: "Uploaded. Transcription is queued." },
  );
}

export async function retryTranscriptionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(taskPath(f.taskId), async () => retryTranscription(await getDb(), tenant, uuid.parse(f.recordingId), new Date()), { ok: "Transcription queued again." });
}

export async function saveNotesAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  const file = f.intent === "file";
  await act(
    taskPath(f.taskId),
    async () => saveNotes(await getDb(), tenant, { taskId: taskIdOf(f), noteId: optUuid.parse(f.noteId), body: text(50_000).parse(f.body ?? ""), file }, new Date()),
    { ok: file ? "Notes filed. Commitments are being extracted." : "Draft saved." },
  );
}

export async function rerunExtractionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(taskPath(f.taskId), async () => rerunExtraction(await getDb(), tenant, { taskId: taskIdOf(f), sourceRef: text(200).parse(f.sourceRef) }, new Date()));
}

export async function verifyTranscriptAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  const ok = uuid.safeParse(f.taskId).success && uuid.safeParse(f.transcriptId).success;
  const back = ok ? `/calls/${f.taskId}/transcripts/${f.transcriptId}` : "/calls";
  await act(
    back,
    async () => {
      const speakers: Record<string, string> = {};
      const from = form.getAll("speakerFrom").map(String);
      form.getAll("speakerTo").forEach((to, i) => {
        if (from[i]) speakers[from[i]!] = String(to).slice(0, 200);
      });
      const texts = form.getAll("segment").map((t) => String(t).slice(0, 20_000));
      await verifyTranscript(await getDb(), tenant, { transcriptId: uuid.parse(f.transcriptId), checked: f.checked === "on", speakers, texts }, new Date());
    },
    { ok: "Transcript marked as checked." },
  );
}

const ManualCommitmentForm = z.object({
  callTaskId: optUuid,
  tripId: optUuid,
  itemId: optUuid,
  promisor: text(200).min(1, "Who promised is required"),
  promise: text(2000).min(1, "The promise is required"),
  conditions: optText(2000),
  dueBy: optText(40),
  evidence: z.enum(["verbal_statement", "machine_transcript", "expert_notes", "written_confirmation"]),
  evidenceRef: optText(200),
});

export async function addCommitmentAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  const back = f.callTaskId ? taskPath(f.callTaskId) : "/commitments";
  await act(
    back,
    async () => {
      const input = ManualCommitmentForm.parse(f);
      await addManualCommitment(await getDb(), tenant, { ...input, promisorPersonId: optUuid.parse(f.promisorPersonId), consequential: f.consequential === "on" }, new Date());
    },
    { ok: "Commitment recorded." },
  );
}

export async function closeTaskAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = fields(form);
  await act(taskPath(f.taskId), async () =>
    closeCallTask(await getDb(), tenant, { taskId: taskIdOf(f), status: z.enum(["done", "canceled"]).parse(f.status), outcome: optText(2000).parse(f.outcome) }, new Date()),
  );
}

export async function updateSettingsAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "admin"]);
  await act(
    "/calls/settings",
    async () => {
      const jurisdictions = form.getAll("jurisdiction").map(String);
      const rules = form.getAll("rule").map(String);
      const days = z.coerce.number().int().min(1).max(3650).parse(form.get("audioRetentionDays"));
      await updateCallSettings(await getDb(), tenant, { rules: jurisdictions.map((jurisdiction, i) => ({ jurisdiction, rule: rules[i] ?? "all_party" })), audioRetentionDays: days });
    },
    { ok: "Call settings saved." },
  );
}
