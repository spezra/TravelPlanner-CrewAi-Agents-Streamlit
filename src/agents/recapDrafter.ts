/**
 * Drafts the written recap of our understanding after a supplier call. The
 * expert edits and sends it; deterministic code (frameRecap) adds the label
 * saying it comes from the agency's system and records our understanding, not
 * the supplier's agreement, so the model can't drop or soften it.
 */
import { z } from "zod";
import type { Commitment } from "@/domain/commitments";
import type { StructuredLLM } from "./llm";

const Recap = z.object({
  subject: z.string().describe("Short, specific subject line"),
  body: z
    .string()
    .describe("Plain-text email body: greeting, one line of thanks, the commitments as a list in our words, a closing line. No signature."),
});

const SYSTEM = `You draft short, gracious recap emails from a luxury travel agency to a hotel or supplier contact after a call.

Rules:
- List every commitment you are given, and nothing else. Keep names, amounts and dates exactly as given.
- Phrase each item as our understanding ("We understand that ..."), never as the supplier's confirmed agreement.
- State conditions and due dates where given.
- Warm, brief, professional. The recipient's language is English unless told otherwise.
- Do not sign the email as a person and do not claim to be a person. The system adds its own header and footer.`;

export async function draftRecap(
  llm: StructuredLLM,
  input: { supplierName: string | null; language: string | null; commitments: readonly Pick<Commitment, "promisor" | "promise" | "conditions" | "dueBy">[] },
): Promise<{ subject: string; body: string } | { error: string }> {
  const items = input.commitments
    .map((c, i) => `${i + 1}. promisor: ${c.promisor}; promise: ${c.promise}; conditions: ${c.conditions ?? "none"}; due: ${c.dueBy ?? "not stated"}`)
    .join("\n");
  const result = await llm.generate({
    schema: Recap,
    system: SYSTEM,
    input: `<recipient>${input.supplierName ?? "unknown"}</recipient>\n<language>${input.language ?? "en"}</language>\n<commitments>\n${items}\n</commitments>`,
    effort: "low",
    maxTokens: 4_000,
  });
  if (!result.ok) return { error: `${result.reason}: ${result.detail}` };
  return result.value;
}
