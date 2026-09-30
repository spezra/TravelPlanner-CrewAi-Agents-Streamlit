import { describe, expect, it } from "vitest";
import { evaluateAction } from "@/domain/actionGate";
import { checkCoverage, decideApproval, requestApproval } from "@/domain/approvals";
import { buildAttentionQueue } from "@/domain/attention";
import { describePerksForTraveler, missingCredentialFields, summarizeTrip, transitionItem } from "@/domain/bookings";
import { briefForTrip, type BriefStatement } from "@/domain/brief";
import { captureDecision, EXAMPLE_CONSENT_TABLE, onPartiesChanged, routeCall } from "@/domain/calls";
import { anonymizeBrief, specialistMaySeeClientDetails, transitionCollaboration, type Collaboration } from "@/domain/collaboration";
import { evidenceLabel, openFollowThrough, reviewRouting, transitionCommitment } from "@/domain/commitments";
import { DomainError, fingerprint, stableStringify } from "@/domain/common";
import { chipAdvice, nudges, recordMove, warmthEvidence, type LedgerEntry, type Person } from "@/domain/crm";
import { applyOutcome, execute, idempotencyKey, reconcile, type ExecutionAttempt, type ProviderAdapter } from "@/domain/execution";
import { routeDecision, shouldAskWhy, type Decision } from "@/domain/judgment";
import { provenance, publish, requestTrackRecord, trustTier, type KnowledgeItem } from "@/domain/knowledge";
import { allocate, payoutMethod, receivableStatus } from "@/domain/ledger";
import { currentResponder, escalationTarget, type ResponsePlan } from "@/domain/responsePlan";
import { commitment, inHours, item, NOW, observation, terms } from "./fixtures";

