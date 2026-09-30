import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { getItem } from "@/db/repo";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import { attachConfirmation, inboundSuggestions, perkDiscrepancies } from "@/domain/crmIngest";
import { drain, enqueue } from "@/server/jobs/queue";
import { MemoryStore } from "@/server/storage";
import { createHandlers } from "@/modules/crm/jobs";
import { acceptSuggestion, ensureInboundRoute, getInbound, handleInboundWebhook, listSuggestions, routeTokens } from "@/modules/crm/inbound";
import { CRM_DEMO } from "@/modules/crm/seed";
import { getPerson, listLedger } from "@/modules/crm/people";
import { NOW, useDb } from "./helpers/db";
import { assistant, expert, fakeLLM, outsider, seedCrmData } from "./helpers/crm";

const getDb = useDb();
let db: Db;
let store: MemoryStore;
const SECRET = "inbound-test-secret";
const DOMAIN = "in.example.test";

beforeEach(async () => {
  db = getDb();
  store = new MemoryStore();
  await seedCrmData(db);
});

const address = `in+${CRM_DEMO.inboundToken}@${DOMAIN}`;
const body = [
  "Dear Marisol,",
  "Your private transfer is confirmed. Confirmation number VT-555.",
  "Pickup 15:30, Oaxaca airport. We will have a bilingual driver waiting with a sign.",
  "Total USD 180.00. Free cancellation until 48 hours before.",
  "Paola Díaz, Reservations, Valle Transportes",
].join("\n");

const payload = (over: Record<string, unknown> = {}) => ({
  From: "Paola Díaz <paola@valletransportes.example>",
  FromName: "Paola Díaz",
  To: `"Marisol Inbox" <${address}>`,
  Subject: "Transfer confirmed VT-555",
  MessageID: "<abc-555@valletransportes.example>",
  Date: "Tue, 29 Sep 2026 14:00:00 +0000",
  TextBody: body,
  HtmlBody: null,
  Attachments: [{ Name: "voucher.pdf", Content: Buffer.from("%PDF-1.4 voucher VT-555").toString("base64"), ContentType: "application/pdf" }],
  ...over,
});

const post = (p: unknown, auth: { basic?: string; query?: string } = {}) =>
  new Request(`https://app.example.test/api/webhooks/inbound-email${auth.query !== undefined ? `?secret=${encodeURIComponent(auth.query)}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth.basic !== undefined ? { authorization: `Basic ${Buffer.from(`postmark:${auth.basic}`).toString("base64")}` } : {}) },
    body: JSON.stringify(p),
  });

const deliver = (p: unknown, auth: { basic?: string; query?: string } = { basic: SECRET }) =>
  handleInboundWebhook(post(p, auth), { db, secret: SECRET, domain: DOMAIN, blobs: store, now: NOW });

const parsed = {
  classification: "supplier_confirmation",
  confidence: 0.95,
  summary: "Transfer confirmation VT-555",
  sender: { name: "Paola Díaz", organization: "Valle Transportes", title: "Reservations", email: null },
  confirmation: {
    supplier: "Valle Transportes",
    confirmation_number: "VT-555",
    starts_on: null,
    ends_on: null,
    service: "Private transfer",
    price_amount: 180,
    currency: "usd",
    perks: [],
    cancellation_terms: "Free cancellation until 48 hours before",
  },
  commitments: [
    { promise: "Bilingual driver waiting with a sign", conditions: null, due_by: null, consequential: false, quote: "bilingual driver waiting with a sign" },
    { promise: "Complimentary champagne", conditions: null, due_by: null, consequential: false, quote: "champagne on arrival" },
  ],
};

