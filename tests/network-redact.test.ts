import { describe, expect, it } from "vitest";
import { anonymizeBrief } from "@/domain/collaboration";
import { termsProblems, type CollaborationTerms } from "@/domain/collaborationTerms";
import type { KnowledgeItem } from "@/domain/knowledge";
import { matchProfiles, parseList, type NetworkProfile } from "@/domain/networkSearch";
import { checkPublicationPermission, requestableScopes, routeAfterReview } from "@/domain/publication";
import { contactDetailsIn, createRedactor, deterministicSourceCheck } from "@/modules/network/redact";
import { supplierView, type ObservationRow } from "@/modules/network/observations";
import { NOW } from "./fixtures";

describe("redactor detectors", () => {
  const r = createRedactor();

  it("removes emails, links and phone numbers", () => {
    const out = r.redact("Write to rafael.m@haciendatr.mx or see https://haciendatr.mx/rooms, or call +52 951 123 4567 (or 951-555-0199).");
    expect(out.text).toBe("Write to [email] or see [link], or call [phone] (or [phone]).");
    expect(out.findings.map((f) => f.kind)).toEqual(["email", "url", "phone", "phone"]);
  });

  it("removes prices and commercial figures", () => {
    const out = r.redact("Net was $1,475 a night, MXN 9,800 for the transfer, 450 EUR deposit, and 15% off BAR; commission 12.5 percent.");
    expect(out.text).toBe("Net was [amount] a night, [amount] for the transfer, [amount] deposit, and [figure] off BAR; commission [figure].");
  });

  it("removes room numbers, including ranges", () => {
    const out = r.redact("Casitas 3–5 face the garden; avoid casita 1 and Room 412. Suite #12B was fine.");
    expect(out.text).toBe("[room] face the garden; avoid [room] and [room]. [room] was fine.");
  });

  it("leaves dates, durations and ordinary numbers alone", () => {
    const text = "Visited 2026-09-14 for 5 nights with 2 guests; breakfast 8:30–9:30, 3 pools, open 1998–2024.";
    expect(r.redact(text)).toEqual({ text, findings: [] });
  });

  it("removes workspace names: full names, capitalized tokens and family names", () => {
    const withNames = createRedactor([
      { name: "Rafael Montes", kind: "person" },
      { name: "The Whitfields", kind: "client" },
      { name: "Marisol Vega", kind: "member" },
    ]);
    const out = withNames.redact("rafael montes upgraded the Whitfields; Rafael's team knew Mrs Whitfield. Ask Marisol.");
    expect(out.text).toBe("[person] upgraded [client]; [person] team knew Mrs [client]. Ask [advisor].");
    // Its own output is stable: placeholders are never re-detected.
    expect(withNames.redact(out.text).findings).toEqual([]);
  });

  it("removes exact spans flagged by the LLM review", () => {
    expect(r.redact("Ask for the night manager, Chucho, by the bar.", ["Chucho"]).text).toBe("Ask for the night manager, [redacted], by the bar.");
  });

  it("finds contact details for profile validation", () => {
    expect(contactDetailsIn("Paris & Loire").length).toBe(0);
    expect(contactDetailsIn("camille@example.com").map((f) => f.kind)).toEqual(["email"]);
    expect(contactDetailsIn("WhatsApp +33 6 12 34 56 78").map((f) => f.kind)).toEqual(["phone"]);
  });
});

describe("deterministic source check", () => {
  const source = "Late checkout is usually possible, but not during festival weeks.";

  it("passes pure removals", () => {
    expect(deterministicSourceCheck(source, "Late checkout is usually possible, but not during festival weeks.").ok).toBe(true);
    expect(deterministicSourceCheck("Ask Rafael for casita 4.", "Ask [person] for [room].").ok).toBe(true);
  });

  it("fails when the redacted text adds wording", () => {
    const r = deterministicSourceCheck(source, "Late checkout is always possible, but not during festival weeks.");
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/always/);
  });

  it("fails when a qualifier is dropped (overstating)", () => {
    const r = deterministicSourceCheck(source, "Late checkout is possible during festival weeks.");
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/usually/);
    expect(r.issues.join()).toMatch(/not/);
  });

  it("fails when nothing of substance is left", () => {
    expect(deterministicSourceCheck("Rafael Montes", "[person]").ok).toBe(false);
  });
});