describe("common", () => {
  it("stable stringify ignores key order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("trip items", () => {
  it("keeps per-item state; a disruption returns one item to design while the rest stay booked", () => {
    const flight = item({ id: "f", kind: "flight", state: "confirmed" });
    const hotel = item({ id: "h", state: "confirmed" });
    const disrupted = transitionItem(flight, "disrupted");
    expect(summarizeTrip([disrupted, hotel]).stage).toBe("attention");
    const redesign = transitionItem(disrupted, "design");
    expect(summarizeTrip([redesign, hotel])).toMatchObject({ stage: "design", counts: { design: 1, confirmed: 1 } });
  });

  it("cannot leave outcome_unknown except through reconciliation results", () => {
    const unknown = item({ state: "outcome_unknown" });
    expect(() => transitionItem(unknown, "booking")).toThrow(DomainError);
    expect(() => transitionItem(unknown, "design")).toThrow(DomainError);
    expect(transitionItem(unknown, "confirmed").state).toBe("confirmed");
  });

  it("requires every credential field", () => {
    expect(missingCredentialFields(item())).toEqual([]);
    const it2 = item();
    it2.credentials = { ...it2.credentials!, program: null, commissionRecipient: " " };
    expect(missingCredentialFields(it2)).toEqual(["commissionRecipient", "program"]);
    expect(missingCredentialFields(item({ credentials: null }))).toEqual(["credentials"]);
  });

  it("never overstates availability-dependent perks", () => {
    expect(describePerksForTraveler(item().credentials!.perks)).toEqual([
      "Daily breakfast for two",
      "Room upgrade (requested; subject to availability at arrival)",
    ]);
  });
});

describe("executable approvals", () => {
  const actions = [
    { kind: "book" as const, itemId: "item-hotel" },
    { kind: "pay" as const, itemId: "item-hotel" },
  ];
  const approved = () =>
    decideApproval(requestApproval({ id: "a1", tripId: "trip-1", actions, terms: terms(), requestedBy: "agent" }), "approved", "expert-1", NOW);

  it("one approval covers a defined set of actions", () => {
    const a = approved();
    expect(checkCoverage(a, actions[0]!, terms(), NOW).ok).toBe(true);
    expect(checkCoverage(a, actions[1]!, terms(), NOW).ok).toBe(true);
    const other = checkCoverage(a, { kind: "cancel", itemId: "item-hotel" }, terms(), NOW);
    expect(other.ok).toBe(false);
  });

  it("lapses when material terms change, not on a price decrease", () => {
    const a = approved();
    expect(checkCoverage(a, actions[0]!, terms({ price: { amountMinor: 1_200_000, currency: "USD" } }), NOW).ok).toBe(true);
    const up = checkCoverage(a, actions[0]!, terms({ price: { amountMinor: 1_260_000, currency: "USD" } }), NOW);
    expect(up.ok ? [] : up.failures.map((f) => f.code)).toEqual(["price_increased"]);
    const policy = checkCoverage(a, actions[0]!, terms({ cancellationPolicy: "Non-refundable" }), NOW);
    expect(policy.ok ? [] : policy.failures.map((f) => f.code)).toEqual(["terms_changed"]);
    // Reordering downstream changes is not a change.
    const t = terms({ downstreamChanges: ["b", "a"] });
    const a2 = decideApproval(requestApproval({ id: "a2", tripId: "t", actions, terms: t, requestedBy: "x" }), "approved", "e", NOW);
    expect(checkCoverage(a2, actions[0]!, terms({ downstreamChanges: ["a", "b"] }), NOW).ok).toBe(true);
  });

  it("refuses expired offers at decision time and at action time", () => {
    const pending = requestApproval({ id: "a", tripId: "t", actions, terms: terms({ offerExpiresAt: inHours(-1) }), requestedBy: "x" });
    expect(() => decideApproval(pending, "approved", "e", NOW)).toThrow(/expired/);
    const a = approved();
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const r = checkCoverage(a, actions[0]!, terms(), later);
    expect(r.ok ? [] : r.failures.map((f) => f.code)).toContain("offer_expired");
  });
});

describe("action gate", () => {
  const action = { kind: "book" as const, itemId: "item-hotel" };
  it("needs evidence, permission and current conditions together", () => {
    const r = evaluateAction({ action, evidenceTier: "retain", requiredTier: "recommend", approval: null, currentTerms: null, now: NOW });
    expect(r.allowed ? [] : r.failures.map((f) => f.test).sort()).toEqual(["conditions", "evidence", "permission"]);
  });
  it("knowing the right hotel is not permission to book it", () => {
    const a = requestApproval({ id: "a", tripId: "t", actions: [action], terms: terms(), requestedBy: "x" });
    const r = evaluateAction({ action, evidenceTier: "recommend", requiredTier: "recommend", approval: a, currentTerms: terms(), now: NOW });
    expect(r.allowed ? [] : r.failures).toEqual([{ test: "permission", detail: "Approval is pending" }]);
  });
  it("allows when all three pass", () => {
    const a = decideApproval(requestApproval({ id: "a", tripId: "t", actions: [action], terms: terms(), requestedBy: "x" }), "approved", "e", NOW);
    expect(evaluateAction({ action, evidenceTier: "commit", requiredTier: "recommend", approval: a, currentTerms: terms(), now: NOW })).toEqual({ allowed: true });
  });
});

describe("reliable execution", () => {
  const attempt = (): ExecutionAttempt => ({
    id: "x1",
    idempotencyKey: idempotencyKey({ workspaceId: "w", itemId: "i", action: "book", termsFingerprint: "f" }),
    action: "book",
    itemId: "i",
    state: "prepared",
    providerRef: null,
    attempts: 0,
    lastError: null,
  });

  function adapter(submits: Array<() => Promise<Awaited<ReturnType<ProviderAdapter["submit"]>>>>, lookup: ProviderAdapter["lookup"] = async () => ({ kind: "absent" })) {
    const calls: string[] = [];
    const a: ProviderAdapter = {
      name: "fake",
      submit: async (key) => {
        calls.push(key);
        const next = submits.shift();
        if (!next) throw new Error("unexpected submit");
        return next();
      },
      lookup,
    };
    return { a, calls };
  }

  it("idempotency keys are stable per item/action/terms", () => {
    const base = { workspaceId: "w", itemId: "i", action: "book" as const, termsFingerprint: "f" };
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, termsFingerprint: "g" }));
  });

  it("retries only provider-declared retryable errors, with the same key", async () => {
    const { a, calls } = adapter([async () => ({ kind: "retryable", error: "429" }), async () => ({ kind: "accepted", providerRef: "R1" })]);
    const r = await execute(attempt(), a, {});
    expect(r).toMatchObject({ state: "succeeded", providerRef: "R1", attempts: 2 });
    expect(new Set(calls).size).toBe(1);
  });

  it("a timeout becomes outcome_unknown and is never blindly retried", async () => {
    const { a, calls } = adapter([
      async () => {
        throw new Error("socket hang up");
      },
    ]);
    const r = await execute(attempt(), a, {});
    expect(r.state).toBe("outcome_unknown");
    expect(calls).toHaveLength(1);
    // Executing again does nothing until reconciled.
    const again = await execute(r, a, {});
    expect(again).toEqual(r);
  });

  it("'accepted, still processing' is not a failure", () => {
    expect(applyOutcome(attempt(), { kind: "processing" }).state).toBe("outcome_unknown");
  });

  it("reconciliation finds the real reservation instead of double-booking", async () => {
    const unknown = { ...attempt(), state: "outcome_unknown" as const, attempts: 1 };
    const { a } = adapter([], async () => ({ kind: "found", providerRef: "R9" }));
    expect(await reconcile(unknown, a)).toMatchObject({ state: "succeeded", providerRef: "R9" });
    const { a: absent } = adapter([], async () => ({ kind: "absent" }));
    expect((await reconcile(unknown, absent)).state).toBe("retryable_error");
    const { a: flaky } = adapter([], async () => ({ kind: "unknown", error: "503" }));
    expect((await reconcile(unknown, flaky)).state).toBe("outcome_unknown");
    await expect(reconcile(attempt(), absent)).rejects.toThrow(DomainError);
  });
});

