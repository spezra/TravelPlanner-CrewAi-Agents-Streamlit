import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import * as coreRepo from "@/db/repo";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import type { MaterialTerms } from "@/domain/approvals";
import type { BookingCredentials } from "@/domain/bookings";
import { SimulatedSupplier } from "@/providers/simulated";
import { enqueue, drain } from "@/server/jobs/queue";
import { runReconcile } from "@/modules/trips/execution";
import { makeHandlers } from "@/modules/trips/jobs";
import { bookingOnly } from "@/modules/trips/providers";
import * as repo from "@/modules/trips/repo";
import { seedTrips } from "@/modules/trips/seed";
import {
  addItem,
  createTrip,
  grantDelegation,
  moveItem,
  recordManualOutcome,
  requestBooking,
  requestItemApproval,
  requoteItemApproval,
  revokeDelegation,
  updateItem,
  updateTrip,
  withdrawItemApproval,
  type ItemDraft,
} from "@/modules/trips/service";
import { attentionQueue, decide } from "@/services/operations";
import { NOW, useDb } from "./helpers/db";

const expert: Tenant = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
const assistant: Tenant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
const backup: Tenant = { workspaceId: DEMO.workspace, memberId: DEMO.backup };
const outsider: Tenant = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };

const getDb = useDb();
let db: Db;
beforeEach(async () => {
  db = getDb();
  await withSystem(db, (q) => seedTrips(q, NOW));
});

const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
const item = (id: string, t: Tenant = expert) => withTenant(db, t, (q) => coreRepo.getItem(q, id));

const creds = (over: Partial<BookingCredentials> = {}): BookingCredentials => ({
  bookingEntity: "Host agency: Example Travel Collective (IATA 00000000)",
  permittedChannel: "Direct to property",
  program: "Example Preferred Partner",
  rate: "Best flexible rate",
  perks: [
    { name: "Breakfast for two", basis: "guaranteed" },
    { name: "Room upgrade", basis: "availability_dependent" },
  ],
  servicingOwner: "Marisol Vega",
  servicingActions: ["modify", "cancel"],
  commissionRecipient: "Example Travel Collective, 80% to Marisol Vega",
  ...over,
});

const draft = (over: Partial<ItemDraft> = {}): ItemDraft => ({
  kind: "hotel",
  title: "Hotel Brisa — 3 nights",
  supplierName: "Hotel Brisa",
  price: { amountMinor: 250_000, currency: "USD" },
  startsAt: later(24 * 50),
  endsAt: later(24 * 53),
  credentials: creds(),
  internalNotes: "GM owes us one; don't ask for the upgrade twice",
  ...over,
});

const terms = (over: Partial<MaterialTerms> = {}): MaterialTerms => ({
  price: { amountMinor: 250_000, currency: "USD" },
  offerExpiresAt: later(48),
  cancellationPolicy: "Free cancellation until 14 days before arrival",
  downstreamChanges: [],
  actor: "Booking agent, direct to property",
  ...over,
});

describe("trips", () => {
  it("experts create trips; assistants prepare but don't own them", async () => {
    await expect(createTrip(db, assistant, { title: "X", clientId: null, startsOn: null, endsOn: null, scope: "workspace" })).rejects.toThrow(/owned by experts/);
    const id = await createTrip(db, expert, { title: "Baja", clientId: DEMO.client, startsOn: "2027-02-01", endsOn: "2027-02-05", scope: "private" });
    const trip = await withTenant(db, expert, (q) => coreRepo.getTrip(q, id));
    expect(trip).toMatchObject({ ownerId: DEMO.expert, clientName: "The Whitfields", scope: "private" });
    // Private: the assistant can't see it.
    expect(await withTenant(db, assistant, (q) => coreRepo.getTrip(q, id))).toBeNull();
    await expect(createTrip(db, expert, { title: "Bad", clientId: null, startsOn: "2027-02-05", endsOn: "2027-02-01", scope: "workspace" })).rejects.toThrow(/end before/);
  });

  it("only visible clients can be attached, and only the owner changes scope", async () => {
    const clientElsewhere = "00000000-0000-4000-8000-0000000000c9";
    await withSystem(db, (q) =>
      q.query("insert into clients (id, workspace_id, owner_id, name) values ($1, $2, $3, 'Someone else')", [clientElsewhere, DEMO.otherWorkspace, DEMO.otherExpert]),
    );
    await expect(createTrip(db, expert, { title: "X", clientId: clientElsewhere, startsOn: null, endsOn: null, scope: "workspace" })).rejects.toThrow(/Client not found/);
    const t = await withTenant(db, expert, (q) => coreRepo.getTrip(q, DEMO.trip));
    const input = { title: t!.title, clientId: t!.clientId, startsOn: t!.startsOn, endsOn: t!.endsOn, scope: "private" as const };
    await expect(updateTrip(db, backup, DEMO.trip, input)).rejects.toThrow(/trip owner or a workspace owner/);
    await updateTrip(db, expert, DEMO.trip, input);
    expect((await withTenant(db, expert, (q) => coreRepo.getTrip(q, DEMO.trip)))!.scope).toBe("private");
  });
});