describe("inbound webhook", () => {
  it("rejects bad credentials and unknown addresses; dedupes by Message-ID", async () => {
    expect((await deliver(payload(), { basic: "wrong" })).status).toBe(401);
    expect((await deliver(payload(), { query: "wrong" })).status).toBe(401);
    expect((await deliver(payload(), {})).status).toBe(401);
    expect((await deliver(payload({ To: `in+ffffffffffffffff@${DOMAIN}` }))).status).toBe(404);
    expect((await deliver(payload({ To: `in+${CRM_DEMO.inboundToken}@elsewhere.example` }))).status).toBe(404);
    expect(
      (
        await handleInboundWebhook(post(payload(), { basic: SECRET }), { db, secret: undefined, domain: DOMAIN, blobs: store, now: NOW })
      ).status,
    ).toBe(503);

    // The right secret in the URL is refused too: it would end up in access logs.
    expect((await deliver(payload(), { query: SECRET })).status).toBe(401);
    const first = await deliver(payload(), { basic: SECRET });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "stored" });
    const second = await deliver(payload());
    expect(await second.json()).toMatchObject({ status: "duplicate" });

    const rows = await withSystem(db, (q) => q.query<{ subject_sealed: string; body_sealed: string; attachments: { key: string }[] }>("select * from inbound_messages where message_id = $1", ["<abc-555@valletransportes.example>"]));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.subject_sealed).not.toContain("VT-555");
    expect(rows.rows[0]!.body_sealed).not.toContain("bilingual");
    const blob = store.items.get(rows.rows[0]!.attachments[0]!.key)!;
    expect(blob.toString()).not.toContain("voucher");
    const jobs = await withSystem(db, (q) => q.query<{ kind: string; member_id: string }>("select kind, member_id from jobs where kind = 'crm.parse_inbound'"));
    expect(jobs.rows).toEqual([{ kind: "crm.parse_inbound", member_id: DEMO.expert }]);
    // Arrival is logged; nothing else is applied.
    const audits = await withSystem(db, (q) => q.query("select 1 from audit_events where action = 'inbound.received'"));
    expect(audits.rows).toHaveLength(1);
  });

  it("finds the route in any recipient and files forwarded mail for the forwarding member", async () => {
    expect(routeTokens({ ...payload(), To: "someone@x.example", Cc: `Box <${address}>` } as never, DOMAIN)).toEqual([CRM_DEMO.inboundToken]);
    const r = await deliver(payload({ From: "Lena Brandt <lena@example.com>", MessageID: "<fwd-1@example.com>" }));
    const { id } = (await r.json()) as { id: string };
    const owner = await withSystem(db, (q) => q.query<{ owner_id: string }>("select owner_id from inbound_messages where id = $1", [id]));
    expect(owner.rows[0]!.owner_id).toBe(DEMO.backup);
  });

  it("creates one inbound address per workspace", async () => {
    const a = await ensureInboundRoute(db, expert);
    const b = await ensureInboundRoute(db, assistant);
    expect(a.token).toBe(CRM_DEMO.inboundToken);
    expect(b.token).toBe(a.token);
    const other = await ensureInboundRoute(db, outsider);
    expect(other.token).not.toBe(a.token);
    expect(other.token).toMatch(/^[a-f0-9]{20}$/);
  });
});

