import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import * as coreRepo from "@/db/repo";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import type { BookingCredentials } from "@/domain/bookings";
import { DuffelClient, IDEMPOTENCY_METADATA_KEY, signDuffelPayload, type TravelerDetails } from "@/providers/duffel";
import { drain, enqueue } from "@/server/jobs/queue";
import { makeHandlers } from "@/modules/trips/jobs";
import { acceptProposal, createPortalLink, loadPortal, resolvePortalToken, revokePortalLink } from "@/modules/trips/portal";
import * as repo from "@/modules/trips/repo";
import { seedTrips, TRIPS_DEMO } from "@/modules/trips/seed";
import {
  addItem,
  requestBooking,
  requestCancellation,
  requestItemApproval,
  requestReconcile,
  saveTravelers,
  selectDuffelOffer,
} from "@/modules/trips/service";
import { handleDuffelWebhook } from "@/modules/trips/webhook";
import { attentionQueue, decide } from "@/services/operations";
import { FakeDuffel } from "./helpers/fakeDuffel";
import { NOW, useDb } from "./helpers/db";

const expert: Tenant = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
const assistant: Tenant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
const outsider: Tenant = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };
const SECRET = "whsec_flows";

const getDb = useDb();
let db: Db;
let fake: FakeDuffel;
let client: DuffelClient;
beforeEach(async () => {
  db = getDb();
  await withSystem(db, (q) => seedTrips(q, NOW));
  fake = new FakeDuffel(() => NOW);
  client = new DuffelClient({ accessToken: "duffel_test", fetch: fake.fetch as typeof fetch });
});

const item = (id: string) => withTenant(db, expert, (q) => coreRepo.getItem(q, id));
const jobs = () => makeHandlers({ now: () => NOW, duffel: () => client });

const flightCreds: BookingCredentials = {
  bookingEntity: "Duffel Managed Content",
  permittedChannel: "Duffel",
  program: null,
  rate: "Published fare",
  perks: [],
  servicingOwner: "Marisol Vega",
  servicingActions: ["modify", "cancel"],
  commissionRecipient: "n/a (net fare + service fee)",
};
const travelers: TravelerDetails[] = [
  { title: "mr", given_name: "Tom", family_name: "Whitfield", gender: "m", born_on: "1975-04-02", email: "tom@example.com", phone_number: "+15555550101" },
  { title: "ms", given_name: "Priya", family_name: "Whitfield", gender: "f", born_on: "1977-09-12", email: "priya@example.com", phone_number: "+15555550102" },
];

async function approvedFlight(): Promise<string> {
  const id = await addItem(db, assistant, DEMO.trip, {
    kind: "flight",
    title: "MEX → JFK return",
    supplierName: null,
    price: null,
    startsAt: null,
    endsAt: null,
    credentials: flightCreds,
    internalNotes: null,
  });
  const offer = fake.addOffer();
  await selectDuffelOffer(db, assistant, id, offer.id, client);
  await saveTravelers(db, assistant, id, travelers);
  // The request's price/expiry/conditions are replaced by the offer's own.
  const a = await requestItemApproval(
    db,
    assistant,
    {
      tripId: DEMO.trip,
      actions: [{ kind: "book", itemId: id }],
      terms: { price: { amountMinor: 1, currency: "USD" }, offerExpiresAt: NOW.toISOString(), cancellationPolicy: "whatever", downstreamChanges: [], actor: "Booking agent via Duffel" },
    },
    NOW,
  );
  expect(a.terms.price).toEqual({ amountMinor: 184_000, currency: "USD" });
  await decide(db, expert, a.id, "approved", NOW);
  return id;
}

