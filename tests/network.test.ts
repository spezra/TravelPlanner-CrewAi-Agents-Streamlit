import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { StructuredLLM, StructuredRequest } from "@/agents/llm";
import type { Db } from "@/db/client";
import { listPendingPublicationIds } from "@/db/repo";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import * as collab from "@/modules/network/collaborations";
import { makeHandlers } from "@/modules/network/jobs";
import * as knowledge from "@/modules/network/knowledge";
import { admitToNetwork, applyForMembership, membership, removeFromNetwork, saveProfile, searchNetwork } from "@/modules/network/membership";
import { attachPhoto, createObservation, deleteObservation, listObservations, readPhoto } from "@/modules/network/observations";
import { NETWORK_DEMO, seedNetwork } from "@/modules/network/seed";
import { drain } from "@/server/jobs/queue";
import { MemoryStore } from "@/server/storage";
import { NOW, useDb } from "./helpers/db";

const getDb = useDb();
let db: Db;
beforeEach(async () => {
  db = getDb();
  // Each test arranges network state itself; clear the demo network data and person links from the main seed.
  // TRUNCATE needs table ownership, so this test-only reset runs on the owner connection.
  await db.query("truncate collaboration_log, relationship_activations, collaboration_endorsements, collaboration_shares, collaboration_terms, collaborations, published_knowledge, network_profiles, network_members, knowledge_standing_rules cascade");
  await withSystem(db, (q) => q.query("update knowledge_items set depends_on_person_id = null, needs_review = false"));
});

const expert: Tenant = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
const assistant: Tenant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
const backup: Tenant = { workspaceId: DEMO.workspace, memberId: DEMO.backup };
const camille: Tenant = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };
const THIRD_WS = "00000000-0000-4000-8000-000000000003";
const outsider: Tenant = { workspaceId: THIRD_WS, memberId: "00000000-0000-4000-8000-0000000000c3" };
const CAMILLE_COLLEAGUE: Tenant = { workspaceId: DEMO.otherWorkspace, memberId: "00000000-0000-4000-8000-0000000000b2" };

/** Real clock matters for RLS expiry checks (they use the database's now()). */
const future = (days: number) => new Date(Math.max(NOW.getTime(), Date.now()) + days * 86_400_000).toISOString();

async function setupNetwork(admit: Tenant["workspaceId"][] = [DEMO.workspace, DEMO.otherWorkspace]) {
  await withSystem(db, async (q) => {
    await q.query("insert into workspaces (id, name, book_portability) values ($1, 'Solo Outsider', 'advisor_owns') on conflict do nothing", [THIRD_WS]);
    await q.query(
      `insert into members (id, workspace_id, name, email, role) values ($1, $2, 'Olu Outsider', 'olu@example.com', 'owner'),
         ($3, $4, 'Bastien Roux', 'bastien@example.com', 'advisor') on conflict do nothing`,
      [outsider.memberId, THIRD_WS, CAMILLE_COLLEAGUE.memberId, DEMO.otherWorkspace],
    );
  });
  for (const ws of admit) await admitToNetwork(db, ws, { operator: "ops@platform" }, NOW);
  const profile = { headline: null, languages: ["English"], responseCapacity: "available" as const, discoverable: true };
  await saveProfile(db, expert, { ...profile, displayName: "Marisol Vega", destinations: ["Mexico City", "Oaxaca"], capabilities: ["answer_question", "review_itinerary"] }, NOW);
  await saveProfile(db, camille, { ...profile, displayName: "Camille Roux", destinations: ["Paris", "Loire Valley"], capabilities: ["answer_question", "review_itinerary", "activate_relationship", "design_segment"] }, NOW);
  await saveProfile(db, outsider, { ...profile, displayName: "Olu", destinations: ["Lagos"], capabilities: ["answer_question"] }, NOW);
}

const itemInput = (over: Partial<knowledge.ItemInput> = {}): knowledge.ItemInput => ({
  category: "property_guidance",
  destination: "Oaxaca",
  body: "Hacienda Tierra Roja: casitas 3–5 face the mezcal garden and are the quietest. Rafael Montes usually arranges a mezcal tasting; email rafael@haciendatr.mx.",
  sharingPermission: "network",
  confidentiality: "shareable",
  confidence: "high",
  sourceObservationIds: [],
  dependsOnPersonId: null,
  ...over,
});

