import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import { cancelBatch } from "@/modules/money/payouts";
import type { MoneyDeps } from "@/modules/money/deps";
import { makeHandlers } from "@/modules/money/jobs";
import { importStatement, matchStatementRow, recordReceipt, setCommissionTerms } from "@/modules/money/ledger";
import { approveBatch, markInstructionSettled, prepareBatches } from "@/modules/money/payouts";
import { addRecipient, setSettlementDetails, startOnboarding } from "@/modules/money/recipients";
import * as repo from "@/modules/money/repo";
import { reports } from "@/modules/money/reports";
import { MONEY_DEMO, seedMoney } from "@/modules/money/seed";
import { agreeSplit, importCollaborationFeeLines, saveSplitTerms } from "@/modules/money/splits";
import { createCardSetupLink } from "@/modules/money/cards";
import { ingestStripeWebhook } from "@/modules/money/webhook";
import { signStripePayload, StripeClient } from "@/providers/stripe";
import { MemoryMailer } from "@/server/mail";
import { drain } from "@/server/jobs/queue";
import { NOW, useDb } from "./helpers/db";

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const expert = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
const assistant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
const backup = { workspaceId: DEMO.workspace, memberId: DEMO.backup };
const outsider = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };
const SECRET = "whsec_test_secret";

// ---------------------------------------------------------------------------
// Fake Stripe: routes by method + path, records every call.

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  headers: Record<string, string>;
}

class FakeStripe {
  calls: Call[] = [];
  transfers = new Map<string, { id: string; group: string; amount: number }>();
  failNextTransferWith: "network" | "insufficient" | null = null;
  private n = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const params = method === "POST" ? new URLSearchParams(String(init?.body ?? "")) : url.searchParams;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({ method, path: url.pathname, params, headers });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const p = url.pathname;
    if (method === "POST" && p === "/v1/transfers") {
      const key = headers["Idempotency-Key"]!;
      if (this.failNextTransferWith === "insufficient") {
        this.failNextTransferWith = null;
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "balance_insufficient", message: "Insufficient available balance" } }), { status: 400 });
      }
      let t = this.transfers.get(key);
      if (!t) {
        t = { id: `tr_${++this.n}`, group: params.get("transfer_group")!, amount: Number(params.get("amount")) };
        this.transfers.set(key, t);
      }
      if (this.failNextTransferWith === "network") {
        this.failNextTransferWith = null;
        throw new Error("socket hang up"); // Stripe made the transfer; we never saw the reply.
      }
      return ok({ id: t.id, amount: t.amount, amount_reversed: 0, currency: params.get("currency"), destination: params.get("destination"), reversed: false, transfer_group: t.group, metadata: {} });
    }
    if (method === "GET" && p === "/v1/transfers") {
      const group = params.get("transfer_group");
      const found = [...this.transfers.values()].filter((t) => t.group === group);
      return ok({ data: found.map((t) => ({ id: t.id, amount: t.amount, amount_reversed: 0, currency: "usd", destination: "acct", reversed: false, transfer_group: t.group, metadata: {} })) });
    }
    if (method === "POST" && p === "/v1/accounts") return ok({ id: "acct_lena", email: params.get("email"), charges_enabled: false, payouts_enabled: false, details_submitted: false });
    if (method === "POST" && p === "/v1/account_links") return ok({ url: `https://connect.stripe.com/setup/e/${params.get("account")}`, expires_at: 0 });
    if (method === "POST" && p === "/v1/customers") return ok({ id: "cus_whitfield", metadata: {} });
    if (method === "POST" && p === "/v1/checkout/sessions") return ok({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", mode: "setup", status: "open", customer: "cus_whitfield", setup_intent: null, metadata: {} });
    if (method === "GET" && p.startsWith("/v1/setup_intents/")) {
      return ok({
        id: p.split("/").pop(),
        status: "succeeded",
        customer: "cus_whitfield",
        metadata: {},
        payment_method: { id: "pm_visa", type: "card", customer: "cus_whitfield", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030, fingerprint: "abc", funding: "credit" } },
      });
    }
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: `No fake for ${method} ${p}` } }), { status: 404 });
  };
}

const getDb = useDb();
let db: Db;
let stripe: FakeStripe;
let mail: MemoryMailer;
let deps: MoneyDeps;
let handlers: ReturnType<typeof makeHandlers>;

beforeEach(async () => {
  db = getDb();
  await withSystem(db, (q) => seedMoney(q, NOW));
  stripe = new FakeStripe();
  mail = new MemoryMailer();
  deps = { stripe: new StripeClient("sk_test", { fetch: stripe.fetch }), mail, appUrl: "https://app.example.com", linkSecret: "sk_test" };
  handlers = makeHandlers(() => deps, () => NOW);
});

