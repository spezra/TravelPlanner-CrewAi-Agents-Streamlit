import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb, migrate, splitSql, type Db } from "@/db/client";
import * as repo from "@/db/repo";
import { DEMO, seed } from "@/db/seed";
import { withTenant } from "@/db/tenant";
import type { MaterialTerms } from "@/domain/approvals";
import { SimulatedSupplier, type Script } from "@/providers/simulated";
import { attentionQueue, bookItem, decide, fileCommitments, reconcileItem } from "@/services/operations";

const NOW = new Date("2026-10-01T12:00:00Z");
const expert = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
const assistant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
const backup = { workspaceId: DEMO.workspace, memberId: DEMO.backup };
const outsider = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };

// Migrate and seed once, then start every test from a copy of that data directory.
let snapshot: Blob | undefined;
let db: Db;
beforeEach(async () => {
  if (!snapshot) {
    const fresh = await createPgliteDb();
    await migrate(fresh);
    await seed(fresh, NOW);
    snapshot = await fresh.dump();
    await fresh.close();
  }
  db = await createPgliteDb({ loadDataDir: snapshot });
});
afterEach(() => db.close());

const approvedTerms = async (): Promise<MaterialTerms> => (await withTenant(db, expert, (q) => repo.getApproval(q, DEMO.approvalOaxaca)))!.terms;

describe("sql splitting", () => {
  it("keeps dollar-quoted bodies intact and drops comments", () => {
    expect(splitSql("-- a; b\nselect 1; do $$ begin perform 1; end $$; select $x$;$x$")).toEqual(["select 1", "do $$ begin perform 1; end $$", "select $x$;$x$"]);
  });
});

describe("row-level security", () => {
  it("isolates workspaces completely", async () => {
    const mine = await withTenant(db, expert, (q) => repo.listTrips(q));
    const theirs = await withTenant(db, outsider, (q) => repo.listTrips(q));
    expect(mine.map((t) => t.title)).not.toContain("Loire weekend");
    expect(theirs.map((t) => t.title)).toEqual(["Loire weekend"]);
    expect(await withTenant(db, outsider, (q) => repo.listItems(q, DEMO.trip))).toEqual([]);
    expect(await withTenant(db, outsider, (q) => repo.listPeople(q))).toEqual([]);
  });

  it("cannot write into another workspace", async () => {
    await expect(
      withTenant(db, outsider, (q) => q.query("insert into audit_events (workspace_id, actor, action, subject) values ($1, 'x', 'x', 'x')", [DEMO.workspace])),
    ).rejects.toThrow(/row-level security/);
  });

  it("private records are the owner's; workspace records are shared", async () => {
    const expertTrips = await withTenant(db, expert, (q) => repo.listTrips(q));
    const assistantTrips = await withTenant(db, assistant, (q) => repo.listTrips(q));
    expect(expertTrips.map((t) => t.id)).toContain(DEMO.privateTrip);
    expect(assistantTrips.map((t) => t.id)).not.toContain(DEMO.privateTrip);
    const assistantPeople = await withTenant(db, assistant, (q) => repo.listPeople(q));
    expect(assistantPeople.map((p) => p.name)).toEqual(["Inés Robles"]);
  });

  it("restricted knowledge never leaves the owner's private store", async () => {
    const seen = await withTenant(db, assistant, (q) => q.query<{ id: string }>("select id from knowledge_items"));
    expect(seen.rows).toEqual([]);
  });

  it("a delegation expires", async () => {
    await withTenant(db, expert, (q) => q.query("update trips set scope = 'private' where id = $1", [DEMO.trip]));
    expect((await withTenant(db, backup, (q) => repo.listTrips(q))).map((t) => t.id)).toEqual([DEMO.trip]);
    await withTenant(db, expert, (q) => q.query("update trip_delegations set expires_at = now() - interval '1 day' where trip_id = $1", [DEMO.trip]));
    expect(await withTenant(db, backup, (q) => repo.listTrips(q))).toEqual([]);
  });
});