/** Canned model: redaction review and source check answered by which prompt arrives. */
function fakeLLM(opts: { flags?: { span: string; kind: string; reason: string }[]; consistent?: boolean } = {}): StructuredLLM & { calls: number } {
  const fake = {
    calls: 0,
    async generate<S extends z.ZodType>(req: StructuredRequest<S>) {
      fake.calls++;
      const out = req.input.startsWith("<item") ? { findings: opts.flags ?? [] } : { consistent: opts.consistent ?? true, issues: opts.consistent === false ? ["overstates"] : [] };
      return { ok: true as const, value: req.schema.parse(out) as z.infer<S> };
    },
  };
  return fake;
}

const networkBodies = async (t: Tenant) => (await withTenant(db, t, (q) => knowledge.listNetworkKnowledge(q))).map((k) => k.body);

describe("publication pipeline", () => {
  beforeEach(() => setupNetwork());

  it("checks permission first: nothing is redacted or queued for an item the owner didn't permit", async () => {
    const id = await knowledge.createItem(db, expert, itemInput({ sharingPermission: "workspace" }), NOW);
    const r = await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW });
    expect(r).toMatchObject({ status: "blocked", reason: expect.stringMatching(/up to workspace/) });
    const row = await withTenant(db, expert, (q) => knowledge.getItem(q, id));
    expect(row).toMatchObject({ publicationStatus: "draft", candidateBody: null });
    const { rows } = await withTenant(db, expert, (q) => q.query("select 1 from audit_events where action = 'knowledge.publication_blocked' and subject = $1", [id]));
    expect(rows).toHaveLength(1);
  });

  it("restricted categories never publish, not even by standing rule or a direct write", async () => {
    const restricted = "00000000-0000-4000-8000-000000000602"; // seeded commercial terms
    for (const scope of ["workspace", "network"] as const) {
      expect(await knowledge.submitForPublication(db, expert, restricted, scope, { agents: false, now: NOW })).toMatchObject({ status: "blocked" });
    }
    await expect(knowledge.setStandingRule(db, expert, "commercial_terms", "workspace", NOW)).rejects.toThrow(/never publish/);
    await expect(knowledge.createItem(db, expert, itemInput({ category: "relationship_concession" }), NOW)).rejects.toThrow(/stay private/);
    await expect(
      withTenant(db, expert, (q) =>
        q.query(
          `insert into published_knowledge (id, workspace_id, item_id, owner_id, category, scope, body, confidence, source_fingerprint)
           values (gen_random_uuid(), $1, $2, $3, 'commercial_terms', 'workspace', 'x', 'high', 'x')`,
          [DEMO.workspace, restricted, DEMO.expert],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("confidential items stay in the workspace; colleagues see only the redacted copy", async () => {
    const id = await knowledge.createItem(db, expert, itemInput({ confidentiality: "confidential" }), NOW);
    expect(await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW })).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/do not leave the workspace/),
    });
    expect(await knowledge.submitForPublication(db, expert, id, "workspace", { agents: false, now: NOW })).toMatchObject({ status: "awaiting_owner" });
    await knowledge.approvePublication(db, expert, id, null, NOW);

    const seenByAssistant = await withTenant(db, assistant, (q) => knowledge.listWorkspaceKnowledge(q));
    expect(seenByAssistant).toHaveLength(1);
    expect(seenByAssistant[0]!.body).toBe(
      "Hacienda Tierra Roja: [room] face the mezcal garden and are the quietest. [person] usually arranges a mezcal tasting; email [email].",
    );
    // The source stays the owner's.
    expect((await withTenant(db, assistant, (q) => q.query("select id from knowledge_items where id = $1", [id]))).rows).toEqual([]);
    expect(await networkBodies(camille)).not.toContain(seenByAssistant[0]!.body);
  });

  it("goes to the owner's queue when agents are off, and publishes to the network on approval", async () => {
    const id = await knowledge.createItem(db, expert, itemInput(), NOW);
    const r = await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW });
    expect(r).toMatchObject({ status: "awaiting_owner", reasons: expect.arrayContaining([expect.stringMatching(/Automated review unavailable/)]) });
    expect(await withTenant(db, expert, (q) => listPendingPublicationIds(q))).toContain(id);
    expect(await networkBodies(camille)).toEqual([]); // nothing leaves before the owner approves
    await knowledge.approvePublication(db, expert, id, null, NOW);
    const bodies = await networkBodies(camille);
    expect(bodies).toContain("Hacienda Tierra Roja: [room] face the mezcal garden and are the quietest. [person] usually arranges a mezcal tasting; email [email].");
  });

  it("items queued before the pipeline ran show and publish a redacted candidate", async () => {
    const seeded = "00000000-0000-4000-8000-000000000601"; // awaiting_owner in the base seed, no candidate yet
    const [pending] = await withTenant(db, expert, (q) => knowledge.listAwaitingOwner(q));
    expect(pending).toMatchObject({ id: seeded, targetScope: "network" });
    expect(pending!.candidateBody).toBe("Hacienda Tierra Roja: [room] face the mezcal garden and are the quietest; avoid [room] (next to the service road).");
    await knowledge.approvePublication(db, expert, seeded, null, NOW);
    expect(await networkBodies(camille)).toEqual([pending!.candidateBody]);
  });

  it("holds owner edits to the source: removing is fine, adding or overstating is refused, identifiers are re-redacted", async () => {
    const id = await knowledge.createItem(db, expert, itemInput(), NOW);
    await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW });
    await expect(knowledge.approvePublication(db, expert, id, "Hacienda Tierra Roja always upgrades network clients.", NOW)).rejects.toThrow(/adds wording/);
    await expect(knowledge.approvePublication(db, expert, id, "Hacienda Tierra Roja: [person] arranges a mezcal tasting.", NOW)).rejects.toThrow(/usually/);
    await knowledge.approvePublication(db, expert, id, "Hacienda Tierra Roja: casitas 3–5 are the quietest. Rafael usually arranges a mezcal tasting.", NOW);
    expect(await networkBodies(camille)).toContain("Hacienda Tierra Roja: [room] are the quietest. [person] usually arranges a mezcal tasting.");
  });

  it("standing rules publish without per-item approval only when the review agents come back clean", async () => {
    await knowledge.setStandingRule(db, expert, "property_guidance", "network", NOW);
    const clean = await knowledge.createItem(db, expert, itemInput({ body: "Hacienda Tierra Roja: the rooftop is usually quiet before 9." }), NOW);
    expect(await knowledge.submitForPublication(db, expert, clean, "network", { agents: true, now: NOW })).toEqual({ status: "processing" });
    const llm = fakeLLM();
    expect(await drain(db, makeHandlers({ llm: () => llm, now: () => NOW }))).toBe(1);
    expect(llm.calls).toBe(2);
    expect(await withTenant(db, expert, (q) => knowledge.getItem(q, clean))).toMatchObject({ publicationStatus: "published", publishedScope: "network" });

    // The LLM finds something the detectors missed: removed, and the owner looks.
    const flagged = await knowledge.createItem(db, expert, itemInput({ body: "Ask for Chucho at the bar; he usually pours the good mezcal." }), NOW);
    await knowledge.submitForPublication(db, expert, flagged, "network", { agents: true, now: NOW });
    await drain(db, makeHandlers({ llm: () => fakeLLM({ flags: [{ span: "Chucho", kind: "person_name", reason: "staff name" }] }), now: () => NOW }));
    const row = await withTenant(db, expert, (q) => knowledge.getItem(q, flagged));
    expect(row).toMatchObject({ publicationStatus: "awaiting_owner", candidateBody: "Ask for [redacted] at the bar; he usually pours the good mezcal." });
    expect(row!.holdReasons.join()).toMatch(/more identifying/);

    // No rule for dining: always the owner.
    const dining = await knowledge.createItem(db, expert, itemInput({ category: "dining", body: "The comal lunch is usually the best meal." }), NOW);
    await knowledge.submitForPublication(db, expert, dining, "network", { agents: true, now: NOW });
    await drain(db, makeHandlers({ llm: () => fakeLLM(), now: () => NOW }));
    expect(await withTenant(db, expert, (q) => knowledge.getItem(q, dining))).toMatchObject({ publicationStatus: "awaiting_owner" });
  });

  it("with agents off, a standing rule still waits for the owner to confirm the source check", async () => {
    await knowledge.setStandingRule(db, expert, "property_guidance", "network", NOW);
    const id = await knowledge.createItem(db, expert, itemInput({ body: "The rooftop is usually quiet before 9." }), NOW);
    expect(await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW })).toMatchObject({ status: "awaiting_owner" });
    // And a review job with no model configured routes to the owner too.
    const id2 = await knowledge.createItem(db, expert, itemInput({ body: "The pool is usually empty at noon." }), NOW);
    await knowledge.submitForPublication(db, expert, id2, "network", { agents: true, now: NOW });
    await drain(db, makeHandlers({ llm: () => null, now: () => NOW }));
    expect(await withTenant(db, expert, (q) => knowledge.getItem(q, id2))).toMatchObject({ publicationStatus: "awaiting_owner" });
  });

  it("the review job is idempotent and ignores stale submissions", async () => {
    await knowledge.setStandingRule(db, expert, "property_guidance", "network", NOW);
    const id = await knowledge.createItem(db, expert, itemInput({ body: "The rooftop is usually quiet before 9." }), NOW);
    await knowledge.submitForPublication(db, expert, id, "network", { agents: true, now: NOW });
    const key = (await withTenant(db, expert, (q) => knowledge.getItem(q, id)))!.submissionKey!;
    // The owner edits the source before the job runs: the submission is void.
    await knowledge.updateItem(db, expert, id, itemInput({ body: "The rooftop is quiet before 9, except Sundays." }), NOW);
    expect(await knowledge.completePublicationReview(db, expert, id, key, fakeLLM(), NOW)).toBe("stale");
    expect(await withTenant(db, expert, (q) => knowledge.getItem(q, id))).toMatchObject({ publicationStatus: "draft" });
  });

  it("items that need review are held back from the network until the owner reviews them", async () => {
    const id = await knowledge.createItem(db, expert, itemInput({ dependsOnPersonId: DEMO.gm }), NOW);
    await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW });
    await knowledge.approvePublication(db, expert, id, null, NOW);
    expect((await networkBodies(camille)).some((b) => b.includes("mezcal garden"))).toBe(true);

    // The CRM flags it when Rafael changes roles; any colleague (or job) can raise the flag without reading the item.
    const { rows } = await withTenant(db, assistant, (q) => q.query<{ n: number }>("select flag_knowledge_for_person($1) as n", [DEMO.gm]));
    expect(rows[0]!.n).toBe(1);
    expect((await networkBodies(camille)).some((b) => b.includes("mezcal garden"))).toBe(false);
    expect(await withTenant(db, assistant, (q) => knowledge.listWorkspaceKnowledge(q))).toEqual([]);
    expect(await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW })).toMatchObject({ status: "blocked", reason: expect.stringMatching(/Held back/) });

    await knowledge.markReviewed(db, expert, id, NOW);
    expect((await networkBodies(camille)).some((b) => b.includes("mezcal garden"))).toBe(true);
  });

  it("withdrawing removes the published copy everywhere", async () => {
    const id = await knowledge.createItem(db, expert, itemInput(), NOW);
    await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW });
    await knowledge.approvePublication(db, expert, id, null, NOW);
    await knowledge.withdrawPublication(db, expert, id, NOW);
    expect((await networkBodies(camille)).some((b) => b.includes("mezcal garden"))).toBe(false);
    expect(await withTenant(db, backup, (q) => knowledge.listWorkspaceKnowledge(q))).toEqual([]);
  });
});

