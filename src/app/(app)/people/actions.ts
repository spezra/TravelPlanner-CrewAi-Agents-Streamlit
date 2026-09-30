"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { agentsConfigured, ClaudeLLM } from "@/agents/llm";
import { getDb, requireMember } from "@/lib/server";
import { expectedError, field, lines, optionalField, safeBack, withParam } from "@/modules/crm/forms";
import {
  ChipAdviceError,
  createPerson,
  deleteLedgerEntry,
  deletePerson,
  discardDraft,
  dismissNotice,
  draftNote,
  logLedgerEntry,
  recordPersonMove,
  setClientTie,
  updatePerson,
} from "@/modules/crm/people";

const Id = z.string().uuid();

function approachFrom(form: FormData) {
  return {
    channel: optionalField(form, "channel"),
    timeZone: optionalField(form, "timeZone"),
    language: optionalField(form, "language"),
    boss: optionalField(form, "boss"),
    goingOverTheirHeadAcceptable: form.get("overHead") === "on",
  };
}

export async function createPersonAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  let id: string | null = null;
  let error: string | null = null;
  try {
    const org = optionalField(form, "organization");
    id = await createPerson(
      await getDb(),
      tenant,
      {
        name: field(form, "name"),
        scope: field(form, "scope") === "workspace" ? "workspace" : "private",
        emails: lines(field(form, "emails"), /[\s,;]+/),
        approach: approachFrom(form),
        role: org
          ? { organization: org, title: field(form, "title"), measuredOn: optionalField(form, "measuredOn"), from: field(form, "from") || new Date().toISOString().slice(0, 10) }
          : null,
        texture: lines(field(form, "texture")),
      },
      new Date(),
    );
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath("/people");
  redirect(error ? withParam("/people", "error", error) + "#new" : `/people/${id}`);
}

export async function updatePersonAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "personId"));
  let error: string | null = null;
  try {
    await updatePerson(
      await getDb(),
      tenant,
      id,
      {
        name: field(form, "name"),
        scope: field(form, "scope") === "workspace" ? "workspace" : "private",
        emails: lines(field(form, "emails"), /[\s,;]+/),
        approach: approachFrom(form),
        // Only the holder's form carries texture; others' updates leave it untouched.
        texture: form.has("texture") ? lines(field(form, "texture")) : undefined,
      },
      new Date(),
    );
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath(`/people/${id}`);
  redirect(withParam(`/people/${id}`, error ? "error" : "ok", error ?? "Saved"));
}

export async function deletePersonAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "personId"));
  let error: string | null = null;
  try {
    await deletePerson(await getDb(), tenant, id);
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath("/people");
  redirect(error ? withParam(`/people/${id}`, "error", error) : withParam("/people", "ok", "Deleted"));
}

export async function recordMoveAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "personId"));
  let msg: string;
  let error: string | null = null;
  try {
    const r = await recordPersonMove(
      await getDb(),
      tenant,
      id,
      { organization: field(form, "organization"), title: field(form, "title"), measuredOn: optionalField(form, "measuredOn"), from: field(form, "from") },
      new Date(),
    );
    msg = `${r.newDoor}${r.flagged ? ` ${r.flagged} knowledge item${r.flagged > 1 ? "s" : ""} flagged for review.` : ""}`;
  } catch (err) {
    error = expectedError(err);
    msg = "";
  }
  revalidatePath(`/people/${id}`);
  redirect(withParam(`/people/${id}`, error ? "error" : "ok", error ?? msg));
}

export async function clientTieAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "personId"));
  let error: string | null = null;
  try {
    await setClientTie(await getDb(), tenant, {
      personId: id,
      clientId: Id.parse(field(form, "clientId")),
      note: field(form, "note"),
      remove: form.get("remove") === "1",
    });
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath(`/people/${id}`);
  redirect(error ? withParam(`/people/${id}`, "error", error) : `/people/${id}#clients`);
}

export async function logLedgerAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "personId"));
  const kind = field(form, "kind");
  const importance = optionalField(form, "importance");
  const nights = optionalField(form, "roomNights");
  const revenue = optionalField(form, "revenue");
  let target: string;
  try {
    const r = await logLedgerEntry(
      await getDb(),
      tenant,
      {
        personId: id,
        kind: kind as never,
        at: field(form, "at") || new Date().toISOString(),
        note: field(form, "note"),
        askType: optionalField(form, "askType"),
        importance: importance as never,
        roomNights: nights ? Number(nights) : null,
        revenueMinor: revenue ? Math.round(Number(revenue.replace(/,/g, "")) * 100) : null,
        acknowledgeAdvice: form.get("acknowledgeAdvice") === "on",
      },
      new Date(),
    );
    target = withParam(`/people/${id}`, "ok", r.advice && r.advice.advice !== "ask" ? `Logged against advice: ${r.advice.reason}` : "Logged");
  } catch (err) {
    if (err instanceof ChipAdviceError) {
      // Send the member back to the form with the advice and the ask they typed, to confirm or reconsider.
      const params = new URLSearchParams({
        advice: err.advice.advice,
        reason: err.advice.reason,
        askType: field(form, "askType"),
        importance: importance ?? "",
        note: field(form, "note"),
      });
      target = `/people/${id}?${params.toString()}#ledger`;
    } else {
      target = withParam(`/people/${id}`, "error", expectedError(err)) + "#ledger";
    }
  }
  revalidatePath(`/people/${id}`);
  redirect(target);
}

export async function deleteLedgerAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "personId"));
  let error: string | null = null;
  try {
    await deleteLedgerEntry(await getDb(), tenant, Id.parse(field(form, "entryId")));
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath(`/people/${id}`);
  redirect(error ? withParam(`/people/${id}`, "error", error) : `/people/${id}#ledger`);
}

const NudgeKind = z.enum(["recognition_overdue", "moved_role", "going_cold"]);

export async function draftNoteAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "personId"));
  let error: string | null = null;
  try {
    await draftNote(await getDb(), tenant, id, NudgeKind.parse(field(form, "nudgeKind")), agentsConfigured() ? new ClaudeLLM() : null, new Date());
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath(`/people/${id}`);
  redirect(error ? withParam(`/people/${id}`, "error", error) : `/people/${id}#drafts`);
}

export async function discardDraftAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "personId"));
  await discardDraft(await getDb(), tenant, Id.parse(field(form, "draftId")));
  revalidatePath(`/people/${id}`);
  redirect(`/people/${id}#drafts`);
}

export async function dismissNoticeAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await dismissNotice(await getDb(), tenant, Id.parse(field(form, "noticeId")), new Date());
  const back = safeBack(field(form, "back"), "/people");
  revalidatePath(back);
  redirect(back);
}
