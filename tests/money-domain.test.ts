import { describe, expect, it } from "vitest";
import type { ReceiptEvent, Receivable } from "@/domain/ledger";
import {
  allocateNet,
  assertCanApproveBatch,
  assertSplitAgreeable,
  convertFx,
  earnings,
  hostDeductions,
  lineMethod,
  matchStatementRows,
  parseAmountMinor,
  parseCommissionStatement,
  parseCsv,
  paymentDelays,
  reallocationDelta,
  receivableState,
  settlementInstructionText,
  splitFromFeeLines,
  validateReceiptEvent,
  type SplitTerms,
} from "@/domain/money";
import { formEncode, signStripePayload, StripeClient, StripeError, verifyStripeSignature } from "@/providers/stripe";

const NOW = new Date("2026-10-01T12:00:00Z");
const r: Receivable = { id: "r1", itemId: "i1", expectedMinor: 10_000, currency: "USD", expectedBy: "2026-09-15" };
const ev = (kind: ReceiptEvent["kind"], amountMinor: number, at = "2026-09-20T00:00:00Z"): ReceiptEvent => ({ receivableId: "r1", kind, amountMinor, at, note: null });

describe("amounts and FX", () => {
  it("parses human amounts into minor units per currency", () => {
    expect(parseAmountMinor("1,234.56", "USD")).toBe(123_456);
    expect(parseAmountMinor("(12.5)", "EUR")).toBe(-1_250);
    expect(parseAmountMinor("$40", "USD")).toBe(4_000);
    expect(parseAmountMinor("1500", "JPY")).toBe(1_500);
    expect(() => parseAmountMinor("1.5", "JPY")).toThrow(/decimals/);
    expect(() => parseAmountMinor("abc", "USD")).toThrow(/Not an amount/);
  });

  it("converts at the rate applied, across exponents", () => {
    expect(convertFx(100_000, "EUR", 1.0825, "USD")).toBe(108_250);
    expect(convertFx(10_000, "JPY", 0.0067, "USD")).toBe(6_700);
    expect(convertFx(-1_850, "EUR", 1.08, "USD")).toBe(-1_998);
    expect(() => convertFx(1, "EUR", 0, "USD")).toThrow(/rate/);
  });
});

describe("receivable status with adjustments", () => {
  it("moves expected → overdue → short → settled, adjustments applied before the split", () => {
    const early = new Date("2026-09-01T00:00:00Z");
    expect(receivableState(r, [], early).status).toBe("expected");
    expect(receivableState(r, [], NOW).status).toBe("overdue");
    const short = receivableState(r, [ev("received", 10_000), ev("host_deduction", -1_000)], NOW);
    expect(short).toMatchObject({ received: 10_000, adjustments: -1_000, net: 9_000, status: "short", variance: -1_000 });
    expect(receivableState(r, [ev("received", 11_000), ev("host_deduction", -1_000)], NOW).status).toBe("settled");
    expect(receivableState(r, [ev("received", 10_000), ev("reversal", -10_000)], NOW)).toMatchObject({ net: 0, status: "short" });
  });

  it("a dispute hold marks it disputed until released", () => {
    const held = [ev("received", 10_000), ev("dispute_hold", -10_000)];
    expect(receivableState(r, held, NOW).status).toBe("disputed");
    expect(receivableState(r, [...held, ev("dispute_hold", 10_000)], NOW)).toMatchObject({ status: "settled", net: 10_000 });
  });

  it("validates signs and required details", () => {
    const base = { landedIn: null, originalCurrency: null, originalAmountMinor: null, fxRate: null };
    expect(() => validateReceiptEvent({ ...base, kind: "received", amountMinor: 100 })).toThrow(/landed/);
    expect(() => validateReceiptEvent({ ...base, kind: "host_deduction", amountMinor: 100 })).toThrow(/negative/);
    expect(() => validateReceiptEvent({ ...base, kind: "fx", amountMinor: -100 })).toThrow(/original currency/);
    expect(() => validateReceiptEvent({ ...base, kind: "received", amountMinor: 100, landedIn: "platform_balance" })).not.toThrow();
  });
});