describe("judgment capture", () => {
  const d = (over: Partial<Decision> = {}): Decision => ({
    id: "d1",
    expertId: "expert-1",
    tripId: "trip-1",
    clientId: "client-1",
    supplierId: "sup-1",
    kind: "reject",
    subject: "Hotel X",
    before: null,
    after: null,
    decidedAt: NOW.toISOString(),
    reason: null,
    ...over,
  });

  it("routes each reason to a different record", () => {
    const route = (category: Parameters<typeof routeDecision>[0]["reason"] extends infer R ? (R extends { category: infer C } ? C : never) : never) =>
      routeDecision(d({ reason: { category, text: "…", origin: "conversation", validUntil: "2026-11-01" } }))!;
    expect(route("expert_taste")).toMatchObject({ target: "taste_model", recordId: "expert-1", validUntil: null });
    expect(route("client_preference")).toMatchObject({ target: "client_brief", recordId: "client-1" });
    expect(route("supplier_condition")).toMatchObject({ target: "supplier_record", recordId: "sup-1", validUntil: "2026-11-01" });
    expect(route("trip_constraint")).toMatchObject({ target: "trip", recordId: "trip-1" });
  });

  it("inferred reasons are provisional; missing records fall back to the trip", () => {
    const u = routeDecision(d({ clientId: null, reason: { category: "client_preference", text: "t", origin: "inferred", validUntil: null } }))!;
    expect(u).toMatchObject({ target: "trip", recordId: "trip-1", provisional: true });
  });

  it("asks why only when it would materially help", () => {
    expect(shouldAskWhy(d(), { inferredConfidence: null, similarUnexplainedCount: 0 })).toBe(true);
    expect(shouldAskWhy(d({ kind: "select" }), { inferredConfidence: null, similarUnexplainedCount: 5 })).toBe(false);
    expect(shouldAskWhy(d(), { inferredConfidence: 0.9, similarUnexplainedCount: 0 })).toBe(false);
    expect(shouldAskWhy(d({ supplierId: null }), { inferredConfidence: null, similarUnexplainedCount: 1 })).toBe(false);
    expect(shouldAskWhy(d({ reason: { category: "expert_taste", text: "x", origin: "conversation", validUntil: null } }), { inferredConfidence: null, similarUnexplainedCount: 9 })).toBe(false);
  });
});