describe("network visibility (cross-workspace RLS)", () => {
  async function publishNetworkItem() {
    const id = await knowledge.createItem(db, expert, itemInput(), NOW);
    await knowledge.submitForPublication(db, expert, id, "network", { agents: false, now: NOW });
    await knowledge.approvePublication(db, expert, id, null, NOW);
    const ws = await knowledge.createItem(db, expert, itemInput({ sharingPermission: "workspace", body: "Workspace-only: the spa is usually calm." }), NOW);
    await knowledge.submitForPublication(db, expert, ws, "workspace", { agents: false, now: NOW });
    await knowledge.approvePublication(db, expert, ws, null, NOW);
  }

  it("a workspace outside the network sees nothing", async () => {
    await setupNetwork();
    await publishNetworkItem();
    expect(await networkBodies(outsider)).toEqual([]);
    expect(await withTenant(db, outsider, (q) => searchNetwork(q, {}))).toEqual([]);
    const counts = await withTenant(db, outsider, async (q) => ({
      members: (await q.query("select * from network_members")).rows.length,
      profiles: (await q.query("select * from network_profiles where workspace_id <> $1", [THIRD_WS])).rows.length,
      published: (await q.query("select * from published_knowledge")).rows.length,
    }));
    expect(counts).toEqual({ members: 0, profiles: 0, published: 0 });
  });

  it("admission is required on both sides", async () => {
    await setupNetwork([DEMO.workspace]);
    await publishNetworkItem();
    expect(await networkBodies(camille)).toEqual([]);
    expect(await withTenant(db, expert, (q) => searchNetwork(q, {}))).toEqual([]);
    await admitToNetwork(db, DEMO.otherWorkspace, { operator: "ops@platform" }, NOW);
    expect((await networkBodies(camille)).length).toBe(1);
    expect((await withTenant(db, expert, (q) => searchNetwork(q, { destination: "paris" }))).map((p) => p.displayName)).toEqual(["Camille Roux"]);
  });

  it("admitted workspaces see only network-scoped knowledge and discoverable profiles, never private items or membership rows", async () => {
    await setupNetwork();
    await publishNetworkItem();
    const seen = await withTenant(db, camille, async (q) => ({
      published: (await q.query<{ scope: string }>("select scope from published_knowledge where workspace_id = $1", [DEMO.workspace])).rows,
      items: (await q.query("select * from knowledge_items where workspace_id = $1", [DEMO.workspace])).rows,
      members: (await q.query("select * from network_members where workspace_id = $1", [DEMO.workspace])).rows,
      observations: (await q.query("select * from observations where workspace_id = $1", [DEMO.workspace])).rows,
    }));
    expect(seen.published).toEqual([{ scope: "network" }]);
    expect(seen.items).toEqual([]);
    expect(seen.members).toEqual([]);
    expect(seen.observations).toEqual([]);

    await saveProfile(db, expert, { displayName: "Marisol Vega", headline: null, destinations: ["Oaxaca"], capabilities: [], languages: [], responseCapacity: "available", discoverable: false }, NOW);
    expect(await withTenant(db, camille, (q) => searchNetwork(q, {}))).toEqual([]);
  });

  it("removal from the network hides a workspace's profiles and knowledge immediately", async () => {
    await setupNetwork();
    await publishNetworkItem();
    await removeFromNetwork(db, DEMO.workspace, { operator: "ops@platform", reason: "test" }, NOW);
    expect(await networkBodies(camille)).toEqual([]);
    expect(await withTenant(db, camille, (q) => searchNetwork(q, {}))).toEqual([]);
    expect((await withTenant(db, expert, (q) => membership(q))).status).toBe("removed");
  });

  it("membership is curated: workspaces apply, only the platform admits", async () => {
    await setupNetwork([]);
    await expect(applyForMembership(db, assistant, null, NOW)).rejects.toThrow(/owner or admin/);
    await applyForMembership(db, expert, "Founding expert", NOW);
    expect((await withTenant(db, expert, (q) => membership(q))).status).toBe("applied");
    await expect(
      withTenant(db, outsider, (q) => q.query("insert into network_members (workspace_id, requested_by, admitted_at, admitted_by) values ($1, $2, now(), 'me')", [THIRD_WS, outsider.memberId])),
    ).rejects.toThrow(/row-level security/);
    await expect(withTenant(db, expert, (q) => q.query("update network_members set admitted_at = now()"))).rejects.toThrow(/permission denied/);
  });

  it("profiles never carry contact details", async () => {
    await setupNetwork();
    await expect(
      saveProfile(db, expert, { displayName: "Marisol (marisol@example.com)", headline: null, destinations: [], capabilities: [], languages: [], responseCapacity: "available", discoverable: true }, NOW),
    ).rejects.toThrow(/contact details/);
  });

  it("the demo seed is idempotent and shows the cross-workspace demo", async () => {
    await withSystem(db, (q) => seedNetwork(q, NOW));
    await withSystem(db, (q) => seedNetwork(q, NOW));
    expect((await networkBodies(expert)).some((b) => b.includes("Tilleuls"))).toBe(true);
    const incoming = await withTenant(db, camille, (q) => collab.listCollaborations(q));
    expect(incoming.map((c) => c.id)).toContain(NETWORK_DEMO.collaboration);
  });
});

