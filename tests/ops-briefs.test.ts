import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import { briefForTrip } from "@/domain/brief";
import {
  acceptSuggestion,
  addPartyMember,
  addStatement,
  createClient,
  deleteClient,
  getClientDetail,
  listClients,
  promoteStatement,
  reassignClient,
  recordOutcome,
  requestBriefExtraction,
  supersedeStatement,
} from "@/modules/ops/clients";
import { drain } from "@/server/jobs/queue";
import { NOW, useDb } from "./helpers/db";
import { assistant, backup, expert, handlersWith, opsDeps, outsider, scriptedLLM } from "./helpers/ops";

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const getDb = useDb();
let db: Db;
beforeEach(() => {
  db = getDb();
});

const SECOND_TRIP = "00000000-0000-4000-8000-0000000000d3";
async function addSecondTrip() {
  await withSystem(db, (q) =>
    q.query("insert into trips (id, workspace_id, owner_id, client_id, title, starts_on, ends_on, scope) values ($1, $2, $3, $4, 'Family summer, Puglia', '2027-07-01', '2027-07-12', 'workspace')", [
      SECOND_TRIP,
      DEMO.workspace,
      DEMO.expert,
      DEMO.client,
    ]),
  );
}

describe("clients and book portability", () => {
  it("new clients start private when advisors own their book, and stay with their owner", async () => {
    const id = await createClient(db, expert, { name: "The Okafors", email: "okafor@example.com", phone: null, notes: "Prefers WhatsApp; son has a nut allergy" });
    expect((await listClients(db, expert)).map((c) => c.id)).toContain(id);
    expect((await listClients(db, assistant)).map((c) => c.id)).not.toContain(id);
    expect(await listClients(db, outsider)).toEqual([]);
    const detail = await getClientDetail(db, expert, id);
    expect(detail).toMatchObject({ scope: "private", notes: "Prefers WhatsApp; son has a nut allergy" });
    // Notes are encrypted at rest.
    const raw = await withSystem(db, (q) => q.query<{ notes_enc: string }>("select notes_enc from clients where id = $1", [id]));
    expect(raw.rows[0]!.notes_enc).not.toContain("nut allergy");
  });

  it("only the holding advisor moves a client when advisors own the book; agencies keep clients workspace-wide", async () => {
    const id = await createClient(db, expert, { name: "The Okafors", email: null, phone: null, notes: null });
    await withSystem(db, (q) => q.query("update members set role = 'admin' where id = $1", [DEMO.backup]));
    await withSystem(db, (q) => q.query("update clients set scope = 'workspace' where id = $1", [id]));
    await expect(reassignClient(db, backup, id, { ownerId: DEMO.backup, scope: "workspace" })).rejects.toThrow(/Only the advisor who holds/);
    await reassignClient(db, expert, id, { ownerId: DEMO.backup, scope: "private" });
    expect((await listClients(db, expert)).map((c) => c.id)).not.toContain(id);

    await withSystem(db, (q) => q.query("update workspaces set book_portability = 'agency_owns' where id = $1", [DEMO.workspace]));
    const agencyClient = await createClient(db, expert, { name: "The Lindqvists", email: null, phone: null, notes: null });
    expect((await listClients(db, assistant)).map((c) => c.id)).toContain(agencyClient);
    await expect(reassignClient(db, expert, agencyClient, { ownerId: DEMO.expert, scope: "private" })).rejects.toThrow(/belongs to the agency/);
    await reassignClient(db, backup, agencyClient, { ownerId: DEMO.backup, scope: "workspace" });
  });

  it("clients with trips can't be deleted outright", async () => {
    await expect(deleteClient(db, expert, DEMO.client)).rejects.toThrow(/deletion request/);
    const id = await createClient(db, expert, { name: "Short-lived", email: null, phone: null, notes: null });
    await addPartyMember(db, expert, id, { name: "A. Person", relation: "spouse", notes: "private note" });
    await deleteClient(db, expert, id);
    expect(await getClientDetail(db, expert, id)).toBeNull();
  });
});