const receivableFor = async (itemId: string) => withTenant(db, expert, (q) => repo.getReceivableByItem(q, itemId));
const confirm = (itemId: string, ref: string | null = null) =>
  withTenant(db, expert, (q) => q.query("update trip_items set state = 'confirmed', confirmation_ref = coalesce($2, confirmation_ref) where id = $1", [itemId, ref]));

async function webhook(event: object, at = NOW) {
  const body = JSON.stringify({ livemode: false, created: Math.floor(at.getTime() / 1000), data: {}, ...event });
  return ingestStripeWebhook(db, body, signStripePayload(body, SECRET, at), SECRET, NOW);
}

describe("receivables", () => {
  it("are created once when a line with commission terms is confirmed", async () => {
    const seeded = await receivableFor(DEMO.hotelCdmx);
    expect(seeded).toMatchObject({ expectedMinor: 112_000, currency: "USD", basis: "rate", hostAgency: "Example Travel Collective", confirmationRef: "CA-55812" });
    expect(seeded!.commissionRecipient).toContain("Example Travel Collective");

    expect(await receivableFor(DEMO.hotelOaxaca)).toBeNull(); // terms set, not yet confirmed
    await confirm(DEMO.hotelOaxaca, "HTR-7781");
    await withTenant(db, expert, (q) => q.query("update trip_items set state = 'cancel_requested' where id = $1", [DEMO.hotelOaxaca]));
    await confirm(DEMO.hotelOaxaca);
    const { rows } = await withTenant(db, expert, (q) => q.query("select expected_minor from money_receivables where item_id = $1", [DEMO.hotelOaxaca]));
    expect(rows).toEqual([{ expected_minor: 147_500 }]);

    // A confirmed line without terms gets its receivable when terms are added.
    expect(await receivableFor(DEMO.flight)).toBeNull();
    await setCommissionTerms(db, expert, { itemId: DEMO.flight, rateBps: null, amountMinor: 5_000, expectedBy: "2026-12-01", hostAgency: null });
    expect(await receivableFor(DEMO.flight)).toMatchObject({ expectedMinor: 5_000, basis: "amount", expectedBy: "2026-12-01" });
  });

  it("any member who can confirm a line creates the receivable, including an assistant", async () => {
    await withTenant(db, assistant, (q) => q.query("update trip_items set state = 'confirmed' where id = $1", [DEMO.hotelOaxaca]));
    expect(await receivableFor(DEMO.hotelOaxaca)).not.toBeNull();
  });

  it("status follows receipts and adjustments, including FX and disputes", async () => {
    await confirm(DEMO.hotelOaxaca, "HTR-7781");
    const r = (await receivableFor(DEMO.hotelOaxaca))!;
    const base = { receivableId: r.id, fxRate: null, landedIn: null, at: NOW.toISOString(), note: null, currency: "USD" };
    // Paid in EUR at the rate applied.
    let s = await recordReceipt(db, expert, { ...base, kind: "received", amountMinor: 130_000, currency: "EUR", fxRate: 1.1, landedIn: "external_account" }, NOW);
    expect(s).toMatchObject({ received: 143_000, status: "short", variance: -4_500 });
    s = await recordReceipt(db, expert, { ...base, kind: "received", amountMinor: 4_500, landedIn: "external_account" }, NOW);
    expect(s.status).toBe("settled");
    s = await recordReceipt(db, expert, { ...base, kind: "host_deduction", amountMinor: -14_750 }, NOW);
    expect(s).toMatchObject({ net: 132_750, status: "short" });
    s = await recordReceipt(db, expert, { ...base, kind: "dispute_hold", amountMinor: -10_000 }, NOW);
    expect(s.status).toBe("disputed");
    s = await recordReceipt(db, expert, { ...base, kind: "dispute_hold", amountMinor: 10_000 }, NOW);
    expect(s.status).toBe("short");
    await expect(recordReceipt(db, expert, { ...base, kind: "reversal", amountMinor: -500_000 }, NOW)).rejects.toThrow(/below zero/);
    await expect(recordReceipt(db, expert, { ...base, kind: "received", amountMinor: 100, currency: "EUR" }, NOW)).rejects.toThrow(/rate/);
    const { rows } = await withTenant(db, expert, (q) => q.query<{ original_currency: string; original_amount_minor: number }>("select original_currency, original_amount_minor from money_receipt_events where receivable_id = $1 and original_currency is not null", [r.id]));
    expect(rows).toEqual([{ original_currency: "EUR", original_amount_minor: 130_000 }]);
  });
});