describe("observations", () => {
  const input = {
    supplierName: "Hacienda Tierra Roja",
    observedAt: "2026-09-20",
    source: "supplier_claim" as const,
    personallyInspected: false,
    statement: "Late checkout usually possible",
    applicability: { program: null, roomCategory: null, season: "Autumn", relationshipInvolved: false },
    request: "late_checkout",
    outcome: "denied" as const,
    bookingRef: null,
    scope: "private" as const,
  };

  it("records failures, keeps private observations private and encrypts photos", async () => {
    const store = new MemoryStore();
    const id = await createObservation(db, expert, input, NOW);
    expect((await withTenant(db, assistant, (q) => listObservations(q))).map((o) => o.id)).not.toContain(id);
    const bytes = Buffer.from("\x89PNG fake image bytes");
    await attachPhoto(db, expert, id, { bytes, contentType: "image/png" }, store, NOW);
    const [stored] = [...store.items.values()];
    expect(stored!.includes(bytes)).toBe(false);
    expect(await readPhoto(db, expert, id, store)).toEqual({ bytes, contentType: "image/png" });
    expect(await readPhoto(db, assistant, id, store)).toBeNull();
    await expect(attachPhoto(db, expert, id, { bytes, contentType: "application/pdf" }, store, NOW)).rejects.toThrow(/JPEG/);
    await expect(createObservation(db, expert, { ...input, observedAt: "2027-01-01" }, NOW)).rejects.toThrow(/future/);
    await deleteObservation(db, expert, id, store);
    expect(store.items.size).toBe(0);
  });
});