describe("commission statements", () => {
  const csv = [
    '"Conf #",Supplier,Guest Name,Commission,Currency,Host Fee',
    'CA-55812,Casa Alma,"Whitfield, Tom",1120.00,USD,112.00',
    "X-1,Unknown,Someone,50,USD,",
    "HT-9,Hacienda,Guest,\"1,000.50\",EUR,",
    "BAD,Hotel,Guest,twelve,USD,",
    "",
  ].join("\r\n");

  it("parses quoted fields, aliases and deductions; reports unreadable rows", () => {
    expect(parseCsv('a,"b,""c"""\n1,2')).toEqual([["a", 'b,"c"'], ["1", "2"]]);
    const p = parseCommissionStatement(csv);
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toEqual({ rowNo: 2, confirmationRef: "CA-55812", supplier: "Casa Alma", guest: "Whitfield, Tom", amountMinor: 112_000, deductionMinor: -11_200, currency: "USD" });
    expect(p.rows[2]!.amountMinor).toBe(100_050);
    expect(p.errors).toEqual([{ rowNo: 5, message: expect.stringContaining("twelve") }]);
    expect(() => parseCommissionStatement("Supplier,Amount\nA,1")).toThrow(/confirmation/);
  });

  it("matches by normalized confirmation number and leaves the uncertain for a person", () => {
    const p = parseCommissionStatement(csv);
    const m = matchStatementRows(p.rows, [
      { receivableId: "a", confirmationRef: "ca 55812", currency: "USD" },
      { receivableId: "b", confirmationRef: "HT-9", currency: "USD" },
    ]);
    expect(m[0]).toEqual({ rowNo: 2, status: "matched", receivableId: "a" });
    expect(m[1]).toMatchObject({ status: "unmatched", reason: expect.stringContaining("No receivable") });
    expect(m[2]).toMatchObject({ status: "unmatched", reason: expect.stringContaining("FX") });
  });
});

