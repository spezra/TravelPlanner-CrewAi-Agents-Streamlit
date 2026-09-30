/**
 * Trip planning rules that sit around the item state machine: what can be
 * edited when, how an edit to a booking-relevant field lapses its approval,
 * re-quotes, and the parsing of money and local times entered by people.
 * Pure: callers pass `now` and time zones.
 */
import { requestApproval, type ActionSpec, type Approval, type MaterialTerms } from "./approvals";
import type { ItemState, TripItem } from "./bookings";
import { DomainError, stableStringify, type Id, type Money } from "./common";

// ---------------------------------------------------------------------------
// Money

/** Minor-unit digits for a currency (USD 2, JPY 0, BHD 3). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new DomainError("bad_currency", `Unknown currency ${currency}`);
  }
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/** Parses "1,234.50" in `currency` into integer minor units. Rejects negatives and excess precision. */
export function parseMoneyInput(text: string, currency: string): Money {
  const cur = currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(cur)) throw new DomainError("bad_currency", `Currency must be a 3-letter ISO code, got "${currency}"`);
  const digits = currencyDigits(cur);
  const cleaned = text.trim().replace(/[,\s]/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!m) throw new DomainError("bad_amount", `"${text}" is not an amount`);
  const frac = m[2] ?? "";
  if (frac.length > digits) throw new DomainError("bad_amount", `${cur} amounts have at most ${digits} decimal places`);
  const minor = Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(minor)) throw new DomainError("bad_amount", "Amount is too large");
  return { amountMinor: minor, currency: cur };
}

