"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/common";
import { getDb } from "@/lib/server";
import { acceptProposal, portalRateLimit } from "@/modules/trips/portal";

const Input = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  approvalId: z.string().uuid(),
  acceptedName: z.string().max(120),
  confirm: z.literal("yes"),
});

/** The client's go-ahead on a proposal. Public: the portal token is the only credential. */
export async function acceptProposalAction(form: FormData): Promise<void> {
  const parsed = Input.safeParse({
    token: form.get("token"),
    approvalId: form.get("approvalId"),
    acceptedName: String(form.get("acceptedName") ?? ""),
    confirm: form.get("confirm"),
  });
  const token = typeof form.get("token") === "string" ? String(form.get("token")) : "";
  const back = `/portal/${encodeURIComponent(token)}`;
  if (!parsed.success) redirect(`${back}?error=bad_input`);
  const db = await getDb();
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip");
  if (!(await portalRateLimit(db, ip, new Date()))) redirect(`${back}?error=rate_limited`);
  let error: string | null = null;
  try {
    await acceptProposal(db, parsed.data.token, { approvalId: parsed.data.approvalId, acceptedName: parsed.data.acceptedName }, new Date());
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    // Only a code travels in the URL; the page maps it to wording, so a crafted link can't put text in our mouth.
    error = err.code;
  }
  revalidatePath(back);
  redirect(error ? `${back}?error=${encodeURIComponent(error)}` : `${back}?accepted=1`);
}