describe("allocation", () => {
  it("always sums exactly to the net (largest remainder)", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 500; n++) {
      const k = 1 + Math.floor(rand() * 5);
      const cuts = Array.from({ length: k - 1 }, () => Math.floor(rand() * 10_001)).sort((a, b) => a - b);
      const bps = [...cuts, 10_000].map((c, i) => c - (i ? cuts[i - 1]! : 0));
      const net = Math.floor(rand() * 10_000_000);
      const parts = allocateNet(net, bps.map((b, i) => ({ recipientId: `p${i}`, bps: b })));
      expect(parts.reduce((s, p) => s + p.amountMinor, 0)).toBe(net);
      parts.forEach((p, i) => expect(Math.abs(p.amountMinor - (net * bps[i]!) / 10_000)).toBeLessThan(1));
    }
    expect(allocateNet(100, [{ recipientId: "a", bps: 3333 }, { recipientId: "b", bps: 3333 }, { recipientId: "c", bps: 3334 }])).toEqual([
      { recipientId: "a", amountMinor: 33 },
      { recipientId: "b", amountMinor: 33 },
      { recipientId: "c", amountMinor: 34 },
    ]);
  });

  it("re-allocates a changed net per the loss bearer, summing exactly", () => {
    const shares = [{ recipientId: "ws", bps: 7000 }, { recipientId: "lena", bps: 3000 }];
    const allocated = new Map([["ws", 7000], ["lena", 3000]]);
    const pro = reallocationDelta(allocated, 9_001, { shares, reversalLossBearer: "pro_rata" }, "ws");
    expect(pro.reduce((s, d) => s + d.amountMinor, 0)).toBe(-999);
    expect(pro.find((d) => d.recipientId === "lena")!.amountMinor).toBe(-300);
    expect(reallocationDelta(allocated, 9_000, { shares, reversalLossBearer: "owner_workspace" }, "ws")).toEqual([{ recipientId: "ws", amountMinor: -1_000 }]);
    // Increases are always shared.
    expect(reallocationDelta(allocated, 11_000, { shares, reversalLossBearer: "owner_workspace" }, "ws")).toEqual([
      { recipientId: "ws", amountMinor: 700 },
      { recipientId: "lena", amountMinor: 300 },
    ]);
    expect(reallocationDelta(allocated, 10_000, { shares, reversalLossBearer: "pro_rata" }, "ws")).toEqual([]);
  });

  it("builds split terms from collaboration fee lines; fixed fees are separate lines", () => {
    const t = splitFromFeeLines(
      "item1",
      [
        { kind: "commission_split", amount: null, commissionShareBps: 2500, bookingItemIds: ["item1", "item2"], recipientId: "spec" },
        { kind: "design", amount: { amountMinor: 50_000, currency: "USD" }, commissionShareBps: null, bookingItemIds: ["item1", "item2"], recipientId: "spec" },
        { kind: "referral", amount: { amountMinor: 10_000, currency: "USD" }, commissionShareBps: null, bookingItemIds: ["item2"], recipientId: "ref" },
      ],
      "ws",
    );
    expect(t.shares).toEqual([{ recipientId: "spec", bps: 2500 }, { recipientId: "ws", bps: 7500 }]);
    expect(t.fees).toEqual([{ recipientId: "spec", kind: "design", amountMinor: 50_000, currency: "USD" }]);
  });

  it("split terms need 100% and both hosts' permission when commission leaves the workspace", () => {
    const terms: SplitTerms = {
      id: "s", itemId: "i", status: "draft", reversalLossBearer: "pro_rata", hostRulesOurs: "permitted", hostRulesTheirs: "unknown",
      shares: [{ recipientId: "ws", bps: 8000 }, { recipientId: "x", bps: 2000 }], fees: [],
    };
    expect(() => assertSplitAgreeable(terms, "ws")).toThrow(/host agreements/);
    expect(() => assertSplitAgreeable({ ...terms, hostRulesTheirs: "permitted" }, "ws")).not.toThrow();
    expect(() => assertSplitAgreeable({ ...terms, shares: [{ recipientId: "ws", bps: 10_000 }] }, "ws")).not.toThrow();
    expect(() => assertSplitAgreeable({ ...terms, hostRulesTheirs: "permitted", shares: [{ recipientId: "ws", bps: 9000 }] }, "ws")).toThrow(/100%/);
  });
});

