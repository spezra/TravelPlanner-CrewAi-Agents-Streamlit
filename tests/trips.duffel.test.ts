import { beforeEach, describe, expect, it } from "vitest";
import type { MaterialTerms } from "@/domain/approvals";
import {
  classifyFailure,
  describeConditions,
  DuffelAdapter,
  DuffelClient,
  DuffelHttpError,
  DuffelNetworkError,
  IDEMPOTENCY_METADATA_KEY,
  signDuffelPayload,
  snapshotOffer,
  termsFromOffer,
  verifyDuffelSignature,
  type TravelerDetails,
} from "@/providers/duffel";
import { FakeDuffel } from "./helpers/fakeDuffel";

const NOW = new Date("2026-10-01T12:00:00Z");
const travelers: TravelerDetails[] = [
  { title: "mr", given_name: "Tom", family_name: "Whitfield", gender: "m", born_on: "1975-04-02", email: "tom@example.com", phone_number: "+15555550101" },
  { title: "ms", given_name: "Priya", family_name: "Whitfield", gender: "f", born_on: "1977-09-12", email: "priya@example.com", phone_number: "+15555550102" },
];

let fake: FakeDuffel;
let client: DuffelClient;
beforeEach(() => {
  fake = new FakeDuffel(() => NOW);
  client = new DuffelClient({ accessToken: "duffel_test_x", fetch: fake.fetch as typeof fetch });
});

const approvedFor = (offerId: string): MaterialTerms => {
  const o = fake.offers.get(offerId)!;
  return termsFromOffer(o, {
    price: { amountMinor: 0, currency: "USD" },
    offerExpiresAt: o.expires_at,
    cancellationPolicy: "",
    downstreamChanges: [],
    actor: "Booking agent via Duffel",
  });
};

describe("Duffel client", () => {
  it("searches with v2 headers and a {data} body, cheapest first", async () => {
    const offers = await client.searchOffers({ origin: "JFK", destination: "MEX", departureDate: "2027-01-09", returnDate: "2027-01-18", adults: 2, cabinClass: "business" });
    expect(offers.map((o) => o.total_amount)).toEqual(["1650.00", "2100.00"]);
    const call = fake.calls[0]!;
    expect(call.headers).toMatchObject({ authorization: "Bearer duffel_test_x", "duffel-version": "v2", "content-type": "application/json" });
    expect(call.path).toContain("/air/offer_requests?return_offers=true");
    expect(call.body).toEqual({
      data: {
        slices: [
          { origin: "JFK", destination: "MEX", departure_date: "2027-01-09" },
          { origin: "MEX", destination: "JFK", departure_date: "2027-01-18" },
        ],
        passengers: [{ type: "adult" }, { type: "adult" }],
        cabin_class: "business",
        max_connections: 1,
      },
    });
  });

  it("describes fare conditions deterministically and snapshots offers in minor units", () => {
    const o = fake.addOffer();
    expect(describeConditions(o)).toBe("Refund before departure: permitted, penalty USD 200.00. Changes before departure: permitted, no penalty.");
    expect(describeConditions({ conditions: null })).toContain("not stated by the airline");
    expect(describeConditions({ conditions: { refund_before_departure: { allowed: false, penalty_amount: null, penalty_currency: null } } })).toContain(
      "Refund before departure: not permitted",
    );
    const s = snapshotOffer(o);
    expect(s).toMatchObject({ offerId: o.id, price: { amountMinor: 184_000, currency: "USD" }, owner: "Aeroméxico", passengerIds: [`pas_${o.id}_1`, `pas_${o.id}_2`] });
    expect(s.slices[0]).toMatchObject({ origin: "JFK", destination: "MEX", flights: ["AM403"], stops: 0 });
  });

  it("maps HTTP errors to typed errors", async () => {
    fake.fault("GET /air/offers/:id", { kind: "http", status: 401, type: "authentication_error" });
    await expect(client.getOffer("off_x")).rejects.toBeInstanceOf(DuffelHttpError);
    fake.fault("GET /air/offers/:id", { kind: "refused" });
    await expect(client.getOffer("off_x")).rejects.toMatchObject({ sent: false });
  });
});