describe("parsing and suggestions", () => {
  async function deliverAndParse(llm: ReturnType<typeof fakeLLM> | null) {
    const r = await deliver(payload());
    const { id } = (await r.json()) as { id: string };
    await drain(db, createHandlers({ llm: () => llm, now: () => NOW }));
    return id;
  }

  it("turns a confirmation into suggestions, applied only when a member accepts", async () => {
    const llm = fakeLLM(parsed);
    const id = await deliverAndParse(llm);
    const msg = await withTenant(db, expert, (q) => getInbound(q, expert, id));
    expect(msg).toMatchObject({ parseStatus: "parsed", classification: "supplier_confirmation", subject: "Transfer confirmed VT-555" });

    // Suggestions are built from the owner's own view, so they are the owner's alone.
    expect(await withTenant(db, assistant, (q) => listSuggestions(q, { messageId: id }))).toEqual([]);
    const sugg = await withTenant(db, expert, (q) => listSuggestions(q, { messageId: id }));
    expect(sugg.map((s) => s.kind).sort()).toEqual(["attach_confirmation", "file_commitment", "log_touch", "upsert_person"]);
    const attach = sugg.find((s) => s.kind === "attach_confirmation")!;
    expect((attach.payload.confirmation as { priceMinor: number; currency: string })).toMatchObject({ priceMinor: 18_000, currency: "USD" });
    expect((attach.payload.candidates as { itemId: string }[])[0]!.itemId).toBe(DEMO.transfer);

    // Nothing changed yet.
    expect((await withTenant(db, expert, (q) => getItem(q, DEMO.transfer)))!.state).toBe("outcome_unknown");

    // Re-running the parse (a retry, or a duplicate job) creates nothing new.
    await withSystem(db, (q) => enqueue(q, { kind: "crm.parse_inbound", payload: { messageId: id }, tenant: expert, dedupeKey: "again" }));
    await drain(db, createHandlers({ llm: () => llm, now: () => NOW }));
    expect(await withTenant(db, expert, (q) => listSuggestions(q, { messageId: id }))).toHaveLength(4);
    expect(llm.calls).toBe(1);

    // The trip owner accepts the confirmation: outcome_unknown -> confirmed via the state machine, and the attempt resolves.
    await expect(acceptSuggestion(db, assistant, attach.id, { itemId: DEMO.transfer }, NOW)).rejects.toThrow(/not found/i);
    const r = await acceptSuggestion(db, expert, attach.id, { itemId: DEMO.transfer }, NOW);
    expect(r).toMatchObject({ from: "outcome_unknown", to: "confirmed" });
    const item = (await withTenant(db, expert, (q) => getItem(q, DEMO.transfer)))!;
    expect(item).toMatchObject({ state: "confirmed", confirmationRef: "VT-555" });
    const attempt = await withSystem(db, (q) => q.query<{ state: string; provider_ref: string }>("select state, provider_ref from execution_attempts where item_id = $1", [DEMO.transfer]));
    expect(attempt.rows[0]).toEqual({ state: "succeeded", provider_ref: "VT-555" });
    await expect(acceptSuggestion(db, expert, attach.id, { itemId: DEMO.transfer }, NOW)).rejects.toThrow(/already accepted/);

    // Person first, then the touch lands on them.
    const person = sugg.find((s) => s.kind === "upsert_person")!;
    const { personId } = (await acceptSuggestion(db, expert, person.id, {}, NOW)) as { personId: string };
    const p = await withTenant(db, expert, (q) => getPerson(q, expert, personId));
    expect(p).toMatchObject({ name: "Paola Díaz", emails: ["paola@valletransportes.example"], scope: "private", source: "inbound_email" });
    expect(p?.roles[0]).toMatchObject({ organization: "Valle Transportes", title: "Reservations" });
    const touch = sugg.find((s) => s.kind === "log_touch")!;
    await acceptSuggestion(db, expert, touch.id, {}, NOW);
    const ledger = await withTenant(db, expert, (q) => listLedger(q, personId));
    expect(ledger).toEqual([expect.objectContaining({ kind: "touch", source: "inbound_email" })]);

    // Only the commitment with a supporting quote was suggested; filing it records written evidence.
    const commitment = sugg.find((s) => s.kind === "file_commitment")!;
    expect(commitment.payload.promise).toBe("Bilingual driver waiting with a sign");
    const { commitmentId } = (await acceptSuggestion(db, expert, commitment.id, { itemId: DEMO.transfer }, NOW)) as { commitmentId: string };
    const c = await withSystem(db, (q) => q.query<{ evidence: string; promisor_person_id: string; trip_id: string }>("select * from commitments where id = $1", [commitmentId]));
    expect(c.rows[0]).toMatchObject({ evidence: "written_confirmation", promisor_person_id: personId, trip_id: DEMO.trip });

    // Another workspace sees none of it.
    expect(await withTenant(db, outsider, (q) => listSuggestions(q))).toHaveLength(0);
    expect((await withTenant(db, outsider, (q) => q.query("select * from inbound_messages"))).rows).toHaveLength(0);
  });

  it("refuses to confirm an item that was never sent", async () => {
    const dinner = (await withTenant(db, expert, (q) => getItem(q, DEMO.dinner)))!;
    expect(() => attachConfirmation(dinner, "X1")).toThrow(/only items being booked or already confirmed/);
    const hotel = (await withTenant(db, expert, (q) => getItem(q, DEMO.hotelCdmx)))!;
    expect(() => attachConfirmation(hotel, "OTHER-1")).toThrow(/already confirmed as CA-55812/);
    expect(attachConfirmation(hotel, "CA-55812").state).toBe("confirmed");
  });

  it("degrades to manual handling with no agent, keeping sender suggestions", async () => {
    const id = await deliverAndParse(null);
    const msg = await withTenant(db, expert, (q) => getInbound(q, expert, id));
    expect(msg?.parseStatus).toBe("manual");
    const kinds = (await withTenant(db, expert, (q) => listSuggestions(q, { messageId: id }))).map((s) => s.kind).sort();
    expect(kinds).toEqual(["log_touch", "upsert_person"]);
  });

  it("downgrades a confirmation whose number isn't in the email, and records refusals as failed", async () => {
    const id = await deliverAndParse(fakeLLM({ ...parsed, confirmation: { ...parsed.confirmation, confirmation_number: "ZZ-999" } }));
    const msg = await withTenant(db, expert, (q) => getInbound(q, expert, id));
    expect(msg?.classification).toBe("supplier_commitment");
    const kinds = (await withTenant(db, expert, (q) => listSuggestions(q, { messageId: id }))).map((s) => s.kind);
    expect(kinds).not.toContain("attach_confirmation");

    const r = await deliver(payload({ MessageID: "<refused@x>" }));
    const { id: id2 } = (await r.json()) as { id: string };
    await drain(db, createHandlers({ llm: () => fakeLLM({ ok: false, reason: "refused", detail: "no" }), now: () => NOW }));
    expect((await withTenant(db, expert, (q) => getInbound(q, expert, id2)))?.parseStatus).toBe("failed");
  });
});