describe("payouts", () => {
  const onboarded = { stripeAccountId: "acct_1", payoutsEnabled: true };
  it("transfers only on a funded path to an onboarded payee; otherwise instructs", () => {
    expect(lineMethod({ kind: "commission_share", amountMinor: 100, receiptsLandedIn: ["platform_balance"], recipient: onboarded })).toBe("platform_transfer");
    expect(lineMethod({ kind: "commission_share", amountMinor: 100, receiptsLandedIn: ["platform_balance", "external_account"], recipient: onboarded })).toBe("settlement_instruction");
    expect(lineMethod({ kind: "commission_share", amountMinor: 100, receiptsLandedIn: ["platform_balance"], recipient: { stripeAccountId: "acct_1", payoutsEnabled: false } })).toBe("settlement_instruction");
    expect(lineMethod({ kind: "commission_share", amountMinor: 100, receiptsLandedIn: [], recipient: onboarded })).toBe("settlement_instruction");
    expect(lineMethod({ kind: "referral", amountMinor: 100, receiptsLandedIn: [], recipient: onboarded })).toBe("settlement_instruction");
    expect(lineMethod({ kind: "commission_adjustment", amountMinor: -100, receiptsLandedIn: ["platform_balance"], recipient: onboarded })).toBe("settlement_instruction");
  });

  it("only an owner approves a batch, and only a non-empty draft", () => {
    expect(() => assertCanApproveBatch("assistant", { status: "draft", lineCount: 1 })).toThrow(/owner/);
    expect(() => assertCanApproveBatch("advisor", { status: "draft", lineCount: 1 })).toThrow(/owner/);
    expect(() => assertCanApproveBatch("owner", { status: "approved", lineCount: 1 })).toThrow(/draft/);
    expect(() => assertCanApproveBatch("owner", { status: "draft", lineCount: 0 })).toThrow(/nothing/);
    expect(() => assertCanApproveBatch("owner", { status: "draft", lineCount: 2 })).not.toThrow();
  });

  it("instructions say exactly what to send to whom", () => {
    const text = settlementInstructionText({
      payer: { name: "Marisol Vega Travel", email: "m@example.com" },
      payee: { name: "Lena Brandt", email: "lena@example.com" },
      amountMinor: 20_160,
      currency: "USD",
      reference: "ATP-ABC",
      purpose: "Commission share — Casa Alma",
      payeeDetails: "IBAN DE00 0000",
    });
    expect(text).toContain("$201.60");
    expect(text).toContain("To: Lena Brandt <lena@example.com>");
    expect(text).toContain("Reference: ATP-ABC");
    expect(text).toContain("IBAN DE00 0000");
  });
});

describe("reports", () => {
  it("keeps supplier delays apart from advisor delays", () => {
    const d = paymentDelays(
      {
        receivables: [
          { supplierName: "Casa Alma", expectedBy: "2026-09-01", firstReceivedAt: "2026-09-21T00:00:00Z" },
          { supplierName: "Casa Alma", expectedBy: "2026-09-25", firstReceivedAt: null },
          { supplierName: "Hacienda", expectedBy: "2026-12-01", firstReceivedAt: null },
        ],
        instructions: [
          { payerName: "Marisol Vega Travel", issuedAt: "2026-09-01T00:00:00Z", settledAt: "2026-09-05T00:00:00Z", status: "settled" },
          { payerName: "Marisol Vega Travel", issuedAt: "2026-09-01T00:00:00Z", settledAt: null, status: "issued" },
        ],
      },
      NOW,
    );
    expect(d.suppliers).toEqual([{ party: "Casa Alma", count: 2, late: 2, avgDaysLate: 13, maxDaysLate: 20, stillOpen: 1 }]);
    expect(d.advisors).toEqual([{ party: "Marisol Vega Travel", count: 2, late: 1, avgDaysLate: 11.5, maxDaysLate: 23, stillOpen: 1 }]);
  });

  it("earnings split settled from pending; host deductions summarize per host", () => {
    const e = earnings([
      { recipientId: "a", recipientName: "Lena", status: "settled", amountMinor: 1000, reversedMinor: 200, currency: "USD" },
      { recipientId: "a", recipientName: "Lena", status: "instructed", amountMinor: 500, reversedMinor: 0, currency: "USD" },
      { recipientId: "w", recipientName: "Workspace", status: "retained", amountMinor: 4000, reversedMinor: 0, currency: "USD" },
      { recipientId: "a", recipientName: "Lena", status: "canceled", amountMinor: 999, reversedMinor: 0, currency: "USD" },
    ]);
    expect(e.find((x) => x.recipientId === "a")).toMatchObject({ settledMinor: 800, pendingMinor: 500, reversedMinor: 200 });
    expect(e.find((x) => x.recipientId === "w")).toMatchObject({ retainedMinor: 4000 });
    const h = hostDeductions([
      { receivable: { ...r, tripId: "t", tripTitle: "T", supplierName: "S", hostAgency: "Host A" }, events: [ev("received", 10_000), ev("host_deduction", -1_000)] },
    ]);
    expect(h).toEqual([{ hostAgency: "Host A", currency: "USD", deductedMinor: 1_000, receivedMinor: 10_000, count: 1, effectiveBps: 1_000 }]);
  });
});