describe("Duffel booking through the job", () => {
  it("books once, records the order and the PNR, and a second run changes nothing", async () => {
    const id = await approvedFlight();
    await requestBooking(db, assistant, { itemId: id, termsRechecked: false }, NOW);
    await drain(db, jobs());
    const booked = await item(id);
    expect(booked!.state).toBe("confirmed");
    expect(booked!.confirmationRef).toMatch(/^PNR/);
    const extras = await withTenant(db, expert, (q) => repo.getItemExtras(q, id));
    expect(extras).toMatchObject({ provider: "duffel", providerRef: fake.createdOrders[0]!.id, executionRequestedAt: null });
    // Traveler details are encrypted at rest.
    expect(extras!.bookingRequestEnc).not.toContain("Whitfield");

    await withSystem(db, (q) => enqueue(q, { kind: "trips.book", payload: { itemId: id }, tenant: expert }));
    await drain(db, jobs());
    expect(fake.createdOrders).toHaveLength(1);
    expect(fake.createdOrders[0]!.metadata?.[IDEMPOTENCY_METADATA_KEY]).toMatch(/^atp_book_/);
  });

  it("a timeout after the order is created parks the item; reconcile finds the order", async () => {
    const id = await approvedFlight();
    fake.fault("POST /air/orders", { kind: "timeout_after" });
    await requestBooking(db, assistant, { itemId: id, termsRechecked: false }, NOW);
    await drain(db, jobs());
    expect((await item(id))!.state).toBe("outcome_unknown");
    await requestReconcile(db, assistant, id, NOW);
    await drain(db, jobs());
    expect((await item(id))!.state).toBe("confirmed");
    expect(fake.createdOrders).toHaveLength(1);
  });

  it("a price rise since approval blocks the booking", async () => {
    const id = await approvedFlight();
    const offerId = (await withTenant(db, expert, (q) => repo.getItemExtras(q, id)))!.bookingOffer!.offerId;
    fake.offers.set(offerId, { ...fake.offers.get(offerId)!, total_amount: "1999.00" });
    await requestBooking(db, assistant, { itemId: id, termsRechecked: false }, NOW);
    await drain(db, jobs());
    expect((await item(id))!.state).toBe("approved");
    expect((await withTenant(db, expert, (q) => repo.getItemExtras(q, id)))!.lastExecutionNote).toMatch(/Price rose/);
    expect(fake.createdOrders).toHaveLength(0);
  });

  it("cancels under an approval, through order_cancellations", async () => {
    const id = await approvedFlight();
    await requestBooking(db, assistant, { itemId: id, termsRechecked: false }, NOW);
    await drain(db, jobs());
    await expect(requestCancellation(db, assistant, { itemId: id, termsRechecked: false }, NOW).then(() => drain(db, jobs()))).resolves.toBe(1);
    expect((await withTenant(db, expert, (q) => repo.getItemExtras(q, id)))!.lastExecutionNote).toMatch(/No approval covers/);

    const a = await requestItemApproval(
      db,
      assistant,
      {
        tripId: DEMO.trip,
        actions: [{ kind: "cancel", itemId: id }],
        terms: { price: { amountMinor: 20_000, currency: "USD" }, offerExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), cancellationPolicy: "USD 200 penalty; rest refunded to balance", downstreamChanges: ["Oaxaca transfer no longer needed"], actor: "Booking agent via Duffel" },
      },
      NOW,
    );
    await decide(db, expert, a.id, "approved", NOW);
    await requestCancellation(db, assistant, { itemId: id, termsRechecked: false }, NOW);
    await drain(db, jobs());
    expect((await item(id))!.state).toBe("canceled");
    expect(fake.cancellations.filter((c) => c.confirmed_at)).toHaveLength(1);
  });
});

