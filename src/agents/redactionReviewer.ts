/**
 * The LLM pass of the publication pipeline, run after the deterministic
 * detectors in src/modules/network/redact.ts:
 *
 *   reviewRedaction    flags identifying or restricted content the detectors missed
 *   checkAgainstSource says whether the redacted item contradicts or overstates its source
 *
 * Output is schema-validated and then judged by domain code
 * (src/domain/publication.ts routeAfterReview): flagged spans are removed only
 * if they literally occur in the text, and any flag sends the item to the
 * owner. The model never publishes anything.
 */
import { z } from "zod";
import type { KnowledgeCategory } from "@/domain/knowledge";
import type { StructuredLLM } from "./llm";

const FINDING_KINDS = [
  "person_name",
  "contact_detail",
  "room_or_booking_identifier",
  "client_detail",
  "commercial_term",
  "unpublished_availability",
  "relationship_concession",
  "other_identifier",
] as const;
export type ReviewFindingKind = (typeof FINDING_KINDS)[number];

/** Restricted even with every identifier removed; never published. */
const RESTRICTED_KINDS: ReadonlySet<ReviewFindingKind> = new Set(["commercial_term", "unpublished_availability", "relationship_concession"]);

const Review = z.object({
  findings: z.array(
    z.object({
      span: z.string().describe("The exact text from the item, copied verbatim, that should not be shared"),
      kind: z.enum(FINDING_KINDS),
      reason: z.string().describe("One short sentence"),
    }),
  ),
});

const REVIEW_SYSTEM = `You review short pieces of travel-advisor knowledge before they are shared with other advisors (inside an agency, or across a curated network of independent advisors).

An automatic redactor has already replaced emails, links, phone numbers, prices, percentages, room numbers and known names with placeholders like [person], [room], [amount]. Your job is to find what it missed.

Flag, copying the exact span verbatim:
- person_name: names or nicknames of real people (guests, staff, advisors), including first names alone and job titles that identify one person at one property ("the new GM's daughter").
- contact_detail: any way to reach someone (handles, WhatsApp, "ask for X at the front desk", direct lines).
- room_or_booking_identifier: room/villa/unit numbers written in words, confirmation numbers, dates of a specific guest's stay.
- client_detail: anything that identifies a traveler or their circumstances (health, family events, wealth, names of their companies).
- commercial_term: rates, discounts, commissions, net pricing, contracted terms, written as words or numbers.
- unpublished_availability: inventory or holds not publicly bookable ("they keep two casitas back").
- relationship_concession: favors granted because of one advisor's relationship ("will always upgrade for me").
- other_identifier: anything else that would let a reader identify a private individual.

Do not flag the property or destination itself, public facts, or general guidance about rooms and service. Do not rewrite the text. Return an empty list if nothing needs removing.`;

export interface RedactionReview {
  /** Only spans that literally occur in the reviewed text. */
  spans: string[];
  findings: { span: string; kind: ReviewFindingKind; reason: string }[];
  restricted: boolean;
}

export async function reviewRedaction(
  llm: StructuredLLM,
  input: { text: string; category: KnowledgeCategory },
): Promise<RedactionReview | { error: string }> {
  const r = await llm.generate({
    schema: Review,
    system: REVIEW_SYSTEM,
    input: `<item category="${input.category}">\n${input.text}\n</item>`,
    effort: "medium",
    maxTokens: 4000,
  });
  if (!r.ok) return { error: `${r.reason}: ${r.detail}` };
  // A span we can't locate can't be removed; it still counts as a finding so the owner looks.
  const findings = r.value.findings.filter((f) => f.span.trim().length > 0);
  return {
    spans: findings.map((f) => f.span.trim()).filter((s) => input.text.includes(s)),
    findings,
    restricted: findings.some((f) => RESTRICTED_KINDS.has(f.kind)),
  };
}

const SourceCheck = z.object({
  consistent: z.boolean().describe("True only if the redacted item says nothing the source doesn't support"),
  issues: z.array(z.string()).describe("Each way the redacted item contradicts, overstates or generalizes beyond the source"),
});

const SOURCE_SYSTEM = `You compare a redacted piece of travel-advisor knowledge against the private note it was derived from.

Placeholders like [person], [room], [amount], [link] mark removed details; their absence is expected and fine.

The redacted item is inconsistent if it:
- contradicts the source;
- overstates it: drops a hedge or condition ("usually", "in low season", "if you ask the GM"), turns one experience into a general rule, or turns a supplier's claim into a fact;
- adds anything the source does not say.

Losing detail is fine. Be strict about overstatement: other advisors will act on this.`;

export async function checkAgainstSource(llm: StructuredLLM, input: { source: string; redacted: string }): Promise<{ consistent: boolean; issues: string[] } | { error: string }> {
  const r = await llm.generate({
    schema: SourceCheck,
    system: SOURCE_SYSTEM,
    input: `<source>\n${input.source}\n</source>\n<redacted>\n${input.redacted}\n</redacted>`,
    effort: "medium",
    maxTokens: 2000,
  });
  if (!r.ok) return { error: `${r.reason}: ${r.detail}` };
  return r.value;
}