describe("collaborations", () => {
  beforeEach(() => setupNetwork());

  const request = () =>
    collab.requestCollaboration(
      db,
      expert,
      {
        specialistMemberId: DEMO.otherExpert,
        contribution: "review_itinerary",
        tripId: DEMO.trip,
        destination: "Paris",
        text: "The Whitfields (Tom and Priya) loved Casa Alma; Rafael Montes knows them. Budget $40,000. Can you review Paris?",
        partySize: 2,
        budgetBand: "Upper luxury",
        dates: "Late January, 3 nights",
      },
      NOW,
    );

  const terms = (over: Partial<collab.TermsInput> = {}): collab.TermsInput => ({
    finalRecommendationOwner: "requester",
    delegatedDecisions: ["Paris hotel choice"],
    changesRequiringSpecialistReview: ["Any Paris hotel change"],
    deliveryOwners: [{ service: "Paris hotel", owner: "requester" }],
    attributionRule: "with_endorsement",
    specialistVisibleToClient: true,
    fees: [
      { kind: "advisory", payee: "specialist", amount: { amountMinor: 50_000, currency: "USD" }, commissionShareBps: null, bookingItemIds: [] },
      { kind: "commission_split", payee: "specialist", amount: null, commissionShareBps: 2000, bookingItemIds: [DEMO.hotelCdmx] },
    ],
    nonSolicit: true,
    clientAccessExpiresAt: future(30),
    reversalLossBearer: "shared_pro_rata",
    notes: null,
    ...over,
  });

  async function agree(id: string) {
    await collab.respondToRequest(db, camille, id, "accept", null, NOW);
    await collab.proposeTerms(db, expert, id, terms(), NOW);
    const v = (await withTenant(db, camille, (q) => collab.listTerms(q, id))).at(-1)!;
    await collab.acceptTerms(db, camille, id, v.version, v.fingerprint, NOW);
  }

  const sharesSeenBy = async (t: Tenant, id: string) => (await withTenant(db, t, (q) => collab.listShares(q, id))).map((s) => s.label);

  it("the specialist sees an anonymized brief, and client details only after both sides accept the same terms", async () => {
    const id = await request();
    const seen = await withTenant(db, camille, (q) => collab.getCollaboration(q, id));
    expect(seen!.brief.text).toBe("[client] (Tom and Priya) loved Casa Alma; [person] knows them. Budget [amount]. Can you review Paris?");
    expect(await withTenant(db, outsider, (q) => collab.getCollaboration(q, id))).toBeNull();
    expect(await withTenant(db, CAMILLE_COLLEAGUE, (q) => collab.getCollaboration(q, id))).toBeNull();

    await collab.respondToRequest(db, camille, id, "accept", null, NOW);
    await collab.addShare(db, expert, id, { kind: "trip_item", sourceId: DEMO.hotelCdmx }, NOW);
    await collab.addShare(db, expert, id, { kind: "client", sourceId: DEMO.client }, NOW);
    expect(await sharesSeenBy(camille, id)).toEqual([]);

    const v1 = await collab.proposeTerms(db, expert, id, terms(), NOW);
    expect(await sharesSeenBy(camille, id)).toEqual([]); // proposed, not agreed
    const t1 = (await withTenant(db, camille, (q) => collab.listTerms(q, id))).find((t) => t.version === v1)!;
    await expect(collab.acceptTerms(db, camille, id, v1, "stale-fingerprint", NOW)).rejects.toThrow(/changed/);
    // Camille counters; v1 is superseded and can't be accepted any more.
    const v2 = await collab.proposeTerms(db, camille, id, terms({ attributionRule: "never" }), NOW);
    await expect(collab.acceptTerms(db, camille, id, v1, t1.fingerprint, NOW)).rejects.toThrow(/replaced/);
    expect(await sharesSeenBy(camille, id)).toEqual([]);
    const t2 = (await withTenant(db, expert, (q) => collab.listTerms(q, id))).find((t) => t.version === v2)!;
    expect(t2.terms.fees[1]!.bookingItemLabels).toEqual(["Casa Alma, Roma Norte — 4 nights, garden suite"]);
    expect(await collab.acceptTerms(db, expert, id, v2, t2.fingerprint, NOW)).toEqual({ agreed: true });

    expect((await sharesSeenBy(camille, id)).sort()).toEqual(["Casa Alma, Roma Norte — 4 nights, garden suite", "Client"]);
    expect(await sharesSeenBy(CAMILLE_COLLEAGUE, id)).toEqual([]);
    expect(await sharesSeenBy(outsider, id)).toEqual([]);
    const state = await withTenant(db, camille, (q) => collab.getCollaboration(q, id));
    expect(state).toMatchObject({ state: "terms_agreed", agreedTermsVersion: v2 });
  });

  it("access ends at expiry, on revocation and when the work is completed", async () => {
    const id = await request();
    await collab.addShare(db, expert, id, { kind: "trip_item", sourceId: DEMO.hotelCdmx }, NOW);
    const noteId = await collab.addShare(db, expert, id, { kind: "note", sourceId: null, text: "They hate early starts." }, NOW);
    await agree(id);
    expect(await sharesSeenBy(camille, id)).toHaveLength(2);

    await collab.revokeShare(db, expert, id, noteId, NOW);
    expect(await sharesSeenBy(camille, id)).toEqual(["Casa Alma, Roma Norte — 4 nights, garden suite"]);

    await withSystem(db, (q) => q.query("update collaborations set client_access_expires_at = now() - interval '1 minute' where id = $1", [id]));
    expect(await sharesSeenBy(camille, id)).toEqual([]);
    expect(await sharesSeenBy(expert, id)).toHaveLength(2); // the requester keeps their own records
    // The expiry job records it once.
    await drain(db, makeHandlers({ now: () => new Date() }), 0);
    await withSystem(db, async (q) => {
      const { logExpiredAccess } = await import("@/modules/network/collaborations");
      expect(await logExpiredAccess(q, new Date())).toBe(1);
      expect(await logExpiredAccess(q, new Date())).toBe(0);
    });

    await withSystem(db, (q) => q.query("update collaborations set client_access_expires_at = $2 where id = $1", [id, future(10)]));
    expect(await sharesSeenBy(camille, id)).toHaveLength(1);
    await collab.startWork(db, camille, id, NOW);
    await collab.complete(db, expert, id, NOW);
    expect(await sharesSeenBy(camille, id)).toEqual([]);
  });

  it("only the parties act, each on their own side; assistants don't agree compensation", async () => {
    const id = await request();
    await expect(collab.respondToRequest(db, expert, id, "accept", null, NOW)).rejects.toThrow(/Only the specialist/);
    await expect(collab.proposeTerms(db, camille, id, terms(), NOW)).rejects.toThrow(/Not possible while/);
    await collab.respondToRequest(db, camille, id, "accept", null, NOW);
    await expect(collab.proposeTerms(db, assistant, id, terms(), NOW)).rejects.toThrow(/Assistants/);
    // The specialist can't reference booking lines they were never shown.
    await expect(collab.proposeTerms(db, camille, id, terms(), NOW)).rejects.toThrow(/isn't part of this collaboration/);
    await expect(collab.proposeTerms(db, expert, id, terms({ fees: [] }), NOW)).rejects.toThrow(/Compensation/);
    await expect(collab.addShare(db, camille, id, { kind: "note", sourceId: null, text: "x" }, NOW)).rejects.toThrow(/Only the requester/);
    await expect(
      collab.requestCollaboration(db, assistant, { specialistMemberId: DEMO.otherExpert, contribution: "answer_question", tripId: null, destination: null, text: "x", partySize: 2, budgetBand: "", dates: "" }, NOW),
    ).rejects.toThrow(/Assistants/);
    await expect(
      collab.requestCollaboration(db, expert, { specialistMemberId: DEMO.otherExpert, contribution: "operate_segment", tripId: null, destination: null, text: "x", partySize: 2, budgetBand: "", dates: "" }, NOW),
    ).rejects.toThrow(/doesn't offer/);
  });

  it("an endorsement lapses when the recommendation changes materially", async () => {
    const id = await request();
    const shareId = await collab.addShare(db, expert, id, { kind: "trip_item", sourceId: DEMO.hotelCdmx }, NOW);
    await agree(id);
    await collab.endorse(db, camille, id, shareId, "Right hotel for them", NOW);
    const status = async (t: Tenant) =>
      withTenant(db, t, async (q) => {
        const c = (await collab.getCollaboration(q, id))!;
        return (await collab.endorsementStatuses(q, c, collab.sideOf(c, t)))[0]!;
      });
    expect(await status(expert)).toMatchObject({ holds: true, nameMayAppear: true });

    // Non-material edits (position, state) don't lapse it; a price change does.
    await withTenant(db, expert, (q) => q.query("update trip_items set position = 9 where id = $1", [DEMO.hotelCdmx]));
    expect((await status(expert)).holds).toBe(true);
    await withTenant(db, expert, (q) => q.query("update trip_items set price_minor = price_minor + 50000 where id = $1", [DEMO.hotelCdmx]));
    expect(await status(expert)).toMatchObject({ holds: false, nameMayAppear: false });
    expect((await status(camille)).holds).toBe(true); // Camille hasn't seen the change yet
    expect(await collab.refreshShare(db, expert, id, shareId, NOW)).toEqual({ changed: true });
    expect((await status(camille)).holds).toBe(false);

    await collab.endorse(db, camille, id, shareId, "Still right at the new rate", NOW);
    expect((await status(expert)).holds).toBe(true);
  });

  it("relationship activation always goes to the holder, every time", async () => {
    const id = await request();
    await collab.respondToRequest(db, camille, id, "accept", null, NOW);
    const first = await collab.requestActivation(db, expert, id, { relationshipHint: "GM at a Marais hotel", ask: "Intro for the Whitfields' anniversary" }, NOW);
    const row = (await withTenant(db, camille, (q) => collab.listActivations(q, id)))[0]!;
    expect(row.ask).toBe("Intro for [client]' anniversary"); // anonymized before terms

    await expect(collab.decideActivationRequest(db, expert, first, "yes", null, NOW)).rejects.toThrow(/relationship holder/);
    await expect(collab.decideActivationRequest(db, CAMILLE_COLLEAGUE, first, "yes", null, NOW)).rejects.toThrow(/not found|relationship holder/);
    await expect(withTenant(db, expert, (q) => q.query("update relationship_activations set decision = 'yes' where id = $1 returning id", [first]))).resolves.toMatchObject({ rows: [] });
    await collab.decideActivationRequest(db, camille, first, "yes", "Happy to", NOW);
    await expect(collab.decideActivationRequest(db, camille, first, "no", null, NOW)).rejects.toThrow(/already answered/);

    // A second ask starts pending again: no standing yes.
    const second = await collab.requestActivation(db, expert, id, { relationshipHint: "Same GM", ask: "Late checkout" }, NOW);
    const all = await withTenant(db, expert, (q) => collab.listActivations(q, id));
    expect(all.map((a) => [a.id, a.decision])).toEqual([
      [first, "yes"],
      [second, "pending"],
    ]);
  });

  it("the contribution log is append-only and records who did what", async () => {
    const id = await request();
    await collab.respondToRequest(db, camille, id, "accept", null, NOW);
    await collab.addLogEntry(db, camille, id, "dispute", "The brief changed after I reviewed it", NOW);
    const log = await withTenant(db, expert, (q) => collab.listLog(q, id));
    expect(log.map((l) => [l.actorSide, l.kind])).toEqual([
      ["requester", "requested"],
      ["specialist", "accepted"],
      ["specialist", "dispute"],
    ]);
    await expect(withTenant(db, camille, (q) => q.query("update collaboration_log set kind = 'note'"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db, expert, (q) => q.query("delete from collaboration_log"))).rejects.toThrow(/permission denied/);
  });
});