describe("error classification", () => {
  const http = (status: number, type: string, code?: string) => new DuffelHttpError(status, [{ type, code }], "req_1");
  it.each([
    [http(429, "rate_limit_error"), "retryable"],
    [http(500, "api_error"), "retryable"],
    [http(503, "api_error"), "retryable"],
    [http(504, "api_error"), "unknown"],
    [http(502, "airline_error"), "unknown"],
    [http(422, "airline_error", "offer_no_longer_available"), "rejected"],
    [http(422, "validation_error"), "rejected"],
    [http(401, "authentication_error"), "rejected"],
    [new DuffelNetworkError("reset", true), "unknown"],
    [new DuffelNetworkError("refused", false), "retryable"],
    [new Error("weird"), "unknown"],
  ])("%s -> %s", (err, kind) => {
    expect(classifyFailure(err).kind).toBe(kind);
  });
});

describe("Duffel adapter: orders", () => {
  it("creates an order from the selected offer, carrying the idempotency key in metadata", async () => {
    const o = fake.addOffer();
    const a = new DuffelAdapter(client, { offerId: o.id, travelers }, { now: () => NOW });
    const out = await a.submit("atp_book_k1", { terms: approvedFor(o.id) });
    expect(out).toMatchObject({ kind: "accepted" });
    const post = fake.calls.find((c) => c.method === "POST" && c.path === "/air/orders")!;
    expect(post.body).toMatchObject({
      data: {
        type: "instant",
        selected_offers: [o.id],
        payments: [{ type: "balance", amount: "1840.00", currency: "USD" }],
        metadata: { [IDEMPOTENCY_METADATA_KEY]: "atp_book_k1" },
        passengers: [
          { id: `pas_${o.id}_1`, given_name: "Tom", family_name: "Whitfield" },
          { id: `pas_${o.id}_2`, given_name: "Priya" },
        ],
      },
    });
    expect(await a.confirmationRef((out as { providerRef: string }).providerRef)).toMatch(/^PNR/);
  });

  it("never creates a second order under the same key", async () => {
    const o = fake.addOffer();
    const a = new DuffelAdapter(client, { offerId: o.id, travelers }, { now: () => NOW });
    const first = await a.submit("atp_book_k2", { terms: approvedFor(o.id) });
    const second = await a.submit("atp_book_k2", { terms: approvedFor(o.id) });
    expect(second).toEqual(first);
    expect(fake.createdOrders).toHaveLength(1);
  });

  it("a timeout after sending is unknown, and lookup finds the order across pages", async () => {
    const o = fake.addOffer();
    fake.pageSize = 50;
    fake.addNoise(120);
    fake.fault("POST /air/orders", { kind: "timeout_after" });
    const a = new DuffelAdapter(client, { offerId: o.id, travelers }, { now: () => NOW });
    const out = await a.submit("atp_book_k3", { terms: approvedFor(o.id) });
    expect(out.kind).toBe("unknown");
    fake.addNoise(80); // newer orders push ours onto a later page
    const found = await a.lookup("atp_book_k3");
    expect(found).toEqual({ kind: "found", providerRef: fake.createdOrders[0]!.id });
    expect(fake.calls.filter((c) => c.path.startsWith("/air/orders?")).length).toBeGreaterThan(2);
  });

  it("lookup is absent when the scan reaches the lookback window, unknown when it can't finish", async () => {
    fake.addNoise(10, 24 * 30);
    const a = new DuffelAdapter(client, null, { now: () => NOW, lookbackHours: 24 });
    expect(await a.lookup("atp_nope")).toEqual({ kind: "absent" });
    fake.fault("GET /air/orders", { kind: "http", status: 503, type: "api_error" });
    expect((await a.lookup("atp_nope")).kind).toBe("unknown");
    fake.pageSize = 2;
    fake.addNoise(10, 1);
    const capped = new DuffelAdapter(client, null, { now: () => NOW, maxLookupPages: 2 });
    expect((await capped.lookup("atp_nope")).kind).toBe("unknown");
  });

  it("classifies submit failures without ordering", async () => {
    const o = fake.addOffer();
    const a = new DuffelAdapter(client, { offerId: o.id, travelers }, { now: () => NOW });
    fake.fault("POST /air/orders", { kind: "http", status: 429, type: "rate_limit_error" });
    expect((await a.submit("k4", { terms: approvedFor(o.id) })).kind).toBe("retryable");
    fake.fault("POST /air/orders", { kind: "accepted_202" });
    expect((await a.submit("k5", { terms: approvedFor(o.id) })).kind).toBe("processing");
    // The 202 created the order; resubmitting finds it instead of ordering again.
    expect((await a.submit("k5", { terms: approvedFor(o.id) })).kind).toBe("accepted");
    expect(fake.createdOrders).toHaveLength(1);
  });

  it("refuses to pay a price the offer no longer has", async () => {
    const o = fake.addOffer();
    const terms = approvedFor(o.id);
    fake.offers.set(o.id, { ...o, total_amount: "1990.00" });
    const a = new DuffelAdapter(client, { offerId: o.id, travelers }, { now: () => NOW });
    const out = await a.submit("k6", { terms });
    expect(out).toMatchObject({ kind: "rejected" });
    expect(fake.createdOrders).toHaveLength(0);
  });

  it("an expired offer is rejected by the airline", async () => {
    const o = fake.addOffer({ expires_at: new Date(NOW.getTime() - 1000).toISOString() });
    const a = new DuffelAdapter(client, { offerId: o.id, travelers }, { now: () => NOW });
    expect(await a.submit("k7", { terms: approvedFor(o.id) })).toMatchObject({ kind: "rejected" });
  });
});

