/**
 * Builds client-brief statements from calls, emails and debriefs, keeping what
 * the client said separate from what was inferred, and enduring preferences
 * separate from this trip's needs.
 */
import { z } from "zod";
import type { BriefStatement } from "@/domain/brief";
import type { StructuredLLM } from "./llm";

const Extraction = z.object({
  statements: z.array(
    z.object({
      dimension: z.enum(["desired_experience", "practical_constraints", "party_dynamics", "outcomes"]),
      text: z.string().describe("Specific and useful: 'prefers intimate properties, dislikes visibly formal service', not 'likes luxury'"),
      client_said: z.boolean().describe("True only if the client (not the advisor) said it in the source"),
      applies_to: z.enum(["this_trip", "enduring"]).describe("Enduring only if the source indicates a lasting preference, not just this trip's need"),
    }),
  ),
});

const SYSTEM = `You maintain client briefs for a luxury travel expert. Part of their value is recognizing what a client will enjoy before the client can say it, so specific texture matters more than generic labels.

Dimensions:
- desired_experience: what the trip should feel like and accomplish
- practical_constraints: pace, mobility, privacy, timing, spending boundaries
- party_dynamics: who decides, differing preferences, whose needs come first
- outcomes: what they enjoyed, regretted or would repeat (post-trip)

Only record what the source supports. Mark client_said false for anything the advisor inferred or you infer. Default to this_trip unless the source clearly signals a lasting preference; a honeymoon's needs should not become assumptions for a later family trip.`;

export async function extractBrief(
  llm: StructuredLLM,
  source: string,
  ctx: { clientId: string; tripId: string; sourceLabel: string; now: Date; newId: () => string },
): Promise<BriefStatement[] | { error: string }> {
  const r = await llm.generate({ schema: Extraction, system: SYSTEM, input: source, effort: "low", maxTokens: 8_000 });
  if (!r.ok) return { error: `${r.reason}: ${r.detail}` };
  return r.value.statements.map((s) => ({
    id: ctx.newId(),
    clientId: ctx.clientId,
    tripId: s.applies_to === "enduring" ? null : ctx.tripId,
    dimension: s.dimension,
    text: s.text,
    // Anything the model didn't see the client say is the agent's inference until the expert confirms it.
    evidence: s.client_said ? "client_said" : "agent_inferred",
    source: ctx.sourceLabel,
    recordedAt: ctx.now.toISOString(),
    supersededBy: null,
  }));
}
