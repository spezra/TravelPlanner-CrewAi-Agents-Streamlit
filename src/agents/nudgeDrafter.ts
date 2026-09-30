/**
 * Drafts the note behind a relationship nudge, in the owner's voice, for the
 * owner to edit and send from their own mail client. The system never sends
 * it and never signs as the person.
 */
import { z } from "zod";
import type { Nudge } from "@/domain/crm";
import type { StructuredLLM } from "./llm";

const Schema = z.object({
  subject: z.string().max(120),
  body: z.string().max(2000).describe("Plain text, 60-150 words, ending with the owner's first name"),
});

const SYSTEM = `You draft short personal notes for a luxury travel advisor to send to a hospitality contact.
The advisor will edit and send it themselves, from their own email, under their own name.
- Warm, specific, never effusive. No asks in a thank-you or congratulations note.
- Use only facts in the context. Don't invent awards, events or details.
- Write in the contact's language if one is given, else English.
- Plain text only.`;

export async function draftNudgeNote(
  llm: StructuredLLM,
  ctx: { nudge: Pick<Nudge, "kind" | "message">; personName: string; role: string | null; language: string | null; ownerName: string; recentNotes: string[] },
): Promise<{ subject: string; body: string } | { error: string }> {
  const r = await llm.generate({
    schema: Schema,
    system: SYSTEM,
    input: JSON.stringify({
      reason: ctx.nudge.message,
      kind: ctx.nudge.kind,
      contact: { name: ctx.personName, role: ctx.role, language: ctx.language },
      advisor: ctx.ownerName,
      recent_interactions: ctx.recentNotes.slice(0, 5),
    }),
    effort: "low",
    maxTokens: 1500,
  });
  return r.ok ? r.value : { error: `${r.reason}: ${r.detail}` };
}