describe("Duffel adapter: cancellation", () => {
  it("quotes, creates and confirms an order cancellation once", async () => {
    const o = fake.addOffer();
    const a = new DuffelAdapter(client, { offerId: o.id, travelers }, { now: () => NOW });
    const booked = (await a.submit("kb", { terms: approvedFor(o.id) })) as { providerRef: string };
    const quote = await a.cancellationQuote(booked.providerRef);
    expect(quote.cost).toEqual({ amountMinor: 20_000, currency: "USD" }); // 1840 - 1640 refund
    expect(await a.lookupCancellation("kc", booked.providerRef)).toEqual({ kind: "absent" });
    const out = await a.cancel("kc", booked.providerRef);
    expect(out.kind).toBe("accepted");
    // The quote's pending cancellation was reused, then confirmed.
    expect(fake.cancellations).toHaveLength(1);
    expect(fake.calls.some((c) => c.path.endsWith("/actions/confirm"))).toBe(true);
    expect(await a.cancel("kc", booked.providerRef)).toEqual(out);
    expect(fake.cancellations).toHaveLength(1);
    expect((await a.lookupCancellation("kc", booked.providerRef)).kind).toBe("found");
  });

  it("a timeout on confirm is unknown until looked up", async () => {
    const o = fake.addOffer();
    const a = new DuffelAdapter(client, { offerId: o.id, travelers }, { now: () => NOW });
    const booked = (await a.submit("kb2", { terms: approvedFor(o.id) })) as { providerRef: string };
    fake.fault("POST /air/order_cancellations/:id/actions/confirm", { kind: "timeout_after" });
    expect((await a.cancel("kc2", booked.providerRef)).kind).toBe("unknown");
    expect((await a.lookupCancellation("kc2", booked.providerRef)).kind).toBe("found");
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "wev_1", type: "order.updated", data: { object: { id: "ord_1" } } });

  it("accepts a valid signature", () => {
    expect(verifyDuffelSignature(signDuffelPayload(body, secret, NOW), body, secret, NOW)).toEqual({ ok: true });
  });

  it("rejects missing, malformed, tampered, wrong-secret, stale and future signatures", () => {
    const sig = signDuffelPayload(body, secret, NOW);
    expect(verifyDuffelSignature(null, body, secret, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(verifyDuffelSignature("v1=abc", body, secret, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDuffelSignature(sig, body.replace("ord_1", "ord_2"), secret, NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyDuffelSignature(sig, body, "other", NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyDuffelSignature(sig, body, secret, new Date(NOW.getTime() + 301_000))).toEqual({ ok: false, reason: "stale" });
    expect(verifyDuffelSignature(sig, body, secret, new Date(NOW.getTime() - 301_000))).toEqual({ ok: false, reason: "stale" });
    expect(verifyDuffelSignature(sig, body, secret, new Date(NOW.getTime() + 299_000))).toEqual({ ok: true });
  });
});