describe("delegations", () => {
  it("the owner grants scoped, expiring access; nobody else can", async () => {
    await expect(grantDelegation(db, assistant, { tripId: DEMO.privateTrip, memberId: DEMO.assistant, purpose: "assistant", expiresAt: later(48) }, NOW)).rejects.toThrow(
      /Trip not found|trip owner/,
    );
    await expect(grantDelegation(db, expert, { tripId: DEMO.privateTrip, memberId: DEMO.assistant, purpose: "assistant", expiresAt: later(-1) }, NOW)).rejects.toThrow(
      /future/,
    );
    await expect(grantDelegation(db, expert, { tripId: DEMO.privateTrip, memberId: DEMO.otherExpert, purpose: "backup", expiresAt: later(48) }, NOW)).rejects.toThrow(
      /active member/,
    );
    await grantDelegation(db, expert, { tripId: DEMO.privateTrip, memberId: DEMO.assistant, purpose: "assistant", expiresAt: later(24 * 30) }, NOW);
    expect(await withTenant(db, assistant, (q) => coreRepo.getTrip(q, DEMO.privateTrip))).not.toBeNull();
    // A delegate can't pass access on.
    await expect(grantDelegation(db, assistant, { tripId: DEMO.privateTrip, memberId: DEMO.backup, purpose: "backup", expiresAt: later(48) }, NOW)).rejects.toThrow(/trip owner/);
    await revokeDelegation(db, expert, DEMO.privateTrip, DEMO.assistant);
    expect(await withTenant(db, assistant, (q) => coreRepo.getTrip(q, DEMO.privateTrip))).toBeNull();
  });
});