describe("host-agency statements", () => {
  const statement = ["Confirmation Number,Supplier,Guest,Amount,Currency,Host Fee", "HTR 7781,Hacienda Tierra Roja,Whitfield,1475.00,USD,147.50", "ZZ-000,Somewhere,Nobody,99.00,USD,"].join("\n");

  it("matches by confirmation number, lists the rest, and re-import is a no-op", async () => {
    await confirm(DEMO.hotelOaxaca, "HTR-7781");
    const first = await importStatement(db, expert, { fileName: "sept.csv", content: statement, defaultCurrency: null, hostAgency: "Example Travel Collective" }, NOW);
    expect(first).toMatchObject({ duplicate: false, matched: 1, unmatched: 1 });
    const r = (await receivableFor(DEMO.hotelOaxaca))!;
    const events = await withTenant(db, expert, (q) => repo.listEvents(q, r.id));
    expect(events.map((e) => [e.kind, e.amountMinor, e.landedIn, e.source])).toEqual([
      ["received", 147_500, "external_account", "statement"],
      ["host_deduction", -14_750, null, "statement"],
    ]);

    const again = await importStatement(db, expert, { fileName: "sept-copy.csv", content: statement, defaultCurrency: null, hostAgency: null }, NOW);
    expect(again).toMatchObject({ duplicate: true, importId: first.importId });
    expect(await withTenant(db, expert, (q) => repo.listEvents(q, r.id))).toHaveLength(2);

    // The unmatched row is matched by hand to another receivable.
    await setCommissionTerms(db, expert, { itemId: DEMO.flight, rateBps: null, amountMinor: 9_900, expectedBy: null, hostAgency: null });
    const flight = (await receivableFor(DEMO.flight))!;
    const rows = await withTenant(db, expert, (q) => repo.listStatementRows(q, first.importId));
    const open = rows.find((x) => x.status === "unmatched")!;
    expect(open.reason).toMatch(/No receivable/);
    await expect(matchStatementRow(db, assistant, { rowId: open.id, receivableId: flight.id }, NOW)).rejects.toThrow(/role/);
    await matchStatementRow(db, expert, { rowId: open.id, receivableId: flight.id }, NOW);
    await expect(matchStatementRow(db, expert, { rowId: open.id, receivableId: flight.id }, NOW)).rejects.toThrow(/already/);
    const views = await withTenant(db, expert, (q) => repo.listEvents(q, flight.id));
    expect(views.map((e) => e.amountMinor)).toEqual([9_900]);
  });
});

