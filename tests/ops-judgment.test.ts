import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import { answerDecision, listOpenQuestions, listTripDecisions, recordDecision, recordDraftOutcome, reviewLearning, tasteModel, type DecisionInput } from "@/modules/ops/judgment";
import { drain } from "@/server/jobs/queue";
import { NOW, useDb } from "./helpers/db";
import { assistant, expert, handlersWith, opsDeps, scriptedLLM } from "./helpers/ops";

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const getDb = useDb();
let db: Db;
beforeEach(async () => {
  db = getDb();
  // These tests assert exact learning/outcome sets, so start without the demo judgment data from the main seed.
  await withSystem(db, async (q) => {
    await q.query("delete from expert_learnings");
    await q.query("delete from draft_outcomes");
    await q.query("delete from supplier_conditions");
  });
});

const base: DecisionInput = {
  tripId: DEMO.trip,
  itemId: DEMO.hotelOaxaca,
  optionRef: null,
  subject: null,
  supplierName: null,
  kind: "reject",
  before: null,
  after: null,
  reason: null,
  conversation: null,
};

const classification = (over: Record<string, unknown>) => ({
  reason_stated: true,
  category: null,
  reason: null,
  supplier_condition_valid_until: null,
  confidence: 0.9,
  short_question: null,
  ...over,
});

async function rows(table: string, where = "true") {
  return (await withSystem(db, (q) => q.query<Record<string, unknown>>(`select * from ${table} where ${where}`))).rows;
}

async function classify(output: Record<string, unknown>, input: Partial<DecisionInput> = {}) {
  const llm = scriptedLLM(classification(output));
  const { id, status } = await recordDecision(db, expert, { ...base, conversation: "Marisol: not the Hacienda this time.", ...input }, NOW, true);
  expect(status).toBe("classifying");
  await drain(db, handlersWith(opsDeps({ llm: () => llm })));
  const d = (await listTripDecisions(db, expert, DEMO.trip)).find((x) => x.id === id)!;
  return { d, llm };
}

