"use server";

import { z } from "zod";
import { agentsConfigured } from "@/agents/llm";
import { getDb, requireMember } from "@/lib/server";
import { act, backPath, formObject, optionalText, optionalUuid, uuid } from "@/modules/ops/forms";
import { answerDecision, recordDecision, recordDraftOutcome, reviewLearning, TARGET_LABEL } from "@/modules/ops/judgment";

const category = z.enum(["expert_taste", "client_preference", "supplier_condition", "trip_constraint"]);
const date = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date").nullable());

const DecisionForm = z.object({
  tripId: uuid,
  itemId: optionalUuid,
  optionRef: optionalText,
  subject: optionalText,
  supplierName: optionalText,
  kind: z.enum(["select", "reject", "edit"]),
  before: optionalText,
  after: optionalText,
  category: z
    .string()
    .optional()
    .transform((v) => (v ? v : null))
    .pipe(category.nullable()),
  reasonText: optionalText,
  validUntil: date,
  conversation: optionalText,
});

const MESSAGE: Record<string, string> = {
  learned: "Recorded and learned",
  classifying: "Recorded. The agent is reading the conversation for the reason",
  awaiting_answer: "Recorded. One quick question below",
  unexplained: "Recorded",
};

export async function recordDecisionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/judgment");
  await act(
    back,
    async () => {
      const f = DecisionForm.parse(formObject(form));
      return recordDecision(
        await getDb(),
        tenant,
        {
          tripId: f.tripId,
          itemId: f.itemId,
          optionRef: f.optionRef,
          subject: f.subject,
          supplierName: f.supplierName,
          kind: f.kind,
          before: f.before,
          after: f.after,
          reason: f.category ? { category: f.category, text: f.reasonText ?? "", validUntil: f.validUntil } : null,
          conversation: f.conversation,
        },
        new Date(),
        agentsConfigured(),
      );
    },
    { to: (r) => `${back}${back.includes("?") ? "&" : "?"}ok=${encodeURIComponent(MESSAGE[r.status] ?? "Recorded")}` },
  );
}

export async function answerAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/judgment");
  await act(
    back,
    async () => {
      const f = z.object({ decisionId: uuid, category, text: optionalText, validUntil: date }).parse(formObject(form));
      return answerDecision(await getDb(), tenant, f.decisionId, { category: f.category, text: f.text, validUntil: f.validUntil }, new Date());
    },
    { to: (target) => `${back}${back.includes("?") ? "&" : "?"}ok=${encodeURIComponent(target ? `Thanks. Filed in ${TARGET_LABEL[target]}` : "Thanks")}` },
  );
}

export async function reviewLearningAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await act("/judgment", async () => {
    const f = z.object({ learningId: uuid, verdict: z.enum(["endorse", "retract"]) }).parse(formObject(form));
    await reviewLearning(await getDb(), tenant, f.learningId, f.verdict, new Date());
  });
}

export async function recordDraftOutcomeAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await act(
    "/judgment",
    async () => {
      const f = z
        .object({
          draftRef: z.string().trim().min(1, "Say which draft this was").max(300),
          tripId: optionalUuid,
          outcome: z.enum(["endorsed_unchanged", "endorsed_with_edits", "rejected"]),
          note: optionalText,
        })
        .parse(formObject(form));
      await recordDraftOutcome(await getDb(), tenant, f, new Date());
    },
    { ok: "Recorded" },
  );
}