describe("approvals", () => {
  it("assistants prepare but don't approve spend", async () => {
    await expect(decide(db, assistant, DEMO.approvalOaxaca, "approved", NOW)).rejects.toThrow(/trip owner/);
  });

  it("an approval can be decided once", async () => {
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    await expect(decide(db, expert, DEMO.approvalOaxaca, "approved", NOW)).rejects.toThrow(/already/);
    const item = await withTenant(db, expert, (q) => repo.getItem(q, DEMO.hotelOaxaca));
    expect(item!.state).toBe("approved");
  });
});

describe("booking execution", () => {
  const book = (supplier: SimulatedSupplier, readCurrentTerms: () => Promise<MaterialTerms>) =>
    bookItem(db, expert, { itemId: DEMO.hotelOaxaca, adapter: supplier, readCurrentTerms, evidenceTier: "recommend", now: NOW });

  it("is blocked until approved", async () => {
    const r = await book(new SimulatedSupplier(), approvedTerms);
    expect(r.status).toBe("blocked");
  });

  it("is blocked when the rate changed since approval", async () => {
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    const t = await approvedTerms();
    const r = await book(new SimulatedSupplier(), async () => ({ ...t, price: { ...t.price, amountMinor: t.price.amountMinor + 50_000 } }));
    expect(r.status === "blocked" && r.failures.map((f) => f.test)).toEqual(["conditions"]);
  });

  it("confirms on the happy path", async () => {
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    const r = await book(new SimulatedSupplier(), approvedTerms);
    expect(r.status === "done" && r.item).toMatchObject({ state: "confirmed", confirmationRef: "SIM-1000" });
  });

  it("a timeout after acceptance parks the item; reconciliation finds it without double-booking", async () => {
    await decide(db, expert, DEMO.approvalOaxaca, "approved", NOW);
    const supplier = new SimulatedSupplier(["timeout_after_accept"] satisfies Script[]);
    const r = await book(supplier, approvedTerms);
    expect(r.status === "done" && r.item.state).toBe("outcome_unknown");

    const queue = await attentionQueue(db, expert, NOW);
    expect(queue.filter((x) => x.kind === "reconcile").map((x) => x.key)).toContain(`reconcile:${DEMO.hotelOaxaca}`);

    const reconciled = await reconcileItem(db, expert, DEMO.hotelOaxaca, supplier);
    expect(reconciled.state).toBe("confirmed");
    expect(supplier.submits).toBe(1);
    expect(supplier.reservationCount).toBe(1);
  });
});

describe("attention queue", () => {
  it("surfaces the seeded trip's consequential items", async () => {
    const q = await attentionQueue(db, expert, NOW);
    expect(new Set(q.map((x) => x.kind))).toEqual(new Set(["reconcile", "approval", "commitment_review", "relationship_nudge", "publication"]));
    // The assistant doesn't own the relationship, so gets no nudges or publication asks.
    const qa = await attentionQueue(db, assistant, NOW);
    expect(qa.some((x) => x.kind === "relationship_nudge" || x.kind === "publication")).toBe(false);
  });
});

describe("commitment filing", () => {
  it("routes consequential or unchecked items for review and files the rest", async () => {
    const base = {
      tripId: DEMO.trip, itemId: null, promisor: "Inés Robles", promisorPersonId: DEMO.concierge, conditions: null, dueBy: null,
      evidenceRef: null, transcriptVerified: false, recapSentAt: null, deliveredToTravelerAt: null,
    };
    const filed = await fileCommitments(db, expert, [
      { ...base, promise: "Flowers in room", evidence: "written_confirmation", confidence: 0.95, consequential: false },
      { ...base, promise: "Waive resort fee", evidence: "machine_transcript", confidence: 0.95, consequential: false },
    ]);
    expect(filed.map((c) => c.reviewStatus)).toEqual(["auto_filed", "needs_review"]);
  });
});