describe("client brief", () => {
  const s = (id: string, tripId: string | null, over: Partial<BriefStatement> = {}): BriefStatement => ({
    id,
    clientId: "c1",
    tripId,
    dimension: "desired_experience",
    text: id,
    evidence: "client_said",
    source: "call",
    recordedAt: NOW.toISOString(),
    supersededBy: null,
    ...over,
  });
  it("a honeymoon's needs don't leak into the family trip", () => {
    const all = [s("enduring", null), s("honeymoon", "t-honeymoon"), s("family", "t-family"), s("old", null, { supersededBy: "enduring" })];
    const b = briefForTrip(all, "c1", "t-family");
    expect(b.enduring.map((x) => x.id)).toEqual(["enduring"]);
    expect(b.thisTrip.map((x) => x.id)).toEqual(["family"]);
  });
});

describe("supplier knowledge", () => {
  it("only a written confirmation for this booking becomes a traveler commitment", () => {
    expect(trustTier(observation({ source: "supplier_claim" }), NOW)).toBe("retain");
    expect(trustTier(observation(), NOW)).toBe("recommend");
    expect(trustTier(observation({ observedAt: "2023-01-01" }), NOW)).toBe("retain");
    const wc = observation({ source: "written_confirmation", bookingRef: "B1" });
    expect(trustTier(wc, NOW, "B1")).toBe("commit");
    expect(trustTier(wc, NOW, "B2")).toBe("recommend");
  });

  it("shows provenance honestly", () => {
    expect(provenance(observation({ personallyInspected: false, source: "secondhand" }))).toBe("Secondhand, 2026-06-01, not personally inspected");
  });

  it("counts failures alongside successes, per applicability", () => {
    const obs = [
      observation({ id: "1", request: "upgrade", outcome: "granted" }),
      observation({ id: "2", request: "upgrade", outcome: "denied" }),
      observation({ id: "3", request: "upgrade", outcome: "granted", applicability: { program: null, roomCategory: "Suite", season: "winter", relationshipInvolved: true } }),
    ];
    expect(requestTrackRecord(obs, "upgrade")).toMatchObject({ granted: 2, denied: 1, total: 3, relationshipDependent: 1 });
    expect(requestTrackRecord(obs, "upgrade", { program: "Virtuoso" })).toMatchObject({ granted: 1, denied: 1, total: 2 });
  });

  const k = (over: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
    id: "k1",
    ownerId: "expert-1",
    category: "property_guidance",
    body: "Ask Maria for the corner suites; they face the garden.",
    sharingPermission: "network",
    confidentiality: "shareable",
    confidence: "high",
    publishedScope: "private",
    sourceObservationIds: [],
    ...over,
  });
  const ctx = (over: Partial<Parameters<typeof publish>[1]> = {}): Parameters<typeof publish>[1] => ({
    targetScope: "network",
    ownerApproved: true,
    standingRules: [],
    redact: (t) => ({ text: t.replace("Ask Maria for", "Request"), findings: ["PERSON"] }),
    sourceCheck: () => true,
    ...over,
  });

  it("permission first, redaction second", () => {
    expect(publish(k({ category: "commercial_terms" }), ctx())).toMatchObject({ ok: false, failedAt: "permission" });
    expect(publish(k({ sharingPermission: "workspace" }), ctx())).toMatchObject({ ok: false, failedAt: "permission" });
    expect(publish(k({ confidentiality: "confidential" }), ctx())).toMatchObject({ ok: false, failedAt: "permission" });
    expect(publish(k({ confidence: "high" }), ctx({ ownerApproved: false }))).toMatchObject({ ok: false, failedAt: "permission" });
    expect(publish(k(), ctx({ sourceCheck: () => false }))).toMatchObject({ ok: false, failedAt: "source_check" });
    const ok = publish(k(), ctx());
    expect(ok).toMatchObject({ ok: true, redactedBody: "Request the corner suites; they face the garden.", findings: ["PERSON"] });
  });

  it("standing rules extend automation to pre-approved categories", () => {
    const rules = [{ ownerId: "expert-1", category: "property_guidance" as const, scope: "network" as const }];
    expect(publish(k(), ctx({ ownerApproved: false, standingRules: rules })).ok).toBe(true);
    expect(publish(k({ category: "dining" }), ctx({ ownerApproved: false, standingRules: rules })).ok).toBe(false);
  });
});