describe("items through the state machine", () => {
  it("adds, proposes, requests approval, and lapses the approval when material terms change", async () => {
    const id = await addItem(db, assistant, DEMO.trip, draft());
    expect((await item(id))!.state).toBe("design");
    // Internal notes are encrypted at rest.
    const extras = await withTenant(db, expert, (q) => repo.getItemExtras(q, id));
    expect(extras!.internalNotesEnc).toMatch(/^v\d+\./);
    expect(extras!.internalNotesEnc).not.toContain("GM owes");

    await moveItem(db, assistant, id, "propose");
    const a = await requestItemApproval(db, assistant, { tripId: DEMO.trip, actions: [{ kind: "book", itemId: id }], terms: terms() }, NOW);
    expect((await item(id))!.state).toBe("awaiting_approval");

    // Editing a non-material detail keeps the approval; changing the price lapses it.
    expect(await updateItem(db, assistant, id, draft({ title: "Hotel Brisa — 3 nights, sea view" }))).toEqual({ lapsedApproval: false });
    expect(await updateItem(db, assistant, id, draft({ price: { amountMinor: 290_000, currency: "USD" } }))).toEqual({ lapsedApproval: true });
    expect((await item(id))!.state).toBe("design");
    expect((await withTenant(db, expert, (q) => coreRepo.getApproval(q, a.id)))!.status).toBe("withdrawn");
  });

  it("refuses transitions the state machine doesn't allow", async () => {
    await expect(moveItem(db, expert, DEMO.hotelCdmx, "cancel")).rejects.toThrow(/request approval to cancel/);
    await expect(moveItem(db, expert, DEMO.hotelCdmx, "to_design")).rejects.toThrow(/can't go back/);
    await expect(moveItem(db, expert, DEMO.hotelCdmx, "accept_change")).rejects.toThrow(/disrupted/);
    await expect(moveItem(db, expert, DEMO.transfer, "propose")).rejects.toThrow(/cannot move from outcome_unknown/);
    await expect(updateItem(db, expert, DEMO.hotelCdmx, draft())).rejects.toThrow(/changed through the supplier/);
    const canceled = await moveItem(db, expert, DEMO.dinner, "cancel");
    expect(canceled.state).toBe("canceled");
    await expect(moveItem(db, expert, DEMO.dinner, "propose")).rejects.toThrow(/cannot move/);
  });

  it("canceling an item awaiting approval withdraws the approval", async () => {
    await moveItem(db, expert, DEMO.hotelOaxaca, "cancel");
    expect((await withTenant(db, expert, (q) => coreRepo.getApproval(q, DEMO.approvalOaxaca)))!.status).toBe("withdrawn");
  });

  it("won't request booking approval with incomplete credentials, or book twice", async () => {
    await expect(
      requestItemApproval(db, expert, { tripId: DEMO.trip, actions: [{ kind: "book", itemId: DEMO.dinner }], terms: terms() }, NOW),
    ).rejects.toThrow(/credentials/);
    await expect(
      requestItemApproval(db, expert, { tripId: DEMO.trip, actions: [{ kind: "book", itemId: DEMO.hotelCdmx }], terms: terms() }, NOW),
    ).rejects.toThrow(/can't be booked again/);
    await expect(requestItemApproval(db, outsider, { tripId: DEMO.trip, actions: [{ kind: "book", itemId: DEMO.hotelCdmx }], terms: terms() }, NOW)).rejects.toThrow(
      /not found/,
    );
  });
});

describe("approval permissions", () => {
  it("assistants and delegated advisors request; only the trip owner or a workspace owner decides", async () => {
    const id = await addItem(db, assistant, DEMO.trip, draft());
    const a = await requestItemApproval(db, backup, { tripId: DEMO.trip, actions: [{ kind: "book", itemId: id }], terms: terms() }, NOW);
    await expect(decide(db, assistant, a.id, "approved", NOW)).rejects.toThrow(/trip owner/);
    await expect(decide(db, backup, a.id, "approved", NOW)).rejects.toThrow(/trip owner/);
    await decide(db, expert, a.id, "approved", NOW);
    expect((await item(id))!.state).toBe("approved");
  });

  it("a workspace owner can decide on another expert's trip", async () => {
    const tripId = await createTrip(db, backup, { title: "Lena's Berlin trip", clientId: null, startsOn: null, endsOn: null, scope: "workspace" });
    const id = await addItem(db, backup, tripId, draft());
    const a = await requestItemApproval(db, backup, { tripId, actions: [{ kind: "book", itemId: id }], terms: terms() }, NOW);
    await decide(db, expert, a.id, "rejected", NOW);
    expect((await item(id))!.state).toBe("design");
  });

  it("expired offers can't be approved; a re-quote replaces them", async () => {
    const past = new Date(NOW.getTime() + 3 * 86_400_000); // seeded offer expires NOW + 2 days
    await expect(decide(db, expert, DEMO.approvalOaxaca, "approved", past)).rejects.toThrow(/expired/);
    const fresh = await requoteItemApproval(db, assistant, DEMO.approvalOaxaca, terms({ price: { amountMinor: 1_495_000, currency: "USD" }, offerExpiresAt: later(24 * 5) }), past);
    const old = await withTenant(db, expert, (q) => coreRepo.getApproval(q, DEMO.approvalOaxaca));
    expect(old!.status).toBe("withdrawn");
    const meta = await withTenant(db, expert, (q) => repo.approvalMeta(q, DEMO.trip));
    expect(meta.get(DEMO.approvalOaxaca)!.supersededBy).toBe(fresh.id);
    await decide(db, expert, fresh.id, "approved", past);
    expect((await item(DEMO.hotelOaxaca))!.state).toBe("approved");
    // The superseded approval can't be decided any more.
    await expect(decide(db, expert, DEMO.approvalOaxaca, "approved", NOW)).rejects.toThrow(/already/);
  });

  it("the requester or owner can withdraw; others can't", async () => {
    await expect(withdrawItemApproval(db, backup, DEMO.approvalOaxaca)).rejects.toThrow(/requester or the trip owner/);
    await withdrawItemApproval(db, expert, DEMO.approvalOaxaca);
    expect((await item(DEMO.hotelOaxaca))!.state).toBe("design");
  });
});

describe("manual adapter (no-API suppliers)", () => {
  const jobs = () => makeHandlers({ now: () => NOW });

  it("booking opens a confirmation task and waits; the recorded confirmation number confirms it", async () => {
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    await expect(requestBooking(db, assistant, { itemId: DEMO.hotelOaxaca, termsRechecked: false }, NOW)).rejects.toThrow(/re-checked/);
    await requestBooking(db, assistant, { itemId: DEMO.hotelOaxaca, termsRechecked: true }, NOW);
    await expect(requestBooking(db, assistant, { itemId: DEMO.hotelOaxaca, termsRechecked: true }, NOW)).rejects.toThrow(/already has work queued/);
    await drain(db, jobs());

    expect((await item(DEMO.hotelOaxaca))!.state).toBe("outcome_unknown");
    const tasks = (await withTenant(db, assistant, (q) => repo.listManualForTrip(q, DEMO.trip))).filter((t) => t.itemId === DEMO.hotelOaxaca);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "pending", action: "book", channel: "Direct to property" });

    // Running the job again doesn't send a second request.
    await withSystem(db, (q) => enqueue(q, { kind: "trips.book", payload: { itemId: DEMO.hotelOaxaca }, tenant: expert }));
    await drain(db, jobs());
    const again = await withTenant(db, assistant, (q) => repo.getManual(q, tasks[0]!.id));
    expect(again!.rounds).toBe(1);

    await expect(recordManualOutcome(db, assistant, { taskId: tasks[0]!.id, outcome: "confirmed", confirmationRef: " ", note: null }, { db, tenant: assistant }, NOW)).rejects.toThrow(
      /confirmation number/,
    );
    const confirmed = await recordManualOutcome(db, assistant, { taskId: tasks[0]!.id, outcome: "confirmed", confirmationRef: "HTR-7781", note: "Rafael by email" }, { db, tenant: assistant }, NOW);
    expect(confirmed).toMatchObject({ state: "confirmed", confirmationRef: "HTR-7781" });
    await expect(recordManualOutcome(db, assistant, { taskId: tasks[0]!.id, outcome: "not_found", confirmationRef: null, note: null }, { db, tenant: assistant }, NOW)).rejects.toThrow(
      /already recorded/,
    );
  });

  it("'supplier has no reservation' fails the seeded outcome-unknown transfer", async () => {
    const task = (await withTenant(db, expert, (q) => repo.listManualForTrip(q, DEMO.trip))).find((t) => t.itemId === DEMO.transfer)!;
    const failed = await recordManualOutcome(db, expert, { taskId: task.id, outcome: "not_found", confirmationRef: null, note: "DMC never received it" }, { db, tenant: expert }, NOW);
    expect(failed.state).toBe("failed");
    const attempt = await withTenant(db, expert, (q) => repo.latestAttempt(q, DEMO.transfer, "book"));
    expect(attempt!.state).toBe("retryable_error");
  });

  it("manual terms confirmations go stale", async () => {
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    await requestBooking(db, expert, { itemId: DEMO.hotelOaxaca, termsRechecked: true }, NOW);
    await drain(db, makeHandlers({ now: () => new Date(NOW.getTime() + 3 * 3_600_000) }));
    const it = await item(DEMO.hotelOaxaca);
    expect(it!.state).toBe("approved");
    const extras = await withTenant(db, expert, (q) => repo.getItemExtras(q, DEMO.hotelOaxaca));
    expect(extras!.lastExecutionNote).toMatch(/more than two hours old/);
    expect(extras!.executionRequestedAt).toBeNull();
  });
});

