/**
 * Prepares options the way the expert would: a shortlist drawn from the
 * expert's own dated observations and taste notes for a specific need and
 * client, each with its evidence. When the expert has no reliable firsthand
 * knowledge for the need, it says so and suggests asking the network instead
 * of filling the gap with generic recommendations.
 */
import { z } from "zod";
import type { BriefStatement } from "@/domain/brief";
import { provenance, trustTier, type Observation, type TrustTier } from "@/domain/knowledge";
import type { StructuredLLM } from "./llm";

const Shortlist = z.object({
  options: z.array(
    z.object({
      supplier: z.string().describe("Exactly as named in the expert's observations"),
      fit: z.string().describe("Why it fits this client and need, in one or two sentences"),
      concerns: z.string().nullable(),
      observation_ids: z.array(z.string()),
    }),
  ),
  gap: z.string().nullable().describe("If the expert's own knowledge doesn't cover the need well, say what's missing"),
});

const SYSTEM = `You prepare a shortlist for a luxury travel expert from THEIR OWN knowledge only: their dated observations and taste notes.
- Only suggest suppliers that appear in the observations. Never add places from general knowledge.
- Rank by fit to this client's brief and the expert's taste, not by prestige.
- Mention concerns honestly (dated observations, supplier claims not personally checked, failed requests).
- If coverage is thin, fill "gap" instead of stretching.`;

export interface ScoutedOption {
  supplier: string;
  fit: string;
  concerns: string | null;
  evidence: { observationId: string; provenance: string; tier: TrustTier }[];
  bestTier: TrustTier;
}

export async function scoutOptions(
  llm: StructuredLLM,
  input: { need: string; brief: readonly BriefStatement[]; tasteNotes: readonly string[]; observations: readonly (Observation & { supplierName: string })[]; now: Date },
): Promise<{ options: ScoutedOption[]; gap: string | null; suggestNetwork: boolean } | { error: string }> {
  if (input.observations.length === 0) return { options: [], gap: "You have no recorded observations for this yet.", suggestNetwork: true };
  const obs = input.observations.map((o) => ({ id: o.id, supplier: o.supplierName, statement: o.statement, provenance: provenance(o), request: o.request, outcome: o.outcome }));
  const r = await llm.generate({
    schema: Shortlist,
    system: SYSTEM,
    input: `<need>${input.need}</need>\n<brief>${JSON.stringify(input.brief.map((b) => b.text))}</brief>\n<taste>${JSON.stringify(input.tasteNotes)}</taste>\n<observations>${JSON.stringify(obs)}</observations>`,
    effort: "medium",
    maxTokens: 8_000,
  });
  if (!r.ok) return { error: `${r.reason}: ${r.detail}` };
  const byId = new Map(input.observations.map((o) => [o.id, o]));
  const known = new Set(input.observations.map((o) => o.supplierName));
  const rank: Record<TrustTier, number> = { retain: 0, recommend: 1, commit: 2 };
  const options = r.value.options
    .filter((o) => known.has(o.supplier)) // drop anything not from the expert's own records
    .map((o) => {
      const evidence = o.observation_ids
        .map((id) => byId.get(id))
        .filter((x): x is NonNullable<typeof x> => Boolean(x) && x!.supplierName === o.supplier)
        .map((x) => ({ observationId: x.id, provenance: provenance(x), tier: trustTier(x, input.now) }));
      const bestTier = evidence.reduce<TrustTier>((b, e) => (rank[e.tier] > rank[b] ? e.tier : b), "retain");
      return { supplier: o.supplier, fit: o.fit, concerns: o.concerns, evidence, bestTier };
    });
  const reliable = options.some((o) => o.bestTier !== "retain");
  return { options, gap: r.value.gap, suggestNetwork: !reliable || r.value.gap !== null };
}
