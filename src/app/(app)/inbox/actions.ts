"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, requireMember } from "@/lib/server";
import { expectedError, field, optionalField, safeBack, withParam } from "@/modules/crm/forms";
import { acceptSuggestion, dismissSuggestions, requeueParse } from "@/modules/crm/inbound";

const Id = z.string().uuid();

export async function acceptSuggestionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = safeBack(field(form, "back"), "/inbox");
  let error: string | null = null;
  try {
    const itemId = optionalField(form, "itemId");
    const personId = optionalField(form, "personId");
    await acceptSuggestion(await getDb(), tenant, Id.parse(field(form, "suggestionId")), { itemId, personId }, new Date());
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath("/inbox", "layout");
  revalidatePath("/", "layout");
  redirect(withParam(back, error ? "error" : "ok", error ?? "Applied"));
}

export async function dismissSuggestionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = safeBack(field(form, "back"), "/inbox");
  await dismissSuggestions(await getDb(), tenant, [Id.parse(field(form, "suggestionId"))], new Date());
  revalidatePath("/inbox", "layout");
  redirect(back);
}

export async function reparseAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = Id.parse(field(form, "messageId"));
  let error: string | null = null;
  try {
    await requeueParse(await getDb(), tenant, id, new Date());
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath(`/inbox/${id}`);
  redirect(withParam(`/inbox/${id}`, error ? "error" : "ok", error ?? "Queued for another read"));
}