describe("trips.book job idempotency", () => {
  it("running the job twice books once", async () => {
    const supplier = new SimulatedSupplier();
    const handlers = makeHandlers({ now: () => NOW, override: () => bookingOnly(supplier) });
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    await requestBooking(db, expert, { itemId: DEMO.hotelOaxaca, termsRechecked: true }, NOW);
    await withSystem(db, (q) => enqueue(q, { kind: "trips.book", payload: { itemId: DEMO.hotelOaxaca, termsConfirmation: { by: DEMO.expert, at: NOW.toISOString() } }, tenant: expert }));
    await drain(db, handlers);
    await drain(db, handlers);
    expect(supplier.submits).toBe(1);
    expect(supplier.reservationCount).toBe(1);
    expect(await item(DEMO.hotelOaxaca)).toMatchObject({ state: "confirmed", confirmationRef: "SIM-1000" });
  });

  it("a timeout after acceptance is reconciled, never resubmitted", async () => {
    const supplier = new SimulatedSupplier(["timeout_after_accept"]);
    const handlers = makeHandlers({ now: () => NOW, override: () => bookingOnly(supplier) });
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    await requestBooking(db, expert, { itemId: DEMO.hotelOaxaca, termsRechecked: true }, NOW);
    await drain(db, handlers);
    expect((await item(DEMO.hotelOaxaca))!.state).toBe("outcome_unknown");
    expect((await attentionQueue(db, expert, NOW)).map((x) => x.key)).toContain(`reconcile:${DEMO.hotelOaxaca}`);
    // A second book job reconciles instead of resending.
    await withSystem(db, (q) => enqueue(q, { kind: "trips.book", payload: { itemId: DEMO.hotelOaxaca }, tenant: expert }));
    await drain(db, handlers);
    expect(supplier.submits).toBe(1);
    expect((await item(DEMO.hotelOaxaca))!.state).toBe("confirmed");
  });

  it("a worker that died mid-call leaves 'booking', which is recovered by reconciliation once stale", async () => {
    const supplier = new SimulatedSupplier();
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    // Simulate phase 1 committing and the process dying before phase 3.
    await withTenant(db, expert, async (q) => {
      const it = (await coreRepo.getItem(q, DEMO.hotelOaxaca))!;
      await coreRepo.updateItemState(q, { ...it, state: "booking" });
      await coreRepo.saveAttempt(q, DEMO.workspace, { id: "00000000-0000-4000-8000-00000000aa01", idempotencyKey: "atp_book_crash", action: "book", itemId: it.id, state: "prepared", providerRef: null, attempts: 0, lastError: null }, "simulated");
      await q.query("update execution_attempts set updated_at = $2 where idempotency_key = $1", ["atp_book_crash", new Date(NOW.getTime() - 60 * 60_000).toISOString()]);
    });
    // The request had actually reached the supplier.
    await supplier.submit("atp_book_crash", {});
    const deps = { db, tenant: expert, override: () => bookingOnly(supplier) };
    expect((await runReconcile(db, expert, DEMO.hotelOaxaca, deps, new Date(NOW.getTime() - 50 * 60_000))).status).toBe("in_flight");
    const r = await runReconcile(db, expert, DEMO.hotelOaxaca, deps, NOW);
    expect(r).toEqual({ status: "done", state: "confirmed" });
    expect(supplier.submits).toBe(1);
  });

  it("the sweep queues reconciliation for API-rail items only", async () => {
    await withTenant(db, expert, (q) => q.query("update execution_attempts set provider = 'duffel' where idempotency_key = 'atp_book_demo_transfer'"));
    const seen: string[] = [];
    const handlers = { ...makeHandlers({ now: () => NOW }), "trips.reconcile": async ({ job }: { job: { payload: Record<string, unknown> } }) => void seen.push(String(job.payload.itemId)) };
    await withSystem(db, (q) => enqueue(q, { kind: "trips.reconcile_sweep" }));
    await drain(db, handlers);
    expect(seen).toEqual([DEMO.transfer]);
  });
});

describe("RLS on the slice's tables", () => {
  it("manual tasks, portal links and acceptances follow trip visibility", async () => {
    expect(await withTenant(db, outsider, (q) => repo.listManualForTrip(q, DEMO.trip))).toEqual([]);
    expect((await withTenant(db, outsider, (q) => q.query("select * from manual_confirmations"))).rows).toEqual([]);
    await expect(withTenant(db, outsider, (q) => q.query("select * from provider_webhook_events"))).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(db, outsider, (q) =>
        q.query("insert into trip_portal_links (id, workspace_id, trip_id, token_hash, created_by, expires_at) values (gen_random_uuid(), $1, $2, 'x', $3, now())", [
          DEMO.workspace,
          DEMO.trip,
          DEMO.otherExpert,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