/** Decimal string for an amount, e.g. for provider APIs ("1234.50"). */
export function minorToDecimal(m: Money): string {
  const digits = currencyDigits(m.currency);
  if (digits === 0) return String(m.amountMinor);
  const s = String(Math.abs(m.amountMinor)).padStart(digits + 1, "0");
  return `${m.amountMinor < 0 ? "-" : ""}${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** Inverse of minorToDecimal, for provider amounts like "1234.5". */
export function decimalToMinor(amount: string, currency: string): Money {
  const neg = amount.trim().startsWith("-");
  const m = parseMoneyInput(neg ? amount.trim().slice(1) : amount, currency);
  return neg ? { ...m, amountMinor: -m.amountMinor } : m;
}

/** Display with the currency's own precision (formatMoney in common assumes two digits). */
export function formatAmount(m: Money): string {
  const digits = currencyDigits(m.currency);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
    m.amountMinor / 10 ** digits,
  );
}

// ---------------------------------------------------------------------------
// Local times

function zoneOffsetMinutes(utcMillis: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMillis));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - utcMillis) / 60_000);
}

/** "2026-10-04T15:30" entered by someone in `timeZone` -> ISO instant. */
export function localInputToIso(local: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) throw new DomainError("bad_datetime", `"${local}" is not a date and time`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes settle DST boundaries.
  let guess = naive - zoneOffsetMinutes(naive, timeZone) * 60_000;
  guess = naive - zoneOffsetMinutes(guess, timeZone) * 60_000;
  return new Date(guess).toISOString();
}

/** ISO instant -> value for an <input type="datetime-local"> in `timeZone`. */
export function isoToLocalInput(iso: string, timeZone: string): string {
  const t = new Date(iso).getTime();
  return new Date(t + zoneOffsetMinutes(t, timeZone) * 60_000).toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// Items

/** States in which the team may edit an item's details. Anything with the supplier is changed through servicing. */
export const EDITABLE_STATES: readonly ItemState[] = ["design", "proposed", "awaiting_approval", "approved", "failed"];

export function canEditItem(state: ItemState): boolean {
  return EDITABLE_STATES.includes(state);
}

/** States that can be canceled without contacting a supplier (nothing is held there). */
export const PRE_SUPPLIER_STATES: readonly ItemState[] = ["design", "proposed", "awaiting_approval", "approved", "failed"];

/** States whose cancellation needs the supplier, an approval and an execution attempt. */
export const SUPPLIER_HELD_STATES: readonly ItemState[] = ["confirmed", "disrupted"];

/**
 * Fields that are material to what was (or will be) approved. Changing any of
 * them after an approval was requested lapses it and returns the item to design.
 */
export function materialChange(before: TripItem, after: TripItem): boolean {
  const instant = (v: string | null) => (v ? new Date(v).getTime() : null);
  const pick = (i: TripItem) => ({
    price: i.price,
    startsAt: instant(i.startsAt),
    endsAt: instant(i.endsAt),
    supplierName: i.supplierName,
    kind: i.kind,
    credentials: i.credentials,
  });
  return stableStringify(pick(before)) !== stableStringify(pick(after));
}

// ---------------------------------------------------------------------------
// Approvals

export function approvalExpired(a: Approval, now: Date): boolean {
  return new Date(a.terms.offerExpiresAt) <= now;
}

/**
 * Withdraw an approval whose material terms no longer hold (item edited,
 * re-quoted, or superseded). A decided approval can lapse too: an approval
 * for a rate that no longer exists authorizes nothing.
 */
export function withdrawApproval(a: Approval, note: string): Approval {
  if (a.status !== "pending" && a.status !== "approved") {
    throw new DomainError("not_withdrawable", `Approval ${a.id} is ${a.status}`);
  }
  return { ...a, status: "withdrawn", note };
}

/** A re-quote replaces an expired or changed approval with fresh terms over the same actions. */
export function requote(old: Approval, input: { id: Id; terms: MaterialTerms; requestedBy: string; now: Date }): { withdrawn: Approval; fresh: Approval } {
  if (old.status !== "pending" && old.status !== "approved") {
    throw new DomainError("not_requotable", `Approval ${old.id} is ${old.status}; only open approvals can be re-quoted`);
  }
  if (new Date(input.terms.offerExpiresAt) <= input.now) {
    throw new DomainError("offer_expired", "The new offer expiry is already in the past");
  }
  const withdrawn = { ...old, status: "withdrawn" as const, note: `Re-quoted as ${input.id}` };
  const fresh = requestApproval({ id: input.id, tripId: old.tripId, actions: old.actions, terms: input.terms, requestedBy: input.requestedBy });
  return { withdrawn, fresh };
}

/** Validates the actions an approval request may cover, given the items' current states. */
export function validateApprovalActions(actions: readonly ActionSpec[], items: readonly TripItem[]): void {
  if (actions.length === 0) throw new DomainError("empty_approval", "Choose at least one action to approve");
  const seen = new Set<string>();
  for (const a of actions) {
    const key = `${a.kind}:${a.itemId}`;
    if (seen.has(key)) throw new DomainError("duplicate_action", "An action appears twice");
    seen.add(key);
    const item = items.find((i) => i.id === a.itemId);
    if (!item) throw new DomainError("not_found", `Item ${a.itemId} is not on this trip`);
    if (a.kind === "book" || a.kind === "pay") {
      if (!["design", "proposed", "awaiting_approval", "approved", "failed"].includes(item.state)) {
        throw new DomainError("bad_action", `${item.title} is ${item.state.replace(/_/g, " ")}; it can't be booked again`);
      }
    } else if (a.kind === "cancel" || a.kind === "modify") {
      if (!SUPPLIER_HELD_STATES.includes(item.state)) {
        throw new DomainError("bad_action", `${item.title} isn't held with a supplier; cancel it directly instead`);
      }
    }
  }
}

/** The state an item should move to when a book approval is requested for it, if any. */
export function stateOnApprovalRequest(item: TripItem, action: ActionSpec): ItemState | null {
  if (action.kind !== "book") return null;
  if (item.state === "awaiting_approval") return null;
  if (item.state === "failed" || item.state === "design" || item.state === "proposed" || item.state === "approved") return "awaiting_approval";
  return null;
}