describe("publication routing (pure)", () => {
  const item = (over: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
    id: "k",
    ownerId: "o",
    category: "property_guidance",
    body: "Quiet rooms face the garden.",
    sharingPermission: "network",
    confidentiality: "shareable",
    confidence: "high",
    publishedScope: "private",
    sourceObservationIds: [],
    ...over,
  });

  it("checks permission before anything else", () => {
    expect(checkPublicationPermission(item({ sharingPermission: "workspace" }), "network", { needsReview: false })).toMatchObject({ ok: false });
    expect(checkPublicationPermission(item({ category: "commercial_terms" }), "workspace", { needsReview: false })).toMatchObject({ ok: false });
    expect(checkPublicationPermission(item({ confidentiality: "confidential" }), "network", { needsReview: false })).toMatchObject({ ok: false });
    expect(checkPublicationPermission(item({ confidentiality: "confidential" }), "workspace", { needsReview: false })).toEqual({ ok: true });
    expect(checkPublicationPermission(item({ category: "contact_details" }), "network", { needsReview: false })).toMatchObject({ ok: false });
    expect(checkPublicationPermission(item(), "network", { needsReview: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/Held back/) });
    expect(requestableScopes(item({ confidentiality: "confidential" }))).toEqual(["workspace"]);
  });

  it("auto-publishes only with a rule and every automated check clean", () => {
    const clean = { agentsAvailable: true, llmReview: { findings: 0, restricted: false }, deterministicSource: { ok: true, issues: [] }, llmSource: { consistent: true, issues: [] } };
    expect(routeAfterReview(true, clean)).toEqual({ route: "auto_publish" });
    expect(routeAfterReview(false, clean).route).toBe("owner_review");
    expect(routeAfterReview(true, { ...clean, agentsAvailable: false, llmReview: null, llmSource: null }).route).toBe("owner_review");
    expect(routeAfterReview(true, { ...clean, llmReview: { findings: 1, restricted: false } }).route).toBe("owner_review");
    expect(routeAfterReview(true, { ...clean, llmSource: { consistent: false, issues: ["overstates"] } }).route).toBe("owner_review");
    expect(routeAfterReview(true, { ...clean, deterministicSource: { ok: false, issues: ["adds"] } }).route).toBe("owner_review");
  });
});

describe("collaboration terms (pure)", () => {
  const base = (): CollaborationTerms => ({
    authority: {
      briefOwner: "r",
      finalRecommendationOwner: "r",
      delegatedDecisions: [],
      changesRequiringSpecialistReview: [],
      deliveryOwners: {},
      attributionRule: "with_endorsement",
      specialistVisibleToClient: true,
    },
    fees: [{ kind: "advisory", payee: "specialist", amount: { amountMinor: 50_000, currency: "USD" }, commissionShareBps: null, bookingItemIds: [], bookingItemLabels: [] }],
    nonSolicit: true,
    clientAccessExpiresAt: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
    reversalLossBearer: "shared_pro_rata",
    notes: null,
  });

  it("accepts well-formed terms", () => expect(termsProblems(base(), NOW)).toEqual([]));

  it("rejects missing compensation, bad splits, past expiry and contradictory attribution", () => {
    const t = base();
    t.fees = [
      { kind: "commission_split", payee: "specialist", amount: null, commissionShareBps: 6000, bookingItemIds: ["a"], bookingItemLabels: ["A"] },
      { kind: "commission_split", payee: "specialist", amount: null, commissionShareBps: 5000, bookingItemIds: ["a"], bookingItemLabels: ["A"] },
      { kind: "commission_split", payee: "specialist", amount: null, commissionShareBps: 1000, bookingItemIds: [], bookingItemLabels: [] },
    ];
    t.clientAccessExpiresAt = new Date(NOW.getTime() - 1000).toISOString();
    t.authority.specialistVisibleToClient = false;
    t.authority.attributionRule = "always";
    const p = termsProblems(t, NOW).join("\n");
    expect(p).toMatch(/more than 100%/);
    expect(p).toMatch(/specific booking lines/);
    expect(p).toMatch(/expire in the future/);
    expect(p).toMatch(/behind the scenes/);
    expect(termsProblems({ ...base(), fees: [] }, NOW).join()).toMatch(/Compensation/);
  });

  it("anonymizes the client's name in a brief", () => {
    expect(anonymizeBrief({ clientName: "The Whitfields", text: "The Whitfields want quiet rooms", partySize: 2, budgetBand: "x", dates: "y" }).text).toBe("[client] want quiet rooms");
  });
});