describe("stripe adapter", () => {
  it("form-encodes nested objects and arrays the way Stripe expects", () => {
    expect(formEncode({ a: 1, b: { c: "x y", d: [1, 2] }, skip: null, e: true })).toBe("a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5B0%5D=1&b%5Bd%5D%5B1%5D=2&e=true");
  });

  it("sends bearer auth, form bodies and an idempotency key on every POST", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ id: "tr_1", amount: 20_160, amount_reversed: 0, currency: "usd", destination: "acct_1", reversed: false, transfer_group: "line_x", metadata: {} }), { status: 200 });
    };
    const stripe = new StripeClient("sk_test_123", { fetch: fake });
    await stripe.createTransfer({ amountMinor: 20_160, currency: "USD", destination: "acct_1", transferGroup: "line_x", metadata: { payout_line_id: "x" } }, "payout-line-x");
    const c = calls[0]!;
    const h = c.init.headers as Record<string, string>;
    expect(c.url).toBe("https://api.stripe.com/v1/transfers");
    expect(c.init.method).toBe("POST");
    expect(h.Authorization).toBe("Bearer sk_test_123");
    expect(h["Idempotency-Key"]).toBe("payout-line-x");
    expect(h["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(String(c.init.body)).get("metadata[payout_line_id]")).toBe("x");
    expect(new URLSearchParams(String(c.init.body)).get("currency")).toBe("usd");

    await stripe.createSetupCheckoutSession({ customer: "cus_1", successUrl: "https://x/s", cancelUrl: "https://x/c", metadata: { client_id: "c1" } }, "card-setup-1");
    const body = new URLSearchParams(String(calls[1]!.init.body));
    expect(body.get("mode")).toBe("setup");
    expect(body.get("payment_method_types[0]")).toBe("card");
    expect(body.get("setup_intent_data[metadata][client_id]")).toBe("c1");

    await stripe.retrieveAccount("acct_1");
    expect(calls[2]!.init.method).toBe("GET");
    expect((calls[2]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("classifies errors: card/invalid requests are final, network and 5xx are retryable", async () => {
    const bad = new StripeClient("sk", { fetch: async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "balance_insufficient", message: "Insufficient funds" } }), { status: 400 }) });
    const err = await bad.createTransfer({ amountMinor: 1, currency: "usd", destination: "a", transferGroup: "g", metadata: {} }, "k").catch((e) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err).toMatchObject({ status: 400, code: "balance_insufficient", retryable: false });
    const down = new StripeClient("sk", { fetch: async () => { throw new Error("ECONNRESET"); } });
    const e2 = await down.retrieveAccount("a").catch((e) => e);
    expect(e2).toMatchObject({ status: 0, retryable: true });
  });

  it("verifies webhook signatures: valid, wrong secret, tampered, stale, malformed", () => {
    const body = JSON.stringify({ id: "evt_1", type: "account.updated" });
    const header = signStripePayload(body, "whsec_test", NOW);
    expect(verifyStripeSignature(body, header, "whsec_test", NOW)).toEqual({ ok: true });
    expect(verifyStripeSignature(body, header, "whsec_other", NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(body + " ", header, "whsec_test", NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(body, header, "whsec_test", new Date(NOW.getTime() + 301_000))).toEqual({ ok: false, reason: "stale" });
    expect(verifyStripeSignature(body, "garbage", "whsec_test", NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyStripeSignature(body, null, "whsec_test", NOW)).toEqual({ ok: false, reason: "missing" });
    // Several v1 signatures (secret rotation): any match passes.
    const t = header.split(",")[0]!;
    expect(verifyStripeSignature(body, `${t},v1=${"0".repeat(64)},${header.split(",")[1]}`, "whsec_test", NOW)).toEqual({ ok: true });
  });
});