describe("allocation and the payout gate", () => {
  it("allocates the adjusted net exactly; assistants prepare, only owners approve", async () => {
    // Seeded: received 1120.00, host deduction 112.00 → net 1008.00; 80/20 split; 250.00 referral fee.
    const ids = await prepareBatches(db, assistant, NOW);
    expect(ids).toHaveLength(1);
    const r = (await receivableFor(DEMO.hotelCdmx))!;
    const lines = await withTenant(db, expert, (q) => repo.listLines(q, { receivableId: r.id }));
    expect(lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(100_800);
    expect(lines.map((l) => [l.recipientName, l.amountMinor, l.status]).sort()).toEqual([
      ["Lena Brandt", 20_160, "pending"],
      ["Marisol Vega Travel", 80_640, "retained"],
    ]);
    const batch = (await withTenant(db, expert, (q) => repo.listBatches(q, ids[0])))[0]!;
    expect(batch).toMatchObject({ status: "draft", lineCount: 2, totalMinor: 20_160 + 25_000 });

    // Idempotent: nothing new to prepare.
    await expect(prepareBatches(db, assistant, NOW)).rejects.toThrow(/Nothing is ready/);

    await expect(approveBatch(db, assistant, ids[0]!, NOW)).rejects.toThrow(/owner/);
    await expect(approveBatch(db, backup, ids[0]!, NOW)).rejects.toThrow(/owner/);
    // Row-level security holds even if the service check were bypassed.
    await withTenant(db, assistant, (q) => q.query("update money_payout_batches set status = 'approved', approved_by = $2 where id = $1", [ids[0], DEMO.assistant])).catch(() => undefined);
    expect((await withTenant(db, expert, (q) => repo.listBatches(q, ids[0])))[0]!.status).toBe("draft");
    await expect(
      withTenant(db, assistant, (q) => q.query("update money_payout_lines set status = 'approved' where batch_id = $1 returning id", [ids[0]])),
    ).rejects.toThrow(/row-level security/);

    await approveBatch(db, expert, ids[0]!, NOW);
    await expect(approveBatch(db, expert, ids[0]!, NOW)).rejects.toThrow(/draft/);
  });

  it("a draft batch can be canceled and its lines prepared again", async () => {
    const [id] = await prepareBatches(db, assistant, NOW);
    await cancelBatch(db, assistant, id!);
    const again = await prepareBatches(db, assistant, NOW);
    expect(again).toHaveLength(1);
    expect((await withTenant(db, expert, (q) => repo.listBatches(q, again[0])))[0]!.lineCount).toBe(2);
  });

  it("split terms can't be agreed until both hosts permit sharing, and only by an owner", async () => {
    await confirm(DEMO.hotelOaxaca, "HTR-7781");
    const split = await importCollaborationFeeLines(db, backup, {
      itemId: DEMO.hotelOaxaca,
      collaborationRef: "collab-123",
      reversalLossBearer: "owner_workspace",
      hostRulesOurs: "permitted",
      hostRulesTheirs: "unknown",
      lines: [
        { kind: "commission_split", amount: null, commissionShareBps: 3000, bookingItemIds: [DEMO.hotelOaxaca], recipientId: MONEY_DEMO.specialistRecipient },
        { kind: "design", amount: { amountMinor: 40_000, currency: "USD" }, commissionShareBps: null, bookingItemIds: [DEMO.hotelOaxaca], recipientId: MONEY_DEMO.specialistRecipient },
      ],
    });
    expect(split.shares.find((s) => s.recipientId === MONEY_DEMO.workspaceRecipient)!.bps).toBe(7000);
    expect(split.collaborationRef).toBe("collab-123");
    await expect(agreeSplit(db, backup, split.id, NOW)).rejects.toThrow(/owner/);
    await expect(agreeSplit(db, expert, split.id, NOW)).rejects.toThrow(/host agreements/);
    await saveSplitTerms(db, expert, { itemId: DEMO.hotelOaxaca, collaborationRef: "collab-123", reversalLossBearer: "owner_workspace", hostRulesOurs: "permitted", hostRulesTheirs: "permitted", shares: split.shares, fees: split.fees });
    await agreeSplit(db, expert, split.id, NOW);
    await expect(saveSplitTerms(db, expert, { itemId: DEMO.hotelOaxaca, collaborationRef: null, reversalLossBearer: "pro_rata", hostRulesOurs: "permitted", hostRulesTheirs: "permitted", shares: [], fees: [] })).rejects.toThrow(/agreed/);
  });

  it("a reversal after allocation is re-allocated per the terms' loss bearer", async () => {
    await prepareBatches(db, expert, NOW);
    const r = (await receivableFor(DEMO.hotelCdmx))!;
    await recordReceipt(db, expert, { receivableId: r.id, kind: "reversal", amountMinor: -10_000, currency: "USD", fxRate: null, landedIn: null, at: NOW.toISOString(), note: "Guest shortened stay" }, NOW);
    const lines = await withTenant(db, expert, (q) => repo.listLines(q, { receivableId: r.id }));
    expect(lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(90_800);
    const lena = lines.filter((l) => l.recipientId === MONEY_DEMO.backupRecipient);
    // Lena's line was already in a batch, so the reduction is its own (negative) line.
    expect(lena.map((l) => [l.kind, l.amountMinor])).toEqual([["commission_share", 20_160], ["commission_adjustment", -2_000]]);
    const { rows } = await withTenant(db, expert, (q) => q.query<{ borne_by: string; amount_minor: number }>("select borne_by, amount_minor from money_adjustments"));
    expect(rows).toEqual([{ borne_by: "pro_rata", amount_minor: -10_000 }]);
  });
});

describe("payout execution", () => {
  async function onboardLena() {
    await withTenant(db, expert, (q) => q.query("update money_recipients set stripe_account_id = 'acct_lena', payouts_enabled = true, onboarding_status = 'enabled' where id = $1", [MONEY_DEMO.backupRecipient]));
  }
  async function fundPlatform() {
    // Commission collected into the platform balance (e.g. the supplier paid the platform directly).
    await withTenant(db, expert, (q) => q.query("update money_receipt_events set landed_in = 'platform_balance' where kind = 'received'"));
  }

  it("transfers a funded share to an onboarded payee and instructs the rest", async () => {
    await onboardLena();
    await fundPlatform();
    const [batchId] = await prepareBatches(db, assistant, NOW);
    await approveBatch(db, expert, batchId!, NOW);
    await drain(db, handlers);

    const post = stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/transfers");
    expect(post).toHaveLength(1);
    const lines = await withTenant(db, expert, (q) => repo.listLines(q, { batchId }));
    const share = lines.find((l) => l.kind === "commission_share")!;
    expect(post[0]!.headers["Idempotency-Key"]).toBe(`payout-line-${share.id}`);
    expect(post[0]!.params.get("amount")).toBe("20160");
    expect(post[0]!.params.get("destination")).toBe("acct_lena");
    expect(share).toMatchObject({ status: "settled", method: "platform_transfer", stripeTransferId: "tr_1" });

    // The referral fee is owed by the workspace, which the platform doesn't hold: an instruction.
    const fee = lines.find((l) => l.kind === "referral")!;
    expect(fee).toMatchObject({ status: "instructed", method: "settlement_instruction" });
    const [instr] = await withTenant(db, expert, (q) => repo.listInstructions(q, { lineId: fee.id }));
    expect(instr).toMatchObject({ payerName: "Marisol Vega Travel", payeeName: "Ana Ruiz (Oaxaca specialist)", amountMinor: 25_000, status: "issued" });
    const toPayer = mail.sent.find((m) => m.to === "marisol@example.com" && m.subject.includes(instr!.reference))!;
    expect(toPayer.text).toContain("$250.00");
    expect(toPayer.text).toContain("Sent automatically");
    expect(mail.sent.some((m) => m.to === "ana.ruiz@example.org")).toBe(true);

    await expect(markInstructionSettled(db, assistant, instr!.id, NOW)).rejects.toThrow(/role/);
    await markInstructionSettled(db, expert, instr!.id, NOW);
    expect((await withTenant(db, expert, (q) => repo.listBatches(q, batchId)))[0]!.status).toBe("completed");

    // Running the job again moves no money.
    await handlers["money.execute_batch"]!({ db, job: { id: 0, kind: "money.execute_batch", payload: { batchId }, workspaceId: DEMO.workspace, memberId: DEMO.expert, attempts: 1, maxAttempts: 8 }, tenant: expert });
    expect(stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/transfers")).toHaveLength(1);
  });

  it("without a funded path, a commission share is paid by instruction with the payee's details", async () => {
    await onboardLena(); // onboarded, but the commission landed in the advisor's own account
    await setSettlementDetails(db, expert, MONEY_DEMO.backupRecipient, "IBAN DE89 3704 0044 0532 0130 00");
    const [batchId] = await prepareBatches(db, expert, NOW);
    await approveBatch(db, expert, batchId!, NOW);
    await drain(db, handlers);
    expect(stripe.calls.filter((c) => c.path === "/v1/transfers")).toHaveLength(0);
    const share = (await withTenant(db, expert, (q) => repo.listLines(q, { batchId }))).find((l) => l.kind === "commission_share")!;
    expect(share.status).toBe("instructed");
    expect(mail.sent.find((m) => m.to === "marisol@example.com" && m.text.includes("$201.60"))!.text).toContain("IBAN DE89");
    const { rows } = await withTenant(db, expert, (q) => q.query<{ settlement_details_enc: string }>("select settlement_details_enc from money_recipients where id = $1", [MONEY_DEMO.backupRecipient]));
    expect(rows[0]!.settlement_details_enc).not.toContain("DE89");
  });

  it("an outcome-unknown transfer is reconciled before retry, never paid twice", async () => {
    await onboardLena();
    await fundPlatform();
    const [batchId] = await prepareBatches(db, expert, NOW);
    await approveBatch(db, expert, batchId!, NOW);
    stripe.failNextTransferWith = "network";
    await drain(db, handlers, 1);
    let share = (await withTenant(db, expert, (q) => repo.listLines(q, { batchId }))).find((l) => l.kind === "commission_share")!;
    expect(share.status).toBe("sending");
    // Retry: looks the transfer up by group first and adopts it.
    await withSystem(db, (q) => q.query("update jobs set run_at = now() where status = 'queued'"));
    await drain(db, handlers);
    share = (await withTenant(db, expert, (q) => repo.listLines(q, { batchId }))).find((l) => l.kind === "commission_share")!;
    expect(share).toMatchObject({ status: "settled", stripeTransferId: "tr_1" });
    expect(stripe.transfers.size).toBe(1);
    expect(stripe.calls.some((c) => c.method === "GET" && c.path === "/v1/transfers" && c.params.get("transfer_group") === `line_${share.id}`)).toBe(true);
  });

  it("a declined transfer fails the line and tells the owner", async () => {
    await onboardLena();
    await fundPlatform();
    const [batchId] = await prepareBatches(db, expert, NOW);
    await approveBatch(db, expert, batchId!, NOW);
    stripe.failNextTransferWith = "insufficient";
    await drain(db, handlers);
    const share = (await withTenant(db, expert, (q) => repo.listLines(q, { batchId }))).find((l) => l.kind === "commission_share")!;
    expect(share).toMatchObject({ status: "failed", failure: expect.stringContaining("Insufficient") });
    expect(mail.sent.some((m) => m.subject.includes("could not be sent"))).toBe(true);
  });
});

describe("stripe webhook", () => {
  it("rejects bad, stale and unsigned deliveries and dedupes replays", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "account.updated", data: { object: { id: "acct_x" } } });
    expect(await ingestStripeWebhook(db, body, signStripePayload(body, "wrong", NOW), SECRET, NOW)).toMatchObject({ status: 400, error: expect.stringContaining("mismatch") });
    expect(await ingestStripeWebhook(db, body, signStripePayload(body, SECRET, new Date(NOW.getTime() - 600_000)), SECRET, NOW)).toMatchObject({ status: 400, error: expect.stringContaining("stale") });
    expect(await ingestStripeWebhook(db, body, null, SECRET, NOW)).toMatchObject({ status: 400 });
    expect(await ingestStripeWebhook(db, body, "t=1,v1=00", undefined, NOW)).toMatchObject({ status: 503 });
    const header = signStripePayload(body, SECRET, NOW);
    expect(await ingestStripeWebhook(db, body, header, SECRET, NOW)).toEqual({ status: 200, duplicate: false, eventId: "evt_1" });
    expect(await ingestStripeWebhook(db, body, header, SECRET, NOW)).toEqual({ status: 200, duplicate: true, eventId: "evt_1" });
    const { rows } = await withSystem(db, (q) => q.query("select id from jobs where kind = 'money.stripe_event'"));
    expect(rows).toHaveLength(1);
  });

  it("account.updated moves a payee through onboarding", async () => {
    const url = await startOnboarding(db, expert, MONEY_DEMO.backupRecipient, deps, NOW);
    expect(url).toContain("acct_lena");
    const created = stripe.calls.find((c) => c.path === "/v1/accounts")!;
    expect(created.headers["Idempotency-Key"]).toBe(`acct-${MONEY_DEMO.backupRecipient}`);
    expect(created.params.get("type")).toBe("express");
    expect(created.params.get("capabilities[transfers][requested]")).toBe("true");
    const link = stripe.calls.find((c) => c.path === "/v1/account_links")!;
    expect(link.params.get("refresh_url")).toMatch(/^https:\/\/app\.example\.com\/api\/webhooks\/stripe\/connect\?r=/);
    expect(mail.sent.some((m) => m.to === "lena@example.com")).toBe(true);

    await webhook({ id: "evt_acct", type: "account.updated", data: { object: { id: "acct_lena", charges_enabled: true, payouts_enabled: true, details_submitted: true } } });
    await drain(db, handlers);
    const lena = await withTenant(db, expert, (q) => repo.getRecipient(q, MONEY_DEMO.backupRecipient));
    expect(lena).toMatchObject({ stripeAccountId: "acct_lena", onboardingStatus: "enabled", payoutsEnabled: true });
  });

  it("transfer.reversed records an adjustment with the loss bearer and notifies the owner", async () => {
    await withTenant(db, expert, (q) => q.query("update money_recipients set stripe_account_id = 'acct_lena', payouts_enabled = true where id = $1", [MONEY_DEMO.backupRecipient]));
    await withTenant(db, expert, (q) => q.query("update money_receipt_events set landed_in = 'platform_balance' where kind = 'received'"));
    const [batchId] = await prepareBatches(db, expert, NOW);
    await approveBatch(db, expert, batchId!, NOW);
    await drain(db, handlers);
    const share = (await withTenant(db, expert, (q) => repo.listLines(q, { batchId }))).find((l) => l.kind === "commission_share")!;

    const reversed = { id: share.stripeTransferId, amount: 20_160, amount_reversed: 5_000, currency: "usd", destination: "acct_lena", reversed: false, transfer_group: `line_${share.id}`, metadata: { payout_line_id: share.id } };
    await webhook({ id: "evt_rev", type: "transfer.reversed", data: { object: reversed } });
    await webhook({ id: "evt_rev_again", type: "transfer.reversed", data: { object: reversed } }); // a second event with the same state
    await drain(db, handlers);
    const after = (await withTenant(db, expert, (q) => repo.getLine(q, share.id)))!;
    expect(after).toMatchObject({ reversedMinor: 5_000, status: "settled" });
    const { rows } = await withTenant(db, expert, (q) => q.query<{ kind: string; amount_minor: number; borne_by: string }>("select kind, amount_minor, borne_by from money_adjustments"));
    expect(rows).toEqual([{ kind: "transfer_reversal", amount_minor: -5_000, borne_by: "pro_rata" }]);
    expect(mail.sent.filter((m) => m.subject.startsWith("Transfer reversed"))).toHaveLength(1);

    await webhook({ id: "evt_rev_full", type: "transfer.reversed", data: { object: { ...reversed, amount_reversed: 20_160, reversed: true } } });
    await drain(db, handlers);
    expect((await withTenant(db, expert, (q) => repo.getLine(q, share.id)))!).toMatchObject({ reversedMinor: 20_160, status: "reversed" });
    const earnings = (await withTenant(db, expert, (q) => reports(q, NOW))).earnings.find((e) => e.recipientId === MONEY_DEMO.backupRecipient)!;
    expect(earnings).toMatchObject({ settledMinor: 0, reversedMinor: 20_160 });
  });

  it("transfer.created settles a line whose API reply was lost", async () => {
    await withTenant(db, expert, (q) => q.query("update money_recipients set stripe_account_id = 'acct_lena', payouts_enabled = true where id = $1", [MONEY_DEMO.backupRecipient]));
    await withTenant(db, expert, (q) => q.query("update money_receipt_events set landed_in = 'platform_balance' where kind = 'received'"));
    const [batchId] = await prepareBatches(db, expert, NOW);
    await approveBatch(db, expert, batchId!, NOW);
    stripe.failNextTransferWith = "network";
    await drain(db, handlers, 1);
    const share = (await withTenant(db, expert, (q) => repo.listLines(q, { batchId }))).find((l) => l.kind === "commission_share")!;
    await webhook({ id: "evt_tc", type: "transfer.created", data: { object: { id: "tr_1", amount: 20_160, amount_reversed: 0, currency: "usd", destination: "acct_lena", reversed: false, transfer_group: `line_${share.id}`, metadata: { payout_line_id: share.id } } } });
    await drain(db, handlers, 1); // the next job in line is the event (the batch retry is backed off)
    expect((await withTenant(db, expert, (q) => repo.getLine(q, share.id)))!).toMatchObject({ status: "settled", stripeTransferId: "tr_1" });
  });

  it("payout.failed on a payee's account is recorded and the owner told", async () => {
    await withTenant(db, expert, (q) => q.query("update money_recipients set stripe_account_id = 'acct_lena' where id = $1", [MONEY_DEMO.backupRecipient]));
    await webhook({ id: "evt_pf", type: "payout.failed", account: "acct_lena", data: { object: { id: "po_1", amount: 20_160, currency: "usd", failure_code: "account_closed", failure_message: "The bank account has been closed" } } });
    await drain(db, handlers);
    expect((await withTenant(db, expert, (q) => repo.getRecipient(q, MONEY_DEMO.backupRecipient)))!.lastPayoutFailure).toContain("closed");
    expect(mail.sent.some((m) => m.to === "marisol@example.com" && m.subject.includes("failed at their bank"))).toBe(true);
  });
});

