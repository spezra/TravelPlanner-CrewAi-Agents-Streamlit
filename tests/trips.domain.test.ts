import { describe, expect, it } from "vitest";
import { requestApproval } from "@/domain/approvals";
import type { TripItem } from "@/domain/bookings";
import { DomainError } from "@/domain/common";
import { portalItems, portalProposals } from "@/domain/portal";
import {
  decimalToMinor,
  formatAmount,
  isoToLocalInput,
  localInputToIso,
  materialChange,
  minorToDecimal,
  parseMoneyInput,
  requote,
  validateApprovalActions,
  withdrawApproval,
} from "@/domain/tripPlanning";
import { parseActions, parseItemForm, parseTermsForm, parseTravelers } from "@/modules/trips/forms";
import { providerForItem } from "@/modules/trips/providers";

const NOW = new Date("2026-10-01T12:00:00Z");

const item = (over: Partial<TripItem> = {}): TripItem => ({
  id: "00000000-0000-4000-8000-000000000e01",
  tripId: "00000000-0000-4000-8000-000000000d01",
  kind: "hotel",
  title: "Casa",
  supplierName: "Casa",
  state: "design",
  price: { amountMinor: 100_00, currency: "USD" },
  startsAt: "2027-01-01T15:00:00.000Z",
  endsAt: "2027-01-03T11:00:00.000Z",
  credentials: {
    bookingEntity: "IATA 1",
    permittedChannel: "Direct to property",
    program: "Preferred",
    rate: "BAR",
    perks: [
      { name: "Breakfast", basis: "guaranteed" },
      { name: "Upgrade", basis: "availability_dependent" },
    ],
    servicingOwner: "Marisol",
    servicingActions: ["cancel"],
    commissionRecipient: "Agency",
  },
  confirmationRef: null,
  ...over,
});

describe("money and time input", () => {
  it("parses amounts in the currency's precision", () => {
    expect(parseMoneyInput("1,234.5", "usd")).toEqual({ amountMinor: 123_450, currency: "USD" });
    expect(parseMoneyInput("15000", "JPY")).toEqual({ amountMinor: 15_000, currency: "JPY" });
    expect(() => parseMoneyInput("12.345", "USD")).toThrow(DomainError);
    expect(() => parseMoneyInput("-5", "USD")).toThrow(/not an amount/);
    expect(() => parseMoneyInput("5", "DOLLARS")).toThrow(/3-letter/);
    expect(minorToDecimal({ amountMinor: 5, currency: "USD" })).toBe("0.05");
    expect(minorToDecimal({ amountMinor: 1500, currency: "JPY" })).toBe("1500");
    expect(decimalToMinor("1840.00", "USD").amountMinor).toBe(184_000);
    expect(formatAmount({ amountMinor: 1500, currency: "JPY" })).toBe("¥1,500");
  });

  it("reads local times in the member's zone, across DST", () => {
    expect(localInputToIso("2026-10-04T15:30", "America/Mexico_City")).toBe("2026-10-04T21:30:00.000Z");
    expect(localInputToIso("2026-07-01T09:00", "Europe/Berlin")).toBe("2026-07-01T07:00:00.000Z");
    expect(localInputToIso("2026-12-01T09:00", "Europe/Berlin")).toBe("2026-12-01T08:00:00.000Z");
    expect(isoToLocalInput("2026-12-01T08:00:00.000Z", "Europe/Berlin")).toBe("2026-12-01T09:00");
    expect(() => localInputToIso("tomorrow", "UTC")).toThrow(DomainError);
  });
});

