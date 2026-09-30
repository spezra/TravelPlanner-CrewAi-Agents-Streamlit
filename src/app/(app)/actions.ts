"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { markCommitmentReviewed } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import { getDb, requireMember } from "@/lib/server";
import { decide } from "@/services/operations";

export async function decideApproval(form: FormData): Promise<void> {
  const approvalId = String(form.get("approvalId"));
  const decision = form.get("decision") === "approved" ? "approved" : "rejected";
  const back = String(form.get("back") ?? "/");
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
  const back = String(form.get("back") ?? "/");
  const { tenant } = await requireMember();
  await withTenant(await getDb(), tenant, (q) => markCommitmentReviewed(q, id, true));
  revalidatePath("/", "layout");
  redirect(back);
}