describe("card vault", () => {
  it("uses Stripe-hosted setup and stores only the token and display metadata", async () => {
    const url = await createCardSetupLink(db, assistant, { clientId: DEMO.client, email: "whitfields@example.com" }, deps, NOW);
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    const session = stripe.calls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(session.params.get("mode")).toBe("setup");
    expect(session.params.get("customer")).toBe("cus_whitfield");
    expect(session.headers["Idempotency-Key"]).toMatch(/^card-setup-/);
    expect(mail.sent.find((m) => m.to === "whitfields@example.com")!.text).toContain(url);

    const setupId = session.params.get("metadata[card_setup_id]")!;
    const meta = { workspace_id: DEMO.workspace, client_id: DEMO.client, card_setup_id: setupId };
    await webhook({ id: "evt_cs", type: "checkout.session.completed", data: { object: { id: "cs_test_1", mode: "setup", customer: "cus_whitfield", setup_intent: "seti_1", metadata: meta } } });
    await webhook({ id: "evt_si", type: "setup_intent.succeeded", data: { object: { id: "seti_1", status: "succeeded", customer: "cus_whitfield", payment_method: "pm_visa", metadata: meta } } });
    stripe.calls.length = 0;
    await drain(db, handlers);

    const { rows } = await withTenant(db, expert, (q) => q.query<Record<string, unknown>>("select * from money_payment_methods"));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["brand", "client_id", "created_at", "exp_month", "exp_year", "id", "last4", "removed_at", "stripe_customer_id", "stripe_payment_method_id", "workspace_id"].sort(),
    );
    expect(rows[0]).toMatchObject({ brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030, stripe_payment_method_id: "pm_visa" });
    expect(JSON.stringify(rows[0])).not.toContain("fingerprint");
    const setups = await withTenant(db, expert, (q) => q.query<{ status: string }>("select status from money_card_setups"));
    expect(setups.rows).toEqual([{ status: "completed" }]);
    expect(await withTenant(db, outsider, (q) => repo.listPaymentMethods(q, DEMO.client))).toEqual([]);
  });

  it("ignores metadata pointing at another workspace's client", async () => {
    await webhook({ id: "evt_x", type: "setup_intent.succeeded", data: { object: { id: "seti_2", status: "succeeded", customer: "cus_whitfield", payment_method: "pm_visa", metadata: { workspace_id: DEMO.otherWorkspace, client_id: DEMO.client } } } });
    await drain(db, handlers);
    expect((await withSystem(db, (q) => q.query("select 1 from money_payment_methods"))).rows).toHaveLength(0);
  });
});

