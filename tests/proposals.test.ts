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

describe("proposal workflow", async () => {
  const { useDb } = await import("./helpers/db");
  const { DEMO } = await import("@/db/seed");
  const svc = await import("@/modules/proposals/service");
  const jobs = await import("@/modules/proposals/jobs");
  const { drain } = await import("@/server/jobs/queue");
  const { withTenant } = await import("@/db/tenant");
  const getDb = useDb();
  const expert = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
  const assistant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };

  it("drafts via the job, blocks promised upgrades, and only the owner sends", async () => {
    const db = getDb();
    jobs.setProposalLLM(() => ({
      async generate<S extends z.ZodType>(req: StructuredRequest<S>) {
        return {
          ok: true as const,
          value: req.schema.parse({
            title: "Oaxaca",
            intro: "You will receive a room upgrade at the Hacienda.",
            sections: [{ heading: "Hacienda", body: "Garden casitas.", item_ids: [DEMO.hotelOaxaca], recommendations: [] }],
            closing: "M.",
          }) as z.infer<S>,
        };
      },
    }));
    await svc.requestDraft(db, assistant, DEMO.trip);
    await drain(db, jobs.handlers);
    const [draft] = await withTenant(db, expert, (q) => svc.listProposals(q, DEMO.trip));
    expect(draft).toMatchObject({ version: 1, status: "draft", createdBy: "agent:proposals" });
    await expect(svc.sendProposal(db, expert, draft!.id)).rejects.toThrow(/depends on availability/);
    await svc.saveEdit(db, expert, { proposalId: draft!.id, title: "Oaxaca", intro: "We'll request an upgrade; it's subject to availability.", closing: "M.", sectionBodies: {} });
    await expect(svc.sendProposal(db, assistant, draft!.id)).rejects.toThrow(/Only the trip owner/);
    await svc.sendProposal(db, expert, draft!.id);
    // Editing after sending creates a new draft version; the sent one stays intact.
    const nextId = await svc.saveEdit(db, expert, { proposalId: draft!.id, title: "Oaxaca v2", intro: "x", closing: "y", sectionBodies: {} });
    const all = await withTenant(db, expert, (q) => svc.listProposals(q, DEMO.trip));
    expect(all.map((p) => [p.version, p.status])).toEqual([
      [2, "draft"],
      [1, "sent"],
    ]);
    expect(all[0]!.id).toBe(nextId);
  });

  it("style samples are private to their author", async () => {
    const db = getDb();
    await svc.addStyleSample(db, expert, "Dear Priya and Tom — I've kept the evenings loose on purpose, because…");
    const seen = await withTenant(db, assistant, (q) => q.query("select * from style_samples"));
    expect(seen.rows).toEqual([]);
    await expect(withTenant(db, { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert }, (q) => svc.listProposals(q, DEMO.trip))).resolves.toEqual([]);
  });
});