describe("decision classification job", () => {
  it("routes a stated supplier condition to the dated supplier record without asking", async () => {
    const { d, llm } = await classify({ category: "supplier_condition", reason: "Pool closed for renovation", supplier_condition_valid_until: "2027-03-31" });
    expect(llm.calls[0]!.input).toContain("not the Hacienda this time");
    expect(d).toMatchObject({ status: "learned", learningTarget: "supplier_record", question: null });
    const cond = await rows("supplier_conditions", `decision_id = '${d.id}'`);
    expect(cond).toHaveLength(1);
    expect(cond[0]).toMatchObject({ supplier_name: "Hacienda Tierra Roja", owner_id: DEMO.expert, provisional: false, scope: "private" });
    expect(String(cond[0]!.valid_until instanceof Date ? (cond[0]!.valid_until as Date).toISOString() : cond[0]!.valid_until).slice(0, 10)).toBe("2027-03-31");
    expect(await rows("expert_learnings")).toEqual([]);
  });

  it("files a stated client preference in this trip's brief as the expert's inference", async () => {
    const { d } = await classify({ category: "client_preference", reason: "Priya finds haciendas too remote" });
    const s = await rows("brief_statements", `origin_decision_id = '${d.id}'`);
    expect(s[0]).toMatchObject({ client_id: DEMO.client, trip_id: DEMO.trip, evidence: "expert_inferred" });
  });

  it("holds a confident agent inference as provisional, marked as the agent's, without asking", async () => {
    const { d } = await classify({ reason_stated: false, category: "client_preference", reason: "Too formal for this couple", confidence: 0.85, short_question: "Too formal for them?" });
    expect(d).toMatchObject({ status: "learned", question: null });
    const s = await rows("brief_statements", `origin_decision_id = '${d.id}'`);
    expect(s[0]).toMatchObject({ evidence: "agent_inferred" });
  });

  it("puts expert taste in the taste model as provisional, and trip constraints on the trip only", async () => {
    const taste = await classify({ category: "expert_taste", reason: "Service is stiff; not my kind of place" });
    expect(await rows("expert_learnings", `decision_id = '${taste.d.id}'`)).toMatchObject([{ status: "provisional", expert_id: DEMO.expert }]);
    const trip = await classify({ category: "trip_constraint", reason: "Doesn't fit the Oaxaca dates" }, { itemId: DEMO.dinner });
    expect(await rows("trip_notes", `decision_id = '${trip.d.id}'`)).toMatchObject([{ trip_id: DEMO.trip }]);
  });

  it("asks one short question only when it's warranted, and files nothing until answered", async () => {
    const { d } = await classify({ reason_stated: false, category: "expert_taste", reason: "Maybe the atmosphere", confidence: 0.3, short_question: "Not your kind of place, or wrong for the Whitfields?" });
    expect(d).toMatchObject({ status: "awaiting_answer", question: "Not your kind of place, or wrong for the Whitfields?" });
    expect(await rows("expert_learnings")).toEqual([]);
    expect((await listOpenQuestions(db, expert)).map((x) => x.id)).toContain(d.id);

    // Only the expert answers; the answer is theirs, so it isn't provisional.
    await expect(answerDecision(db, assistant, d.id, { category: "client_preference", text: null, validUntil: null }, NOW)).rejects.toThrow(/Only the expert/);
    expect(await answerDecision(db, expert, d.id, { category: "client_preference", text: "Wrong for the Whitfields", validUntil: null }, NOW)).toBe("client_brief");
    expect((await rows("brief_statements", `origin_decision_id = '${d.id}'`))[0]).toMatchObject({ evidence: "expert_inferred" });
    await expect(answerDecision(db, expert, d.id, { category: "expert_taste", text: null, validUntil: null }, NOW)).rejects.toThrow(/already has its reason/);
  });

  it("doesn't ask about a low-confidence guess on a routine selection", async () => {
    const { d } = await classify(
      { reason_stated: false, category: null, reason: null, confidence: 0.2, short_question: "Why this one?" },
      { kind: "select", itemId: null, subject: "Chef's counter at Casa Alma", supplierName: null },
    );
    expect(d).toMatchObject({ status: "unexplained", question: null });
  });

  it("is idempotent when the job runs again", async () => {
    const { d, llm } = await classify({ category: "supplier_condition", reason: "Construction next door", supplier_condition_valid_until: "2026-12-01" });
    await withSystem(db, (q) => q.query("update jobs set status = 'queued', run_at = now() where kind = 'ops.classify_decision'"));
    await drain(db, handlersWith(opsDeps({ llm: () => llm })));
    expect(llm.calls).toHaveLength(1);
    expect(await rows("supplier_conditions", `decision_id = '${d.id}'`)).toHaveLength(1);
  });

  it("without agents, falls back to the deterministic rule for asking", async () => {
    const r = await recordDecision(db, expert, { ...base, conversation: "no, not that" }, NOW, false);
    expect(r.status).toBe("awaiting_answer"); // a supplier-level rejection with no reason
    const sel = await recordDecision(db, expert, { ...base, kind: "select" }, NOW, false);
    expect(sel.status).toBe("unexplained");
  });

  it("files a reason the expert gives directly, immediately and not provisional", async () => {
    const r = await recordDecision(db, expert, { ...base, reason: { category: "expert_taste", text: "Casitas feel generic now", validUntil: null } }, NOW, true);
    expect(r.status).toBe("learned");
    expect(await rows("expert_learnings", `decision_id = '${r.id}'`)).toMatchObject([{ status: "endorsed" }]);
    expect(await rows("jobs", "kind = 'ops.classify_decision'")).toEqual([]);
  });

  it("rejects items from other trips and trips the member can't see", async () => {
    await expect(recordDecision(db, expert, { ...base, tripId: DEMO.privateTrip }, NOW, false)).rejects.toThrow(/isn't on this trip/);
    await expect(recordDecision(db, assistant, { ...base, tripId: DEMO.privateTrip, itemId: null, subject: "x" }, NOW, false)).rejects.toThrow(/Trip not found/);
  });
});

describe("taste model", () => {
  it("the expert endorses or retracts provisional learnings; nobody else can reach them", async () => {
    const { d } = await classify({ category: "expert_taste", reason: "Service is stiff" });
    const model = await tasteModel(db, expert, NOW);
    expect(model.provisional.map((l) => l.decisionId)).toEqual([d.id]);
    const learningId = model.provisional[0]!.id;
    await expect(reviewLearning(db, assistant, learningId, "endorse", NOW)).rejects.toThrow(/No provisional learning/);
    expect((await tasteModel(db, assistant, NOW)).provisional).toEqual([]);
    await reviewLearning(db, expert, learningId, "endorse", NOW);
    expect((await tasteModel(db, expert, NOW)).endorsed.map((l) => l.id)).toEqual([learningId]);
    await expect(reviewLearning(db, expert, learningId, "endorse", NOW)).rejects.toThrow();
    await reviewLearning(db, expert, learningId, "retract", NOW);
    expect((await tasteModel(db, expert, NOW)).retracted.map((l) => l.id)).toEqual([learningId]);
  });

  it("measures endorsement from recorded draft outcomes", async () => {
    for (const outcome of ["endorsed_unchanged", "endorsed_unchanged", "endorsed_with_edits", "rejected"] as const) {
      await recordDraftOutcome(db, expert, { draftRef: `draft-${outcome}`, tripId: DEMO.trip, outcome, note: null }, NOW);
    }
    await recordDraftOutcome(db, assistant, { draftRef: "assistant's own", tripId: null, outcome: "rejected", note: null }, NOW);
    const { endorsement } = await tasteModel(db, expert, NOW);
    expect(endorsement).toEqual({ endorsedUnchanged: 2, endorsedWithEdits: 1, rejected: 1, rate: 0.5, total: 4 });
    // The model and its metrics are private to the expert.
    expect((await withTenant(db, assistant, (q) => q.query("select * from draft_outcomes"))).rows).toHaveLength(1);
  });
});
