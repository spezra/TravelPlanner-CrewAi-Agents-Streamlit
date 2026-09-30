"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, requireMember } from "@/lib/server";
import { expectedError, withParam } from "@/modules/crm/forms";
import { disconnectGoogle, googleClientFromConfig } from "@/modules/crm/google";
import { acceptSuggestions, dismissSuggestions, rotateInboundRoute } from "@/modules/crm/inbound";

export async function rotateInboundAction(): Promise<void> {
  const { tenant } = await requireMember(["owner", "admin"]);
  let error: string | null = null;
  try {
    await rotateInboundRoute(await getDb(), tenant, new Date());
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath("/integrations");
  redirect(withParam("/integrations", error ? "error" : "ok", error ?? "New inbound address created; the old one no longer accepts mail"));
}

export async function disconnectGoogleAction(): Promise<void> {
  const { tenant } = await requireMember();
  let error: string | null = null;
  try {
    await disconnectGoogle(await getDb(), tenant, googleClientFromConfig(), new Date());
  } catch (err) {
    error = expectedError(err);
  }
  revalidatePath("/integrations");
  redirect(withParam("/integrations", error ? "error" : "ok", error ?? "Google disconnected. People you already confirmed stay."));
}

const Ids = z.array(z.string().uuid()).max(500);

export async function candidatesAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const ids = Ids.parse(form.getAll("ids").map(String));
  const op = form.get("op") === "dismiss" ? "dismiss" : "accept";
  let message: string;
  if (ids.length === 0) message = "Select at least one person";
  else if (op === "dismiss") message = `Dismissed ${await dismissSuggestions(await getDb(), tenant, ids, new Date())}`;
  else {
    const r = await acceptSuggestions(await getDb(), tenant, ids, new Date());
    message = `Added ${r.accepted} ${r.accepted === 1 ? "person" : "people"}${r.failed.length ? `; ${r.failed.length} skipped (${r.failed[0]!.reason})` : ""}`;
  }
  revalidatePath("/integrations");
  revalidatePath("/people");
  redirect(withParam("/integrations", "ok", message) + "#candidates");
}