describe("client brief", () => {
  it("keeps one trip's needs off another trip and off the enduring brief", async () => {
    await addSecondTrip();
    await addStatement(db, expert, { clientId: DEMO.client, tripId: SECOND_TRIP, dimension: "practical_constraints", text: "Grandmother can't manage stairs", evidence: "client_said", source: "call" }, NOW);
    const detail = (await getClientDetail(db, expert, DEMO.client))!;
    const anniversary = briefForTrip(detail.statements, DEMO.client, DEMO.trip);
    const family = briefForTrip(detail.statements, DEMO.client, SECOND_TRIP);
    expect(anniversary.byDimension.practical_constraints.map((s) => s.text)).not.toContain("Grandmother can't manage stairs");
    expect(family.thisTrip.map((s) => s.text)).toEqual(["Grandmother can't manage stairs"]);
    expect(family.thisTrip.map((s) => s.text)).not.toContain("One unforgettable dinner; otherwise unscheduled evenings");
    // A statement can't be pinned to another client's trip.
    await expect(
      addStatement(db, expert, { clientId: DEMO.client, tripId: DEMO.privateTrip, dimension: "desired_experience", text: "Quiet", evidence: "client_said", source: "x" }, NOW),
    ).rejects.toThrow(/isn't this client's/);
  });

  it("only owners and advisors promote a trip need to an enduring preference", async () => {
    const tripNeed = "00000000-0000-4000-8000-000000000503";
    await expect(promoteStatement(db, assistant, tripNeed, NOW)).rejects.toThrow(/owners and advisors/);
    const promoted = await promoteStatement(db, expert, tripNeed, NOW);
    const detail = (await getClientDetail(db, expert, DEMO.client))!;
    expect(detail.statements.find((s) => s.id === tripNeed)!.supersededBy).toBe(promoted);
    expect(detail.statements.find((s) => s.id === promoted)).toMatchObject({ tripId: null, evidence: "client_said" });
    await expect(promoteStatement(db, expert, tripNeed, NOW)).rejects.toThrow(/already replaced/);
    // The advisor backup can promote too.
    await addSecondTrip();
    const s = await addStatement(db, expert, { clientId: DEMO.client, tripId: SECOND_TRIP, dimension: "desired_experience", text: "Long lunches", evidence: "client_said", source: "call" }, NOW);
    await promoteStatement(db, backup, s, NOW);
  });

  it("corrections supersede, keeping history; outcomes belong to a trip", async () => {
    const orig = "00000000-0000-4000-8000-000000000504";
    const next = await supersedeStatement(db, assistant, orig, { text: "Priya plans and decides on hotels", evidence: "client_said" }, NOW);
    let detail = (await getClientDetail(db, expert, DEMO.client))!;
    expect(briefForTrip(detail.statements, DEMO.client, DEMO.trip).byDimension.party_dynamics.map((s) => s.id)).toEqual([next]);
    expect(detail.statements.find((s) => s.id === orig)!.supersededBy).toBe(next);

    await recordOutcome(db, expert, { clientId: DEMO.client, tripId: DEMO.trip, kind: "regretted", text: "Too many early starts in Oaxaca", evidence: "client_said" }, NOW);
    detail = (await getClientDetail(db, expert, DEMO.client))!;
    expect(detail.statements.find((s) => s.dimension === "outcomes")).toMatchObject({ outcomeKind: "regretted", tripId: DEMO.trip });
    await expect(
      addStatement(db, expert, { clientId: DEMO.client, tripId: null, dimension: "outcomes", text: "Loved it", evidence: "client_said", source: "x" }, NOW),
    ).rejects.toThrow(/belong to a trip/);
  });
});