describe("Duffel webhook", () => {
  const send = (event: unknown, at = NOW, secret = SECRET) => {
    const raw = JSON.stringify(event);
    return handleDuffelWebhook(db, { rawBody: raw, signature: signDuffelPayload(raw, secret, at), secret: SECRET, now: NOW });
  };
  const change = { id: "wev_change_1", type: "order.airline_initiated_change_detected", data: { object: { id: "aic_1", order_id: TRIPS_DEMO.flightOrder } } };

  it("rejects bad signatures before touching anything", async () => {
    expect((await send(change, NOW, "wrong")).status).toBe(401);
    expect((await send(change, new Date(NOW.getTime() - 10 * 60_000))).status).toBe(401);
    const raw = JSON.stringify(change);
    expect((await handleDuffelWebhook(db, { rawBody: raw, signature: null, secret: SECRET, now: NOW })).status).toBe(401);
    expect((await item(DEMO.flight))!.state).toBe("confirmed");
    const { rows } = await withSystem(db, (q) => q.query("select * from provider_webhook_events"));
    expect(rows).toEqual([]);
  });

  it("an airline-initiated change disrupts the flight, reaches the attention queue, and replays are ignored", async () => {
    const r = await send(change);
    expect(r).toEqual({ status: 200, body: { ok: true, result: "disrupted" } });
    expect((await item(DEMO.flight))!.state).toBe("disrupted");
    const queue = await attentionQueue(db, expert, NOW);
    expect(queue.find((x) => x.key === `disruption:${DEMO.flight}`)).toBeDefined();
    const audit = await withTenant(db, expert, (q) => q.query<{ actor: string }>("select actor from audit_events where action = 'booking.disrupted' and subject = $1", [DEMO.flight]));
    expect(audit.rows).toEqual([{ actor: "system:duffel" }]);

    expect(await send(change)).toEqual({ status: 200, body: { ok: true, result: "duplicate" } });
    const again = await withTenant(db, expert, (q) => q.query("select 1 from audit_events where action like 'booking.%' and subject = $1", [DEMO.flight]));
    expect(again.rows).toHaveLength(1);
    // Another workspace never sees the event's effects.
    expect(await withTenant(db, outsider, (q) => coreRepo.getItem(q, DEMO.flight))).toBeNull();
  });

  it("ignores orders that aren't ours and malformed events", async () => {
    expect((await send({ id: "wev_x", type: "order.airline_initiated_change_detected", data: { object: { order_id: "ord_unknown" } } })).body.result).toBe("ignored");
    expect((await send({ id: "wev_y", type: "ping.triggered", data: {} })).body.result).toBe("ignored");
    expect((await send({ nope: true })).status).toBe(400);
  });

  it("order.created reconciles a booking left outcome-unknown", async () => {
    const id = await approvedFlight();
    fake.fault("POST /air/orders", { kind: "timeout_after" });
    await requestBooking(db, assistant, { itemId: id, termsRechecked: false }, NOW);
    await drain(db, jobs());
    expect((await item(id))!.state).toBe("outcome_unknown");
    const order = fake.createdOrders[0]!;
    const r = await send({ id: "wev_created", type: "order.created", data: { object: order } });
    expect(r.body.result).toBe("confirmed");
    expect(await item(id)).toMatchObject({ state: "confirmed", confirmationRef: order.booking_reference });
  });

  it("an order cancelled outside the platform is a disruption", async () => {
    const r = await send({ id: "wev_upd", type: "order.updated", data: { object: { id: TRIPS_DEMO.flightOrder, cancelled_at: NOW.toISOString(), booking_reference: "X7K2QD" } } });
    expect(r.body.result).toBe("disrupted");
  });
});