describe("commitments", () => {
  it("evidence and state are separate", () => {
    const c = commitment();
    expect(transitionCommitment(c, "fulfilled").evidence).toBe("verbal_statement");
    expect(() => transitionCommitment(transitionCommitment(c, "superseded"), "pending")).toThrow(DomainError);
  });
  it("routes consequential or uncertain items to the expert", () => {
    expect(reviewRouting(commitment())).toBe("auto_filed");
    expect(reviewRouting(commitment({ consequential: true }))).toBe("needs_review");
    expect(reviewRouting(commitment({ confidence: 0.5 }))).toBe("needs_review");
    expect(reviewRouting(commitment({ evidence: "machine_transcript" }))).toBe("needs_review");
    expect(reviewRouting(commitment({ evidence: "machine_transcript", transcriptVerified: true }))).toBe("auto_filed");
    expect(evidenceLabel(commitment({ evidence: "machine_transcript" }))).toBe("Machine-transcribed (unchecked)");
  });
  it("overdue follow-through sorts first", () => {
    const list = openFollowThrough([commitment({ id: "a", dueBy: inHours(5) }), commitment({ id: "b", dueBy: inHours(-5) }), commitment({ id: "c", state: "fulfilled" })], NOW);
    expect(list.map((x) => [x.commitment.id, x.overdue])).toEqual([
      ["b", true],
      ["a", false],
    ]);
  });
});

describe("calls and consent", () => {
  it("applies the stricter rule when any party or jurisdiction requires it", () => {
    const ny = { name: "Expert", jurisdiction: "US-NY", consentLoggedAt: null };
    expect(captureDecision([ny, { name: "GM", jurisdiction: "US-TX", consentLoggedAt: null }], EXAMPLE_CONSENT_TABLE).mode).toBe("recorded");
    const ca = captureDecision([ny, { name: "GM", jurisdiction: "US-CA", consentLoggedAt: null }], EXAMPLE_CONSENT_TABLE);
    expect(ca).toMatchObject({ rule: "all_party", mode: "notes", missingConsent: ["Expert", "GM"] });
    const unknown = captureDecision([ny, { name: "Concierge", jurisdiction: null, consentLoggedAt: null }], EXAMPLE_CONSENT_TABLE);
    expect(unknown.rule).toBe("all_party");
    expect(unknown.reason).toMatch(/jurisdiction unclear for Concierge/);
    const consented = captureDecision([{ ...ny, consentLoggedAt: "x" }, { name: "GM", jurisdiction: "US-CA", consentLoggedAt: "x" }], EXAMPLE_CONSENT_TABLE);
    expect(consented.mode).toBe("recorded");
  });
  it("someone joining can downgrade to notes but never silently upgrade", () => {
    const joined = [{ name: "A", jurisdiction: "US-NY", consentLoggedAt: null }, { name: "B", jurisdiction: "FR", consentLoggedAt: null }];
    expect(onPartiesChanged("recorded", joined, EXAMPLE_CONSENT_TABLE)).toBe("notes");
    expect(onPartiesChanged("notes", [{ name: "A", jurisdiction: "US-NY", consentLoggedAt: null }], EXAMPLE_CONSENT_TABLE)).toBe("notes");
  });
  it("relationship capital goes through the holder; automation is disclosed", () => {
    expect(routeCall({ spendsRelationshipCapital: true }, { holderId: "e", authorizedDelegateIds: ["a"], automationPermitted: true })).toMatchObject({ route: "relationship_holder", assignee: "e" });
    expect(routeCall({ spendsRelationshipCapital: false }, { holderId: "e", authorizedDelegateIds: [], automationPermitted: true }).disclosure).toMatch(/automated/);
    expect(routeCall({ spendsRelationshipCapital: false }, { holderId: "e", authorizedDelegateIds: ["a"], automationPermitted: false })).toMatchObject({ route: "delegate", assignee: "a" });
  });
});

