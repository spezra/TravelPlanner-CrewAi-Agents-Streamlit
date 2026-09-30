/**
 * Turns a call debrief, notes or a transcript into commitment records: who
 * promised what, for which booking, under which conditions, by when, and on
 * what evidence. Routing (auto-file vs. expert review) is decided by domain
 * code, not by the model.
 */
import { z } from "zod";
import { reviewRouting, type Commitment, type EvidenceType } from "@/domain/commitments";
import type { StructuredLLM } from "./llm";

const ExtractedCommitment = z.object({
  promisor: z.string().describe("Who made the promise, as named in the source, with role if stated"),
  promise: z.string().describe("What was promised, concretely"),
  conditions: z.string().nullable().describe("Conditions attached, or null"),
  due_by: z.string().nullable().describe("ISO 8601 date/time the promise is due, only if stated or unambiguous; else null"),
  booking_hint: z.string().nullable().describe("Which booking or service it concerns, as described in the source"),
  consequential: z.boolean().describe("True if it affects money, a room/flight/table the traveler relies on, or the client relationship"),
  confidence: z.number().min(0).max(1).describe("How sure you are the source actually states this promise"),
  quote: z.string().describe("The shortest verbatim span from the source that supports it"),
});

const Extraction = z.object({
  commitments: z.array(ExtractedCommitment),
  unclear_points: z.array(z.string()).describe("Names, amounts, dates or speakers that should be checked by a person"),
});

export type ExtractedCommitment = z.infer<typeof ExtractedCommitment>;

const SYSTEM = `You extract commitments from luxury-travel supplier interactions for the travel advisor who holds the relationship.

A commitment is a promise by a specific party to do or provide something: a room held, an upgrade, a late checkout, a table, a transfer time, a price, a reply by a date. Our own promises to the supplier count too (promisor "us").

Rules:
- Only extract what the source states. Do not infer promises from pleasantries or hopes ("we'll try", "should be fine" are not commitments; if included, give them low confidence and say so in conditions).
- Separate the promise from its conditions.
- Keep names, amounts and dates exactly as written. If a transcript may have misheard a name, amount, date or speaker, list it in unclear_points.
- Quote the supporting span verbatim.`;

export interface ExtractionContext {
  tripId: string | null;
  evidence: EvidenceType;
  evidenceRef: string | null;
  /** Map a booking hint to a trip item id, if the caller can. */
  resolveItem?: (hint: string | null) => string | null;
}

export type CommitmentDraft = Omit<Commitment, "id" | "state">;

export async function extractCommitments(
  llm: StructuredLLM,
  source: string,
  ctx: ExtractionContext,
): Promise<{ drafts: CommitmentDraft[]; unclear: string[] } | { error: string }> {
  const result = await llm.generate({ schema: Extraction, system: SYSTEM, input: `<source evidence="${ctx.evidence}">\n${source}\n</source>` });
  if (!result.ok) return { error: `${result.reason}: ${result.detail}` };
  const quotedOk = (q: string) => q.trim().length > 0 && source.includes(q.trim());
  const drafts = result.value.commitments.map((c): CommitmentDraft => {
    // An unsupported quote means we can't show where this came from: treat as uncertain.
    const confidence = quotedOk(c.quote) ? c.confidence : Math.min(c.confidence, 0.4);
    const base = {
      tripId: ctx.tripId,
      itemId: ctx.resolveItem?.(c.booking_hint) ?? null,
      promisor: c.promisor,
      promisorPersonId: null,
      promise: c.promise,
      conditions: c.conditions,
      dueBy: c.due_by,
      evidence: ctx.evidence,
      evidenceRef: ctx.evidenceRef,
      transcriptVerified: false,
      confidence,
      consequential: c.consequential,
      recapSentAt: null,
      deliveredToTravelerAt: null,
    };
    return { ...base, reviewStatus: reviewRouting(base) };
  });
  return { drafts, unclear: result.value.unclear_points };
}