describe("money row-level security", () => {
  const TABLES = [
    "money_receivables", "money_receipt_events", "money_statement_imports", "money_statement_rows", "money_recipients", "money_splits",
    "money_split_shares", "money_split_fees", "money_payout_batches", "money_payout_lines", "money_settlement_instructions", "money_adjustments",
    "money_stripe_customers", "money_card_setups", "money_payment_methods",
  ];

  async function populate() {
    await confirm(DEMO.hotelOaxaca, "HTR-7781");
    await importStatement(db, expert, { fileName: "s.csv", content: "Conf,Amount,Currency\nHTR-7781,10.00,USD\nNOPE,1.00,USD", defaultCurrency: null, hostAgency: null }, NOW);
    await addRecipient(db, expert, { kind: "external", memberId: null, name: "Outside Expert", email: null });
    const [batchId] = await prepareBatches(db, expert, NOW);
    await approveBatch(db, expert, batchId!, NOW);
    await drain(db, handlers);
    await recordReceipt(db, expert, { receivableId: (await receivableFor(DEMO.hotelCdmx))!.id, kind: "reversal", amountMinor: -1_000, currency: "USD", fxRate: null, landedIn: null, at: NOW.toISOString(), note: null }, NOW);
    await createCardSetupLink(db, expert, { clientId: DEMO.client, email: null }, deps, NOW);
    await withSystem(db, (q) =>
      q.query(
        "insert into money_payment_methods (workspace_id, client_id, stripe_customer_id, stripe_payment_method_id, brand, last4, exp_month, exp_year) values ($1,$2,'cus_whitfield','pm_1','visa','4242',1,2031)",
        [DEMO.workspace, DEMO.client],
      ),
    );
  }

  it("another workspace sees nothing and can write nothing", async () => {
    await populate();
    for (const t of TABLES) {
      const mine = await withTenant(db, expert, (q) => q.query(`select 1 from ${t}`));
      expect(mine.rows.length, `${t} populated`).toBeGreaterThan(0);
      const theirs = await withTenant(db, outsider, (q) => q.query(`select 1 from ${t}`));
      expect(theirs.rows, `${t} isolated`).toEqual([]);
    }
    await expect(
      withTenant(db, outsider, (q) => q.query("insert into money_recipients (workspace_id, kind, name) values ($1, 'external', 'x')", [DEMO.workspace])),
    ).rejects.toThrow(/row-level security/);
    const upd = await withTenant(db, outsider, (q) => q.query("update money_payout_lines set amount_minor = 1 returning id"));
    expect(upd.rows).toEqual([]);
    expect((await withTenant(db, outsider, (q) => q.query("select 1 from money_stripe_events").catch((e: Error) => e.message))) as unknown).toMatch(/permission denied/);
  });

  it("assistants read the ledger but can't record money facts", async () => {
    await populate();
    for (const t of ["money_receivables", "money_receipt_events", "money_payout_lines", "money_settlement_instructions"]) {
      expect((await withTenant(db, assistant, (q) => q.query(`select 1 from ${t}`))).rows.length, t).toBeGreaterThan(0);
    }
    const r = (await receivableFor(DEMO.hotelCdmx))!;
    await expect(
      withTenant(db, assistant, (q) =>
        q.query("insert into money_receipt_events (workspace_id, receivable_id, kind, amount_minor, landed_in, at) values ($1,$2,'received',100,'external_account',now())", [DEMO.workspace, r.id]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(recordReceipt(db, assistant, { receivableId: r.id, kind: "received", amountMinor: 100, currency: "USD", fxRate: null, landedIn: "external_account", at: NOW.toISOString(), note: null }, NOW)).rejects.toThrow(/role/);
    await expect(withTenant(db, assistant, (q) => q.query("insert into money_split_shares (split_id, workspace_id, recipient_id, bps) values ($1,$2,$3,1)", [MONEY_DEMO.splitCdmx, DEMO.workspace, MONEY_DEMO.backupRecipient]))).rejects.toThrow(/row-level security/);
    const upd = await withTenant(db, assistant, (q) => q.query("update money_settlement_instructions set status = 'settled' returning id"));
    expect(upd.rows).toEqual([]);
    const pm = await withTenant(db, assistant, (q) => q.query("update money_payment_methods set removed_at = now() returning id"));
    expect(pm.rows).toEqual([]);
  });

  it("receivables on a private trip are visible only with the trip", async () => {
    await withTenant(db, expert, (q) => q.query("update trips set scope = 'private' where id = $1", [DEMO.trip]));
    expect(await withTenant(db, assistant, (q) => repo.listReceivables(q))).toEqual([]);
    expect((await withTenant(db, expert, (q) => repo.listReceivables(q))).length).toBe(1);
  });
});