describe("relationship CRM", () => {
  const person: Person = {
    id: "p1",
    ownerId: "expert-1",
    name: "Ana Ruiz",
    roles: [{ organization: "Hotel Esencia", propertyId: "sup-1", title: "General Manager", measuredOn: "occupancy and reviews", from: "2022-01-01", to: null }],
    approach: { channel: "WhatsApp", timeZone: "America/Cancun", language: "es", boss: null, goingOverTheirHeadAcceptable: false },
    texture: ["dry humor, hates being rushed"],
    clientIds: [],
  };
  const e = (kind: LedgerEntry["kind"], daysAgo: number, askType: string | null = null): LedgerEntry => ({
    id: `${kind}${daysAgo}`,
    personId: "p1",
    kind,
    at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    note: "",
    askType,
    roomNights: kind === "business_sent" ? 5 : null,
    revenueMinor: null,
  });

  it("warmth is evidence, not a score", () => {
    const w = warmthEvidence([e("favor_asked", 10), e("business_sent", 20), e("recognition_given", 400)], NOW);
    expect(w).toMatchObject({ favorsAsked: 1, businessSent: 1, roomNights: 5, recognitionGiven: 0, balance: 0 });
  });

  it("three upgrade asks and no review sent triggers a nudge and give-first advice", () => {
    const entries = [e("favor_asked", 5, "upgrade"), e("favor_asked", 30, "upgrade"), e("favor_asked", 60, "upgrade")];
    expect(nudges(person, entries, NOW).map((n) => n.kind)).toEqual(["recognition_overdue"]);
    expect(chipAdvice(entries, NOW, { importance: "important" }).advice).toBe("give_first");
    expect(chipAdvice(entries, NOW, { importance: "critical" }).advice).toBe("ask");
    expect(chipAdvice([e("favor_asked", 5)], NOW, { importance: "routine" }).advice).toBe("save");
  });

  it("the relationship follows the person to a new property", () => {
    const moved = recordMove(person, { organization: "Casa Nova", propertyId: "sup-2", title: "Managing Director", measuredOn: null, from: "2026-09-01" }, ["k1"]);
    expect(moved.person.roles).toHaveLength(2);
    expect(moved.person.roles[0]!.to).toBe("2026-09-01");
    expect(moved.newDoor).toMatch(/now Managing Director at Casa Nova \(previously General Manager at Hotel Esencia\)/);
    expect(moved.knowledgeToReview).toEqual(["k1"]);
  });
});

describe("collaboration", () => {
  const base: Collaboration = {
    id: "col1",
    tripId: "t",
    requesterId: "mx",
    specialistId: "paris",
    contribution: "review_itinerary",
    state: "requested",
    authority: null,
    fees: [],
    nonSolicit: true,
    clientAccessExpiresAt: inHours(24 * 30),
  };
  it("client details only after terms, and access expires", () => {
    const shared = transitionCollaboration(base, "brief_shared");
    expect(specialistMaySeeClientDetails(shared, NOW)).toBe(false);
    expect(() => transitionCollaboration(shared, "terms_agreed")).toThrow(/authority/);
    const agreed = transitionCollaboration(
      {
        ...shared,
        authority: {
          briefOwner: "mx",
          finalRecommendationOwner: "mx",
          delegatedDecisions: ["Paris hotel"],
          changesRequiringSpecialistReview: ["hotel", "dates"],
          deliveryOwners: {},
          attributionRule: "with_endorsement",
          specialistVisibleToClient: false,
        },
        fees: [{ kind: "advisory", amount: { amountMinor: 50_000, currency: "USD" }, commissionShareBps: null, bookingItemIds: [] }],
      },
      "terms_agreed",
    );
    expect(specialistMaySeeClientDetails(agreed, NOW)).toBe(true);
    expect(specialistMaySeeClientDetails(agreed, new Date(NOW.getTime() + 31 * 86_400_000))).toBe(false);
  });
  it("anonymizes the brief", () => {
    expect(anonymizeBrief({ clientName: "Smith", text: "The Smith family loves food. smith kids 8 and 11.", partySize: 4, budgetBand: "$$$$", dates: "June" }).text).toBe(
      "The [client] family loves food. [client] kids 8 and 11.",
    );
  });
});

