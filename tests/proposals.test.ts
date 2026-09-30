import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { draftProposal } from "@/agents/proposalDrafter";
import type { StructuredLLM, StructuredRequest } from "@/agents/llm";
import { canSend, reviewProposal } from "@/domain/proposals";
import { item, NOW, observation } from "./fixtures";

const hotel = item({ id: "h1" });
const ctx = { itemIds: new Set(["h1"]), perksByItem: new Map([["h1", hotel.credentials!.perks]]) };

describe("proposal review", () => {
  it("blocks availability-dependent perks worded as promises", () => {
    const bad = reviewProposal({ intro: "You will receive a room upgrade on arrival.", closing: "", sections: [] }, ctx);
    expect(canSend(bad)).toBe(false);
    const ok = reviewProposal({ intro: "We'll request an upgrade; it's subject to availability.", closing: "Breakfast is guaranteed daily.", sections: [] }, ctx);
    expect(canSend(ok)).toBe(true);
  });

  it("flags unevidenced or unverified recommendations and foreign items", () => {
    const issues = reviewProposal(
      {
        intro: "",
        closing: "",
        sections: [
          {
            key: "s1",
            heading: "Oaxaca",
            body: "",
            itemIds: ["h1", "nope"],
            recommendations: [
              { subject: "Casita 4", why: "quiet", evidence: { observationId: "o", provenance: "Supplier claim, 2026-01-01, not personally inspected", tier: "retain" }, alternatives: [] },
              { subject: "Mezcal tasting", why: "fun", evidence: null, alternatives: [] },
            ],
          },
        ],
      },
      ctx,
    );
    expect(issues.map((i) => i.severity)).toEqual(["block", "warn", "warn"]);
  });
});

describe("proposal drafter", () => {
  it("keeps only real items and evidence, and reviews the draft", async () => {
    const llm: StructuredLLM = {
      async generate<S extends z.ZodType>(req: StructuredRequest<S>) {
        expect(req.input).toContain("requested; subject to availability");
        return {
          ok: true as const,
          value: req.schema.parse({
            title: "Oaxaca, slowly",
            intro: "A quiet anniversary.",
            sections: [
              {
                heading: "Hacienda",
                body: "Garden casitas.",
                item_ids: ["h1", "invented"],
                recommendations: [{ subject: "Casita 4", why: "Quietest", observation_id: "obs-1", alternatives: [{ subject: "Casita 1", why_not: "Road noise" }] }],
              },
            ],
            closing: "Yours, M.",
          }) as z.infer<S>,
        };
      },
    };
    const r = await draftProposal(llm, { tripTitle: "T", expertName: "M", items: [hotel], brief: [], tasteNotes: [], observations: [{ ...observation(), supplierName: "Hacienda" }], styleSamples: [], now: NOW });
    if ("error" in r) throw new Error(r.error);
    expect(r.proposal.sections[0]!.itemIds).toEqual(["h1"]);
    expect(r.proposal.sections[0]!.recommendations[0]!.evidence).toMatchObject({ observationId: "obs-1", tier: "recommend" });
    expect(canSend(r.issues)).toBe(true);
  });
});