describe("items and approvals", () => {
  it("only booking-relevant fields are material", () => {
    expect(materialChange(item(), item({ title: "Casa, garden suite" }))).toBe(false);
    expect(materialChange(item(), item({ startsAt: "2027-01-01T15:00:00Z" }))).toBe(false);
    expect(materialChange(item(), item({ price: { amountMinor: 100_01, currency: "USD" } }))).toBe(true);
    expect(materialChange(item(), item({ credentials: { ...item().credentials!, rate: "Advance purchase" } }))).toBe(true);
  });

  it("validates approval actions against item states", () => {
    expect(() => validateApprovalActions([], [item()])).toThrow(/at least one/);
    expect(() => validateApprovalActions([{ kind: "book", itemId: item().id }], [item({ state: "confirmed" })])).toThrow(/can't be booked again/);
    expect(() => validateApprovalActions([{ kind: "cancel", itemId: item().id }], [item()])).toThrow(/cancel it directly/);
    expect(() => validateApprovalActions([{ kind: "book", itemId: "x" }], [item()])).toThrow(/not on this trip/);
    expect(() => validateApprovalActions([{ kind: "cancel", itemId: item().id }], [item({ state: "disrupted" })])).not.toThrow();
  });

  it("re-quotes open approvals only, with a live expiry", () => {
    const a = requestApproval({
      id: "a1",
      tripId: "t",
      actions: [{ kind: "book", itemId: "i" }],
      terms: { price: { amountMinor: 1, currency: "USD" }, offerExpiresAt: NOW.toISOString(), cancellationPolicy: "x", downstreamChanges: [], actor: "agent" },
      requestedBy: "m",
    });
    const t = { ...a.terms, offerExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() };
    const { withdrawn, fresh } = requote(a, { id: "a2", terms: t, requestedBy: "m2", now: NOW });
    expect(withdrawn.status).toBe("withdrawn");
    expect(fresh).toMatchObject({ id: "a2", status: "pending", actions: a.actions, requestedBy: "m2" });
    expect(() => requote(a, { id: "a3", terms: a.terms, requestedBy: "m", now: NOW })).toThrow(/past/);
    expect(() => requote(withdrawn, { id: "a3", terms: t, requestedBy: "m", now: NOW })).toThrow(/only open approvals/);
    expect(() => withdrawApproval(withdrawn, "x")).toThrow(DomainError);
  });

  it("routes items to rails by kind and channel", () => {
    expect(providerForItem(item())).toBe("manual");
    expect(providerForItem(item({ kind: "flight", credentials: { ...item().credentials!, permittedChannel: "Duffel" } }))).toBe("duffel");
    expect(() => providerForItem(item({ credentials: { ...item().credentials!, permittedChannel: "Duffel Stays" } }))).toThrow(/flights only/);
  });
});

describe("portal allow-list", () => {
  it("hides internal states, shows confirmation numbers only when confirmed, never overstates perks", () => {
    const view = portalItems([
      item({ id: "a", state: "design" }),
      item({ id: "b", state: "canceled" }),
      item({ id: "c", state: "confirmed", confirmationRef: "CONF1" }),
      item({ id: "d", state: "outcome_unknown", confirmationRef: "maybe" }),
    ]);
    expect(view.map((v) => v.id)).toEqual(["c", "d"]);
    expect(view[0]).toMatchObject({ status: "Confirmed", confirmationRef: "CONF1", perks: ["Breakfast", "Upgrade (requested; subject to availability at arrival)"], perksAreProposed: false });
    expect(view[1]).toMatchObject({ confirmationRef: null, perksAreProposed: true });
    expect(Object.keys(view[0]!).sort()).toEqual(["confirmationRef", "endsAt", "id", "kind", "perks", "perksAreProposed", "startsAt", "status", "title", "tone"]);
  });

  it("proposals carry price, expiry, cancellation and what else changes, but not who acts", () => {
    const a = requestApproval({
      id: "a1",
      tripId: "t",
      actions: [
        { kind: "book", itemId: "c" },
        { kind: "pay", itemId: "c" },
      ],
      terms: { price: { amountMinor: 5000, currency: "USD" }, offerExpiresAt: "2026-10-02T00:00:00Z", cancellationPolicy: "Free until 7 days", downstreamChanges: ["Pickup at 15:30"], actor: "Booking agent under IATA 1" },
      requestedBy: "m",
    });
    const [p] = portalProposals([a], [item({ id: "c", title: "Casa" })], [], NOW);
    expect(p).toEqual({
      approvalId: "a1",
      summary: ["Book Casa"],
      price: { amountMinor: 5000, currency: "USD" },
      offerExpiresAt: "2026-10-02T00:00:00Z",
      expired: false,
      cancellationPolicy: "Free until 7 days",
      alsoChanges: ["Pickup at 15:30"],
      clientAcceptance: null,
    });
    expect(portalProposals([{ ...a, status: "approved" }], [], [], NOW)).toEqual([]);
  });
});

describe("form parsing", () => {
  const fd = (entries: [string, string][]) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };

  it("parses the full credentials form", () => {
    const d = parseItemForm(
      fd([
        ["kind", "hotel"],
        ["title", "Casa"],
        ["price", "1,475.00"],
        ["currency", "usd"],
        ["startsAt", "2027-01-12T15:00"],
        ["bookingEntity", "IATA 1"],
        ["permittedChannel", "Direct to property"],
        ["program", "Preferred"],
        ["rate", "BAR"],
        ["perkName_0", "Breakfast"],
        ["perkBasis_0", "guaranteed"],
        ["perkName_3", "Late checkout"],
        ["perkBasis_3", "availability_dependent"],
        ["servicingOwner", "Marisol"],
        ["servicingActions", "cancel"],
        ["servicingActions", "bogus"],
        ["commissionRecipient", "Agency"],
      ]),
      "America/Mexico_City",
    );
    expect(d.price).toEqual({ amountMinor: 147_500, currency: "USD" });
    expect(d.startsAt).toBe("2027-01-12T21:00:00.000Z");
    expect(d.credentials).toMatchObject({ servicingActions: ["cancel"], perks: [{ name: "Breakfast", basis: "guaranteed" }, { name: "Late checkout", basis: "availability_dependent" }] });
    expect(parseItemForm(fd([["kind", "dining"], ["title", "Dinner"]]), "UTC").credentials).toBeNull();
    expect(() => parseItemForm(fd([["kind", "yacht"], ["title", "x"]]), "UTC")).toThrow(/Kind/);
  });

  it("parses approval actions, terms and travelers strictly", () => {
    const id = "00000000-0000-4000-8000-0000000000e1";
    expect(parseActions(fd([["actions", `book:${id}`], ["actions", `pay:${id}`]]))).toEqual([
      { kind: "book", itemId: id },
      { kind: "pay", itemId: id },
    ]);
    expect(() => parseActions(fd([["actions", `payout:${id}`]]))).toThrow(/Unknown action/);
    const t = parseTermsForm(
      fd([
        ["price", "200"],
        ["currency", "EUR"],
        ["offerExpiresAt", "2026-10-03T18:00"],
        ["cancellationPolicy", "Non-refundable"],
        ["downstreamChanges", "Transfer moves\n\n  Dinner moves  "],
        ["actor", "Agent"],
      ]),
      "UTC",
    );
    expect(t).toEqual({ price: { amountMinor: 20_000, currency: "EUR" }, offerExpiresAt: "2026-10-03T18:00:00.000Z", cancellationPolicy: "Non-refundable", downstreamChanges: ["Transfer moves", "Dinner moves"], actor: "Agent" });
    expect(() =>
      parseTravelers(
        fd([
          ["title_0", "mr"],
          ["given_name_0", "Tom"],
          ["family_name_0", "W"],
          ["gender_0", "m"],
          ["born_on_0", "1975-04-02"],
          ["email_0", "tom@example.com"],
          ["phone_0", "555-0101"],
        ]),
        1,
      ),
    ).toThrow(/international format/);
  });
});