describe("ledger", () => {
  it("adjusts before splitting and allocates exactly", () => {
    const r = { id: "r1", itemId: "i", expectedMinor: 125_000, currency: "USD", expectedBy: "2026-09-01" };
    expect(receivableStatus(r, [], NOW).status).toBe("overdue");
    const events = [
      { receivableId: "r1", kind: "received" as const, amountMinor: 125_000, at: "", note: null },
      { receivableId: "r1", kind: "host_deduction" as const, amountMinor: -25_000, at: "", note: "20% host" },
    ];
    const s = receivableStatus(r, events, NOW);
    expect(s).toMatchObject({ net: 100_000, status: "short", variance: -25_000 });
    const parts = allocate(100_001, [
      { memberId: "a", bps: 3333 },
      { memberId: "b", bps: 3333 },
      { memberId: "c", bps: 3334 },
    ]);
    expect(parts.reduce((x, p) => x + p.amountMinor, 0)).toBe(100_001);
    expect(() => allocate(100, [{ memberId: "a", bps: 5000 }])).toThrow(DomainError);
  });
  it("pays out automatically only on a funded path", () => {
    expect(payoutMethod({ commissionLandsInPlatformBalance: false, recipientOnboarded: true })).toBe("settlement_instruction");
    expect(payoutMethod({ commissionLandsInPlatformBalance: true, recipientOnboarded: true })).toBe("platform_transfer");
  });
});

describe("response plan", () => {
  const plan: ResponsePlan = {
    tripId: "t",
    primary: { memberId: "solo", timeZone: "America/Mexico_City", coverage: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 19 }] },
    backup: { memberId: "backup", timeZone: "Europe/Paris", coverage: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 7, endHour: 23 }] },
    ackDeadlineMinutes: 30,
    escalation: ["ops-lead"],
    clientContactPolicy: "Advisor or named backup only",
  };
  it("routes to the backup while the solo expert sleeps", () => {
    // 2026-10-01 is a Thursday. 12:00Z = 06:00 Mexico City, 14:00 Paris.
    expect(currentResponder(plan, NOW)).toEqual({ memberId: "backup", role: "backup" });
    // 18:00Z = 12:00 Mexico City.
    expect(currentResponder(plan, new Date("2026-10-01T18:00:00Z"))).toEqual({ memberId: "solo", role: "primary" });
  });
  it("escalates in order after the ack deadline", () => {
    expect(escalationTarget(plan, NOW, new Date(NOW.getTime() + 10 * 60_000), [])).toBeNull();
    expect(escalationTarget(plan, NOW, new Date(NOW.getTime() + 31 * 60_000), ["backup"])).toBe("solo");
    expect(escalationTarget(plan, NOW, new Date(NOW.getTime() + 31 * 60_000), ["backup", "solo"])).toBe("ops-lead");
  });
});

describe("attention queue", () => {
  it("brings only consequential items, soonest first, each with a recommended action", () => {
    const approval = requestApproval({ id: "a1", tripId: "trip-1", actions: [{ kind: "book", itemId: "item-hotel" }], terms: terms({ offerExpiresAt: inHours(3) }), requestedBy: "agent" });
    const q = buildAttentionQueue({
      now: NOW,
      approvals: [approval],
      items: [item({ id: "u", state: "outcome_unknown" }), item({ id: "ok", state: "confirmed" })],
      commitments: [commitment({ id: "r", reviewStatus: "needs_review", dueBy: inHours(48) }), commitment({ id: "auto" })],
      nudges: [],
      pendingPublicationIds: [],
    });
    expect(q.map((x) => x.kind)).toEqual(["reconcile", "approval", "commitment_review"]);
    expect(q.every((x) => x.recommendedAction.length > 0)).toBe(true);
  });
});
