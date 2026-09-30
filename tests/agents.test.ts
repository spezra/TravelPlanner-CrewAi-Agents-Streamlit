import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { extractBrief } from "@/agents/briefExtractor";
import { extractCommitments } from "@/agents/commitmentExtractor";
import type { StructuredLLM, StructuredRequest, StructuredResult } from "@/agents/llm";
import { classifyDecision } from "@/agents/reasonClassifier";
import type { Decision } from "@/domain/judgment";
import { NOW } from "./fixtures";

/** Returns canned output, validated against the agent's own schema like the real client does. */
function fakeLLM(output: unknown | StructuredResult<never>): StructuredLLM & { last?: StructuredRequest<z.ZodType> } {
  const fake: StructuredLLM & { last?: StructuredRequest<z.ZodType> } = {
    async generate<S extends z.ZodType>(req: StructuredRequest<S>) {
      fake.last = req;
      if (output && typeof output === "object" && "ok" in output) return output as StructuredResult<z.infer<S>>;
      return { ok: true as const, value: req.schema.parse(output) as z.infer<S> };
    },
  };
  return fake;
}

describe("commitment extractor", () => {
  const debrief = "Rafael said casita 4 is held for the Whitfields and he'll upgrade them at no charge if we book by Friday. He'll try for late checkout.";

  it("applies domain routing and distrusts unsupported quotes", async () => {
    const llm = fakeLLM({
      commitments: [
        { promisor: "Rafael (GM)", promise: "Casita 4 held and upgraded at no charge", conditions: "Book by Friday", due_by: "2026-10-03", booking_hint: "Hacienda", consequential: true, confidence: 0.9, quote: "casita 4 is held for the Whitfields" },
        { promisor: "Rafael (GM)", promise: "Late checkout", conditions: "Will try; not promised", due_by: null, booking_hint: null, consequential: false, confidence: 0.9, quote: "guaranteed late checkout" },
        { promisor: "Rafael (GM)", promise: "Welcome mezcal", conditions: null, due_by: null, booking_hint: null, consequential: false, confidence: 0.95, quote: "upgrade them at no charge" },
      ],
      unclear_points: ["Is 'Friday' 2026-10-02 or 2026-10-09?"],
    });
    const r = await extractCommitments(llm, debrief, { tripId: "t", evidence: "expert_notes", evidenceRef: "debrief-1", resolveItem: (h) => (h === "Hacienda" ? "item-h" : null) });
    if ("error" in r) throw new Error(r.error);
    expect(r.drafts.map((d) => [d.reviewStatus, d.itemId])).toEqual([
      ["needs_review", "item-h"], // consequential
      ["needs_review", null], // quote not in source -> confidence capped
      ["auto_filed", null],
    ]);
    expect(r.drafts[1]!.confidence).toBeLessThanOrEqual(0.4);
    expect(r.unclear).toHaveLength(1);
  });

  it("surfaces refusals instead of inventing records", async () => {
    const r = await extractCommitments(fakeLLM({ ok: false, reason: "refused", detail: "x" }), debrief, { tripId: null, evidence: "expert_notes", evidenceRef: null });
    expect(r).toEqual({ error: "refused: x" });
  });
});

describe("reason classifier", () => {
  const decision: Decision = {
    id: "d",
    expertId: "e",
    tripId: "t",
    clientId: "c",
    supplierId: "s",
    kind: "reject",
    subject: "Hotel Grand Palacio",
    before: null,
    after: null,
    decidedAt: NOW.toISOString(),
    reason: null,
  };

  it("routes a stated supplier condition to the dated supplier record, without asking", async () => {
    const llm = fakeLLM({ reason_stated: true, category: "supplier_condition", reason: "Pool closed for renovation until spring", supplier_condition_valid_until: "2027-03-31", confidence: 0.95, short_question: null });
    const r = await classifyDecision(llm, decision, "Expert: skip the Palacio, pool's closed for renovation till spring.", { similarUnexplainedCount: 0 });
    if ("error" in r) throw new Error(r.error);
    expect(r.learning).toMatchObject({ target: "supplier_record", recordId: "s", validUntil: "2027-03-31", provisional: false });
    expect(r.ask).toBeNull();
  });

  it("asks one short question when the reason is unknown", async () => {
    const llm = fakeLLM({ reason_stated: false, category: null, reason: null, supplier_condition_valid_until: null, confidence: 0.2, short_question: "Wrong for the Whitfields, or not your kind of place?" });
    const r = await classifyDecision(llm, decision, "Expert: no, not that one.", { similarUnexplainedCount: 0 });
    if ("error" in r) throw new Error(r.error);
    expect(r.learning).toBeNull();
    expect(r.ask).toBe("Wrong for the Whitfields, or not your kind of place?");
  });

  it("holds confident inferences as provisional without interrupting", async () => {
    const llm = fakeLLM({ reason_stated: false, category: "client_preference", reason: "Too formal for this couple", supplier_condition_valid_until: null, confidence: 0.85, short_question: "Too formal for them?" });
    const r = await classifyDecision(llm, decision, "Expert: they'd hate the white-glove thing.", { similarUnexplainedCount: 0 });
    if ("error" in r) throw new Error(r.error);
    expect(r.learning).toMatchObject({ target: "client_brief", provisional: true });
    expect(r.ask).toBeNull();
  });
});

describe("brief extractor", () => {
  it("keeps inferences distinguishable and trip needs off the enduring brief", async () => {
    let n = 0;
    const llm = fakeLLM({
      statements: [
        { dimension: "desired_experience", text: "One unforgettable dinner; otherwise unscheduled evenings", client_said: true, applies_to: "this_trip" },
        { dimension: "practical_constraints", text: "Will accept a longer transfer for privacy", client_said: true, applies_to: "enduring" },
        { dimension: "party_dynamics", text: "Priya decides on hotels", client_said: false, applies_to: "enduring" },
      ],
    });
    const r = await extractBrief(llm, "call notes…", { clientId: "c", tripId: "t", sourceLabel: "call", now: NOW, newId: () => `b${++n}` });
    if ("error" in r) throw new Error(r.error);
    expect(r.map((s) => [s.tripId, s.evidence])).toEqual([
      ["t", "client_said"],
      [null, "client_said"],
      [null, "agent_inferred"],
    ]);
  });
});
