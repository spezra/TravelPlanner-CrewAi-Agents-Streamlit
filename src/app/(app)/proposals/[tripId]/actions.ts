"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/common";
import { requireMember } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { addStyleSample, createBlankProposal, requestDraft, requestShortlist, saveEdit, sendProposal } from "@/modules/proposals/service";

const Id = z.string().uuid();

async function run(tripId: string, fn: () => Promise<unknown>, ok?: string): Promise<never> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    redirect(`/proposals/${tripId}?error=${encodeURIComponent(err.message)}`);
  }
  revalidatePath(`/proposals/${tripId}`);
  redirect(`/proposals/${tripId}${ok ? `?ok=${encodeURIComponent(ok)}` : ""}`);
}

export async function draftAction(form: FormData) {
  const { tenant } = await requireMember(["owner", "advisor", "assistant", "admin"]);
  const tripId = Id.parse(form.get("tripId"));
  return run(tripId, async () => requestDraft(await getDb(), tenant, tripId), "Drafting in the background — refresh in a minute.");
}

export async function blankAction(form: FormData) {
  const { tenant } = await requireMember();
  const tripId = Id.parse(form.get("tripId"));
  return run(tripId, async () => createBlankProposal(await getDb(), tenant, tripId));
}

export async function saveAction(form: FormData) {
  const { tenant } = await requireMember();
  const tripId = Id.parse(form.get("tripId"));
  const sectionBodies: Record<string, { heading: string; body: string }> = {};
  for (const [k, v] of form.entries()) {
    const m = /^section\.(s\d+)\.(heading|body)$/.exec(k);
    if (m) (sectionBodies[m[1]!] ??= { heading: "", body: "" })[m[2] as "heading" | "body"] = String(v);
  }
  return run(tripId, async () =>
    saveEdit(await getDb(), tenant, {
      proposalId: Id.parse(form.get("proposalId")),
      title: String(form.get("title") ?? ""),
      intro: String(form.get("intro") ?? ""),
      closing: String(form.get("closing") ?? ""),
      sectionBodies,
    }),
    "Saved",
  );
}

export async function sendAction(form: FormData) {
  const { tenant } = await requireMember(["owner", "advisor"]);
  const tripId = Id.parse(form.get("tripId"));
  return run(tripId, async () => sendProposal(await getDb(), tenant, Id.parse(form.get("proposalId"))), "Sent to the client portal");
}

export async function styleSampleAction(form: FormData) {
  const { tenant } = await requireMember();
  const tripId = Id.parse(form.get("tripId"));
  return run(tripId, async () => addStyleSample(await getDb(), tenant, String(form.get("body") ?? "")), "Writing sample saved");
}

export async function scoutAction(form: FormData) {
  const { tenant } = await requireMember();
  const tripId = Id.parse(form.get("tripId"));
  return run(tripId, async () => requestShortlist(await getDb(), tenant, tripId, String(form.get("need") ?? "")), "Preparing options — refresh in a minute.");
}
