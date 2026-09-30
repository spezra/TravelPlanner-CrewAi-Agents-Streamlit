"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/common";
import { getDb, requireMember } from "@/lib/server";
import { changeCommitmentState, confirmChecked, markDelivered, sendRecap } from "@/modules/calls/commitments";
import { mailer } from "@/server/mail";

const uuid = z.string().uuid();

/** Only local commitments/calls pages are valid return targets. */
function safeBack(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return /^\/(commitments|calls)(\/[\w-]*)*(\?[\w=&%.-]*)?$/.test(s) ? s : "/commitments";
}

const withParam = (path: string, key: string, value: string) => {
  const url = new URL(path, "http://local");
  url.searchParams.delete("error");
  url.searchParams.delete("ok");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
};

async function act(back: string, fn: () => Promise<unknown>, ok?: string, to?: string): Promise<never> {
  let error: string | null = null;
  try {
    await fn();
  } catch (err) {
    if (err instanceof DomainError) error = err.message;
    else if (err instanceof z.ZodError) error = err.issues.map((i) => i.message).join("; ");
    else throw err;
  }
  revalidatePath("/commitments", "layout");
  revalidatePath("/calls", "layout");
  revalidatePath("/", "layout");
  if (error) redirect(withParam(back, "error", error));
  redirect(ok ? withParam(to ?? back, "ok", ok) : (to ?? back));
}

export async function transitionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await act(safeBack(form.get("back")), async () =>
    changeCommitmentState(await getDb(), tenant, {
      id: uuid.parse(form.get("id")),
      to: z.enum(["pending", "fulfilled", "disputed", "superseded", "canceled"]).parse(form.get("to")),
    }),
  );
}

export async function confirmCheckedAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await act(safeBack(form.get("back")), async () => confirmChecked(await getDb(), tenant, uuid.parse(form.get("id"))));
}

export async function deliveredAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await act(safeBack(form.get("back")), async () => markDelivered(await getDb(), tenant, uuid.parse(form.get("id")), new Date()), "Marked delivered to the traveler.");
}

export async function sendRecapAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const ids = form.getAll("ids").map(String);
  const back = `/commitments/recap?${ids.map((i) => `ids=${encodeURIComponent(i)}`).join("&")}`;
  await act(
    safeBack(back),
    async () => {
      const input = z
        .object({ ids: z.array(uuid).min(1).max(50), to: z.string().trim().max(320), subject: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(20_000) })
        .parse({ ids, to: form.get("to"), subject: form.get("subject"), body: form.get("body") });
      await sendRecap(await getDb(), tenant, mailer(), input, new Date());
    },
    "Recap sent.",
    "/commitments",
  );
}