describe("inbound rules", () => {
  it("flags perks the supplier lists only as requested", () => {
    expect(
      perkDiscrepancies(
        [
          { name: "Daily breakfast for two", basis: "guaranteed" },
          { name: "Room upgrade", basis: "availability_dependent" },
          { name: "USD 100 property credit", basis: "guaranteed" },
        ],
        [
          { name: "Breakfast daily", basis: "requested" },
          { name: "Upgrade", basis: "requested" },
        ],
      ),
    ).toEqual(["Daily breakfast for two: promised as guaranteed, supplier lists it as requested", "USD 100 property credit: promised as guaranteed, not mentioned in the confirmation"]);
  });

  it("uses the forwarded sender, never a member, as the CRM person", () => {
    const s = inboundSuggestions({
      messageId: "m",
      sender: { email: "marisol@example.com", name: "Marisol Vega" },
      receivedAt: NOW.toISOString(),
      subject: "Fwd: hold",
      parsed: { classification: "supplier_commitment", confidence: 0.9, summary: "", sender: { name: "Ana", organization: "Casa", title: null, email: "ana@casa.example" }, confirmation: null, commitments: [] },
      memberEmails: ["marisol@example.com"],
      people: [],
      items: [],
    });
    expect(s.find((x) => x.kind === "upsert_person")?.payload.email).toBe("ana@casa.example");
    const none = inboundSuggestions({
      messageId: "m",
      sender: { email: "marisol@example.com", name: "Marisol Vega" },
      receivedAt: NOW.toISOString(),
      subject: "note to self",
      parsed: null,
      memberEmails: ["marisol@example.com"],
      people: [],
      items: [],
    });
    expect(none).toEqual([]);
  });
});