describe("brief extraction job", () => {
  const notes = "Call with Priya: she said they want slow mornings and nothing before 10. I think Tom secretly wants one big adventure day.";

  it("files suggestions the expert accepts; agent inferences stay marked", async () => {
    const llm = scriptedLLM({
      statements: [
        { dimension: "practical_constraints", text: "Nothing scheduled before 10am", client_said: true, applies_to: "this_trip" },
        { dimension: "party_dynamics", text: "Tom would enjoy one adventurous day", client_said: false, applies_to: "enduring" },
      ],
    });
    const deps = opsDeps({ llm: () => llm });
    await expect(requestBriefExtraction(db, expert, { clientId: DEMO.client, tripId: DEMO.trip, sourceLabel: "call", text: notes }, false)).rejects.toThrow(/isn't configured/);
    const extractionId = await requestBriefExtraction(db, expert, { clientId: DEMO.client, tripId: DEMO.trip, sourceLabel: "call 2026-09-30", text: notes }, true);
    await drain(db, handlersWith(deps));
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.input).toBe(notes);

    let detail = (await getClientDetail(db, expert, DEMO.client))!;
    expect(detail.extractions[0]).toMatchObject({ id: extractionId, status: "done" });
    expect(detail.suggestions.map((s) => [s.tripId, s.evidence])).toEqual([
      [DEMO.trip, "client_said"],
      [null, "agent_inferred"],
    ]);
    // Nothing is filed until accepted.
    expect(detail.statements.some((s) => s.text.includes("adventurous"))).toBe(false);
    const accepted = detail.suggestions[1]!.id;
    const stmt = await acceptSuggestion(db, expert, accepted, NOW);
    detail = (await getClientDetail(db, expert, DEMO.client))!;
    expect(detail.statements.find((s) => s.id === stmt)).toMatchObject({ evidence: "agent_inferred", tripId: null, source: "extracted: call 2026-09-30" });
    await expect(acceptSuggestion(db, expert, accepted, NOW)).rejects.toThrow(/already handled/);

    // Re-running the job does nothing.
    await withSystem(db, (q) => q.query("update jobs set status = 'queued', run_at = now() where kind = 'ops.extract_brief'"));
    await drain(db, handlersWith(deps));
    expect(llm.calls).toHaveLength(1);
  });

  it("trip-specific suggestions from a trip-less source need a trip on accept", async () => {
    const llm = scriptedLLM({ statements: [{ dimension: "desired_experience", text: "Honeymoon: total privacy", client_said: true, applies_to: "this_trip" }] });
    await requestBriefExtraction(db, expert, { clientId: DEMO.client, tripId: null, sourceLabel: "email", text: "We want total privacy on the honeymoon, please." }, true);
    await drain(db, handlersWith(opsDeps({ llm: () => llm })));
    const s = (await getClientDetail(db, expert, DEMO.client))!.suggestions[0]!;
    expect(s).toMatchObject({ tripId: null, tripSpecific: true });
    await expect(acceptSuggestion(db, expert, s.id, NOW)).rejects.toThrow(/choose which/);
    const id = await acceptSuggestion(db, expert, s.id, NOW, DEMO.trip);
    expect((await getClientDetail(db, expert, DEMO.client))!.statements.find((x) => x.id === id)!.tripId).toBe(DEMO.trip);
  });

  it("a refusal fails the extraction without inventing statements", async () => {
    const llm = scriptedLLM({ ok: false, reason: "refused", detail: "declined" });
    await requestBriefExtraction(db, expert, { clientId: DEMO.client, tripId: DEMO.trip, sourceLabel: "call", text: notes }, true);
    await drain(db, handlersWith(opsDeps({ llm: () => llm })));
    const detail = (await getClientDetail(db, expert, DEMO.client))!;
    expect(detail.extractions[0]).toMatchObject({ status: "failed", error: "refused: declined" });
    expect(detail.suggestions).toEqual([]);
  });

  it("members who can't see the client can't extract into it", async () => {
    const id = await createClient(db, expert, { name: "Private one", email: null, phone: null, notes: null });
    await expect(requestBriefExtraction(db, assistant, { clientId: id, tripId: null, sourceLabel: "x", text: notes }, true)).rejects.toThrow(/not found/);
    await expect(withTenant(db, assistant, (q) => q.query("select * from brief_extractions"))).resolves.toMatchObject({ rows: [] });
  });
});