describe("client portal", () => {
  it("only the trip owner creates links; tokens are stored hashed", async () => {
    await expect(createPortalLink(db, assistant, { tripId: DEMO.trip, label: null, days: 30 }, NOW)).rejects.toThrow(/trip owner/);
    await expect(createPortalLink(db, expert, { tripId: DEMO.privateTrip, label: null, days: 30 }, NOW)).rejects.toThrow(/Add the client/);
    const link = await createPortalLink(db, expert, { tripId: DEMO.trip, label: "Whitfields", days: 30 }, NOW);
    expect(link.url).toMatch(new RegExp(`/portal/${link.token}$`));
    const { rows } = await withSystem(db, (q) => q.query<{ token_hash: string }>("select token_hash from trip_portal_links"));
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.token_hash).not.toBe(link.token);
  });

  it("shows the itinerary in traveler language without internal data", async () => {
    await withTenant(db, expert, (q) => q.query("update trip_items set internal_notes_enc = 'v1.secret', last_execution_note = 'GM owes us' where id = $1", [DEMO.hotelCdmx]));
    const { token } = await createPortalLink(db, expert, { tripId: DEMO.trip, label: null, days: 30 }, NOW);
    const p = await loadPortal(db, token, NOW);
    expect(p).not.toBeNull();
    const v = p!.view;
    expect(v.advisor).toEqual({ name: "Marisol Vega", email: "marisol@example.com" });
    expect(v.agencyName).toBe("Marisol Vega Travel");
    // Design items are internal work in progress.
    expect(v.items.map((i) => i.id)).not.toContain(DEMO.dinner);
    const cdmx = v.items.find((i) => i.id === DEMO.hotelCdmx)!;
    expect(cdmx).toMatchObject({ status: "Confirmed", confirmationRef: "CA-55812" });
    expect(cdmx.perks).toContain("Room upgrade (requested; subject to availability at arrival)");
    expect(cdmx.perks).toContain("Daily breakfast for two");
    const transfer = v.items.find((i) => i.id === DEMO.transfer)!;
    expect(transfer.confirmationRef).toBeNull();
    expect(v.proposals).toHaveLength(1);
    expect(v.proposals[0]).toMatchObject({ summary: ["Book Hacienda Tierra Roja, Oaxaca — 5 nights, mezcal-garden casita"], expired: false });
    const json = JSON.stringify(v);
    for (const secret of ["IATA", "Example Travel Collective", "commission", "Preferred Partner", "GM owes", "v1.secret", "Booking agent", "Valle Transportes (DMC)", "servicing"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("expired, revoked, malformed and orphaned links open nothing", async () => {
    const { token } = await createPortalLink(db, expert, { tripId: DEMO.trip, label: null, days: 1 }, NOW);
    expect(await resolvePortalToken(db, token, new Date(NOW.getTime() + 2 * 86_400_000))).toBeNull();
    expect(await resolvePortalToken(db, "short", NOW)).toBeNull();
    expect(await resolvePortalToken(db, token.slice(0, -2) + "xx", NOW)).toBeNull();

    const links = await withTenant(db, expert, (q) => repo.listPortalLinks(q, DEMO.trip));
    await expect(revokePortalLink(db, assistant, DEMO.trip, links[0]!.id, NOW)).rejects.toThrow(/trip owner/);
    await revokePortalLink(db, expert, DEMO.trip, links[0]!.id, NOW);
    expect(await resolvePortalToken(db, token, NOW)).toBeNull();

    // A link stops working if the trip changes hands.
    const second = await createPortalLink(db, expert, { tripId: DEMO.trip, label: null, days: 5 }, NOW);
    await withSystem(db, (q) => q.query("update trips set owner_id = $2 where id = $1", [DEMO.trip, DEMO.backup]));
    expect(await resolvePortalToken(db, second.token, NOW)).toBeNull();
  });

  it("records the client's acceptance without approving spend", async () => {
    const { token } = await createPortalLink(db, expert, { tripId: DEMO.trip, label: null, days: 30 }, NOW);
    await expect(acceptProposal(db, token, { approvalId: DEMO.approvalOaxaca, acceptedName: "T" }, NOW)).rejects.toThrow(/full name/);
    // An approval from another trip can't be accepted through this link.
    const otherApproval = "00000000-0000-4000-8000-00000000f999";
    await withSystem(db, (q) =>
      q.query(
        `insert into approvals (id, workspace_id, trip_id, actions, terms, terms_fingerprint, status, requested_by)
         select $1, workspace_id, $2, actions, terms, terms_fingerprint, 'pending', requested_by from approvals where id = $3`,
        [otherApproval, DEMO.privateTrip, DEMO.approvalOaxaca],
      ),
    );
    await expect(acceptProposal(db, token, { approvalId: otherApproval, acceptedName: "Tom Whitfield" }, NOW)).rejects.toThrow(/isn't part of this trip/);

    await acceptProposal(db, token, { approvalId: DEMO.approvalOaxaca, acceptedName: "Tom Whitfield" }, NOW);
    await expect(acceptProposal(db, token, { approvalId: DEMO.approvalOaxaca, acceptedName: "Tom Whitfield" }, NOW)).rejects.toThrow(/already accepted/);
    const view = (await loadPortal(db, token, NOW))!.view;
    expect(view.proposals[0]!.clientAcceptance).toMatchObject({ acceptedName: "Tom Whitfield", termsCurrent: true });
    // Still the expert's decision.
    expect((await item(DEMO.hotelOaxaca))!.state).toBe("awaiting_approval");
    expect((await withTenant(db, expert, (q) => coreRepo.getApproval(q, DEMO.approvalOaxaca)))!.status).toBe("pending");
    // Expired offers can't be accepted.
    await expect(acceptProposal(db, token, { approvalId: DEMO.approvalOaxaca, acceptedName: "Tom" }, new Date(NOW.getTime() + 3 * 86_400_000))).rejects.toThrow(/expired/);
  });
});