describe("network search (pure)", () => {
  const p = (over: Partial<NetworkProfile>): NetworkProfile => ({
    memberId: "m",
    workspaceId: "w",
    displayName: "X",
    headline: null,
    destinations: [],
    capabilities: [],
    languages: [],
    responseCapacity: "available",
    ...over,
  });

  it("matches destinations accent-insensitively and ranks by capacity", () => {
    const profiles = [
      p({ memberId: "a", displayName: "Ana", destinations: ["Ciudad de México"], capabilities: ["answer_question"], responseCapacity: "unavailable" }),
      p({ memberId: "b", displayName: "Beto", destinations: ["Mexico City", "Oaxaca"], capabilities: ["answer_question", "review_itinerary"] }),
      p({ memberId: "c", displayName: "Cam", destinations: ["Paris"], capabilities: ["answer_question"] }),
    ];
    expect(matchProfiles(profiles, { destination: "mexico" }).map((m) => m.memberId)).toEqual(["b", "a"]);
    expect(matchProfiles(profiles, { destination: "méxico", capability: "review_itinerary" }).map((m) => m.memberId)).toEqual(["b"]);
    expect(parseList("Paris, paris,  Loire Valley\nChampagne")).toEqual(["Paris", "Loire Valley", "Champagne"]);
  });
});

describe("supplier view", () => {
  const o = (over: Partial<ObservationRow>): ObservationRow => ({
    id: "o",
    supplierId: "H",
    supplierName: "H",
    observedAt: "2026-09-01",
    source: "firsthand",
    personallyInspected: false,
    statement: "s",
    applicability: { program: "P", roomCategory: "Casita", season: "Summer", relationshipInvolved: false },
    request: null,
    outcome: null,
    bookingRef: null,
    ownerId: "m",
    ownerName: "M",
    scope: "workspace",
    hasPhoto: false,
    ...over,
  });

  it("shows provenance honestly and counts failures under matching applicability", () => {
    const v = supplierView(
      [
        o({ id: "1", request: "upgrade", outcome: "granted", applicability: { program: "P", roomCategory: "Casita", season: "Summer", relationshipInvolved: true } }),
        o({ id: "2", request: "upgrade", outcome: "denied", applicability: { program: "P", roomCategory: "Casita", season: "Summer", relationshipInvolved: true } }),
        o({ id: "3", request: "upgrade", outcome: "granted", applicability: { program: "Q", roomCategory: "Casita", season: "Winter", relationshipInvolved: false } }),
        o({ id: "4", source: "supplier_claim", personallyInspected: false }),
        o({ id: "5", source: "written_confirmation", bookingRef: "B1" }),
      ],
      NOW,
      { season: "Summer" },
    );
    expect(v.observations.find((x) => x.id === "4")!.provenance).toBe("Supplier claim, 2026-09-01, not personally inspected");
    expect(v.observations.find((x) => x.id === "4")!.tier).toBe("retain");
    expect(v.observations.find((x) => x.id === "1")!.tier).toBe("recommend");
    expect(v.observations.find((x) => x.id === "5")!.tier).toBe("commit");
    expect(v.trackRecords).toEqual([{ request: "upgrade", granted: 1, denied: 1, partial: 0, relationshipDependent: 2, total: 2 }]);
  });
});
