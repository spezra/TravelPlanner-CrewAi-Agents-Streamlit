"use server";

import { safeLocalPath } from "@/lib/safePath";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DomainError } from "@/domain/common";
import { getDb, requireMember } from "@/lib/server";
import { confirmChecked } from "@/modules/calls/commitments";
import { decide } from "@/services/operations";

export async function decideApproval(form: FormData): Promise<void> {
  const approvalId = String(form.get("approvalId"));
  const decision = form.get("decision") === "approved" ? "approved" : "rejected";
  const back = safeLocalPath(form.get("back"));
  const { tenant } = await requireMember();
  let error: string | null = null;
  try {
    await decide(await getDb(), tenant, approvalId, decision, new Date());
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    error = err.message;
  }
  revalidatePath("/", "layout");
  redirect(error ? `${back}?error=${encodeURIComponent(error)}` : back);
}

export async function confirmCommitment(form: FormData): Promise<void> {
  const id = String(form.get("commitmentId"));
  const back = safeLocalPath(form.get("back"));
  const { tenant } = await requireMember();
  let error: string | null = null;
  try {
    await confirmChecked(await getDb(), tenant, id);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    error = err.message;
  }
  revalidatePath("/", "layout");
  redirect(error ? `${back}?error=${encodeURIComponent(error)}` : back);
}
