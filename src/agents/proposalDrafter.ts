/**
 * Drafts a client proposal in the expert's voice. Inputs are the expert's own
 * material only (their taste learnings, their dated observations, the client
 * brief and this trip's items), never a generic luxury recommendation engine.
 * The draft is checked by reviewProposal before the expert can send it.
 */
import { z } from "zod";
import { describePerksForTraveler, type TripItem } from "@/domain/bookings";
import type { BriefStatement } from "@/domain/brief";
import { provenance, trustTier, type Observation } from "@/domain/knowledge";
import { reviewProposal, type Proposal, type ProposalIssue } from "@/domain/proposals";
import type { StructuredLLM } from "./llm";

const Draft = z.object({
  title: z.string(),
  intro: z.string().describe("2–4 sentences addressed to the client, in the expert's voice"),
  sections: z.array(
    z.object({
      heading: z.string(),
      body: z.string().describe("Editorial narrative for this part of the trip"),
      item_ids: z.array(z.string()).describe("Ids of the trip items this section presents, from the provided list only"),
      recommendations: z.array(
        z.object({
          subject: z.string(),
          why: z.string().describe("Why this suits this client, tied to the brief"),
          observation_id: z.string().nullable().describe("Id of the expert observation supporting it, or null"),
          alternatives: z.array(z.object({ subject: z.string(), why_not: z.string() })),
        }),
      ),
    }),
  ),
  closing: z.string(),
});

const SYSTEM = `You draft travel proposals for a luxury travel expert, in their voice, for them to edit before anything reaches the client.

Rules:
- Use only the material provided: the expert's taste notes, their own dated observations, the client brief, and the trip items. Do not invent properties, rooms, restaurants, people, prices or facts.
- Write for this client: tie choices to what the brief says they value. Enduring preferences and this trip's needs are both given; don't carry assumptions from elsewhere.
- Perks that are "requested; subject to availability" must be described as requested, never as promised. Never use "guaranteed" for them.
- Keep the expert's register: specific, warm, unfussy. No superlatives stacked on superlatives, no marketing clichés.
- Reference trip items by their ids exactly as given. Cite an observation id only if that observation actually supports the recommendation.`;

export interface DraftInput {
  tripTitle: string;
  expertName: string;
  items: readonly TripItem[];
  brief: readonly BriefStatement[];
  tasteNotes: readonly string[];
  observations: readonly (Observation & { supplierName: string })[];
  styleSamples: readonly string[];
  now: Date;
}

export async function draftProposal(
  llm: StructuredLLM,
  input: DraftInput,
): Promise<{ proposal: Omit<Proposal, "id" | "tripId" | "version" | "status" | "createdBy" | "editedByExpert">; issues: ProposalIssue[] } | { error: string }> {
  const items = input.items
    .filter((i) => i.state !== "canceled")
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      supplier: i.supplierName,
      dates: [i.startsAt?.slice(0, 10), i.endsAt?.slice(0, 10)].filter(Boolean).join(" → "),
      perks_for_client: i.credentials ? describePerksForTraveler(i.credentials.perks) : [],
      status: i.state,
    }));
  const obs = input.observations.map((o) => ({
    id: o.id,
    supplier: o.supplierName,
    statement: o.statement,
    provenance: provenance(o),
    usable_for_recommendation: trustTier(o, input.now) !== "retain",
  }));
  const material = [
    `<trip title="${input.tripTitle}" expert="${input.expertName}">`,
    `<items>${JSON.stringify(items)}</items>`,
    `<client_brief>${JSON.stringify(input.brief.map((b) => ({ scope: b.tripId ? "this_trip" : "enduring", dimension: b.dimension, text: b.text, evidence: b.evidence })))}</client_brief>`,
    `<expert_taste>${JSON.stringify(input.tasteNotes)}</expert_taste>`,
    `<expert_observations>${JSON.stringify(obs)}</expert_observations>`,
    input.styleSamples.length ? `<expert_writing_samples>${input.styleSamples.map((s) => s.slice(0, 2000)).join("\n---\n")}</expert_writing_samples>` : "",
    "</trip>",
  ].join("\n");
  const r = await llm.generate({ schema: Draft, system: SYSTEM, input: material, effort: "high", maxTokens: 16_000 });
  if (!r.ok) return { error: `${r.reason}: ${r.detail}` };
  const d = r.value;
  const obsById = new Map(input.observations.map((o) => [o.id, o]));
  const itemIds = new Set(input.items.map((i) => i.id));
  const proposal = {
    title: d.title,
    intro: d.intro,
    closing: d.closing,
    sections: d.sections.map((s, i) => ({
      key: `s${i + 1}`,
      heading: s.heading,
      body: s.body,
      itemIds: s.item_ids.filter((id) => itemIds.has(id)),
      recommendations: s.recommendations.map((rec) => {
        const o = rec.observation_id ? obsById.get(rec.observation_id) : undefined;
        return {
          subject: rec.subject,
          why: rec.why,
          evidence: o ? { observationId: o.id, provenance: provenance(o), tier: trustTier(o, input.now) } : null,
          alternatives: rec.alternatives.map((a) => ({ subject: a.subject, whyNot: a.why_not })),
        };
      }),
    })),
  };
  const perksByItem = new Map(input.items.map((i) => [i.id, i.credentials?.perks ?? []]));
  return { proposal, issues: reviewProposal(proposal, { itemIds, perksByItem }) };
}
