/**
 * Captures why an expert selected, rejected or edited something, from the
 * conversation it happened in, so the lesson lands in the right record. When
 * the reason isn't in the conversation, it proposes one short question, and
 * domain code decides whether asking is worth the expert's attention.
 */
import { z } from "zod";
import { routeDecision, shouldAskWhy, type Decision, type LearningUpdate } from "@/domain/judgment";
import type { StructuredLLM } from "./llm";

const Classification = z.object({
  reason_stated: z.boolean().describe("True only if the conversation actually states or clearly implies the reason"),
  category: z
    .enum(["expert_taste", "client_preference", "supplier_condition", "trip_constraint"])
    .nullable()
    .describe("Where the lesson belongs; null if unknown"),
  reason: z.string().nullable().describe("The reason in the expert's own terms, one sentence"),
  supplier_condition_valid_until: z.string().nullable().describe("For temporary supplier conditions (construction, closures): ISO date it likely ends, else null"),
  confidence: z.number().min(0).max(1),
  short_question: z.string().nullable().describe("If the reason is unclear: one short question to the expert, answerable in a few words"),
});

const SYSTEM = `You help a luxury travel expert's assistant learn from the expert's decisions without generalizing from circumstance.

Classify why the expert made a decision into exactly one of:
- expert_taste: the expert's own judgment about the property/experience itself (atmosphere, service style, quality) that would apply to any client.
- client_preference: fits or doesn't fit this particular client or party.
- supplier_condition: a current, usually temporary, condition at the supplier (no availability in the right room type, construction, chef departed, closure).
- trip_constraint: something about this trip only (dates, routing, budget for this trip, another option fits the itinerary better).

Do not guess. If the conversation doesn't show the reason, set reason_stated false, category null, and write one short, specific question.`;

export async function classifyDecision(
  llm: StructuredLLM,
  decision: Decision,
  conversation: string,
  opts: { similarUnexplainedCount: number },
): Promise<{ decision: Decision; learning: LearningUpdate | null; ask: string | null } | { error: string }> {
  const input = `<decision kind="${decision.kind}" subject="${decision.subject}">${decision.before ? `\nbefore: ${decision.before}` : ""}${decision.after ? `\nafter: ${decision.after}` : ""}\n</decision>\n<conversation>\n${conversation}\n</conversation>`;
  const r = await llm.generate({ schema: Classification, system: SYSTEM, input, effort: "low", maxTokens: 4_000 });
  if (!r.ok) return { error: `${r.reason}: ${r.detail}` };
  const c = r.value;
  const withReason: Decision =
    c.category && c.reason
      ? {
          ...decision,
          reason: {
            category: c.category,
            text: c.reason,
            origin: c.reason_stated ? "conversation" : "inferred",
            validUntil: c.category === "supplier_condition" ? c.supplier_condition_valid_until : null,
          },
        }
      : decision;
  const ask = shouldAskWhy(withReason, { inferredConfidence: c.reason_stated ? null : c.confidence, similarUnexplainedCount: opts.similarUnexplainedCount })
    ? c.short_question
    : null;
  return { decision: withReason, learning: routeDecision(withReason), ask };
}
