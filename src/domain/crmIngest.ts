/**
 * Rules for filling the CRM from email and calendar history without manual
 * entry, and for turning a parsed inbound message into suggestions. Nothing
 * here applies anything: it decides what to *suggest*, and a member accepts.
 */
import { transitionItem, type ItemState, type Perk, type TripItem } from "./bookings";
import { DomainError, type Id } from "./common";
import { currentRole, type Nudge, type Person } from "./crm";

// ---------------------------------------------------------------------------
// Addresses

export interface Address {
  name: string | null;
  email: string;
}

export const normalizeAddress = (e: string): string => e.trim().toLowerCase();

const EMAIL_IN = /<?([^\s<>"',;@]+@[^\s<>"',;@]+)>?/;

/** Parses one RFC 5322-ish mailbox: `Name <a@b.c>`, `"Last, First" <a@b.c>` or `a@b.c`. */
export function parseAddress(raw: string): Address | null {
  const m = EMAIL_IN.exec(raw);
  if (!m) return null;
  const email = normalizeAddress(m[1]!);
  const before = raw.slice(0, m.index).trim().replace(/^"(.*)"$/, "$1").trim();
  return { name: before && !before.includes("@") ? before : null, email };
}

/** Splits an address list on commas outside quotes and angle brackets. */
export function parseAddressList(raw: string | null | undefined): Address[] {
  if (!raw) return [];
  const parts: string[] = [];
  let buf = "";
  let quoted = false;
  let angle = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<") angle = true;
    else if (ch === ">") angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => parseAddress(p)).filter((a): a is Address => a !== null);
}

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "web.de", "hey.com", "fastmail.com", "zoho.com",
]);

// Second-level public suffixes, so "hotel.co.uk" yields "Hotel", not "Co".
const SLD = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "gob", "gouv", "ne", "or"]);

/**
 * Best-effort organization from an email domain. Freemail yields null. A
 * signature in the message body (parsed by the inbound agent) beats this.
 */
export function organizationFromDomain(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain || FREEMAIL.has(domain)) return null;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  let i = labels.length - 2;
  if (i > 0 && SLD.has(labels[i]!) && labels[labels.length - 1]!.length === 2) i--;
  const label = labels[i]!;
  return label
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|newsletter|news|marketing|info|support|billing|receipts?|calendar-notification|updates?)([+._-]|$)/i;
const AUTOMATED_DOMAIN = /(^|\.)(mailchimp|sendgrid|mandrillapp|amazonses|mcsv|list-manage|hubspot|salesforce|zendesk|intercom|calendar\.google|resource\.calendar\.google)\./i;

/** Addresses that are not people: no-reply senders, mailing systems, calendar resources. */
export function isAutomatedAddress(email: string): boolean {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  return AUTOMATED_LOCAL.test(local) || AUTOMATED_DOMAIN.test(domain) || domain.endsWith("resource.calendar.google.com");
}

/** "Rafael Montes" from "rafael.montes@x" when no display name was given. */
export function nameFromAddress(a: Address): string {
  if (a.name) return a.name;
  const local = a.email.split("@")[0] ?? a.email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Matching people

export interface KnownPerson {
  id: Id;
  name: string;
  emails: readonly string[];
}

/** Email match wins; an exact (case-insensitive) name match is offered as a merge. */
export function matchPerson(people: readonly KnownPerson[], a: Address): { person: KnownPerson; by: "email" | "name" } | null {
  const byEmail = people.find((p) => p.emails.some((e) => normalizeAddress(e) === a.email));
  if (byEmail) return { person: byEmail, by: "email" };
  if (a.name) {
    const n = a.name.trim().toLowerCase();
    const byName = people.find((p) => p.name.trim().toLowerCase() === n);
    if (byName) return { person: byName, by: "name" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Google import: relationship candidates from history

export interface ContactAggregate {
  email: string;
  name: string | null;
  organization: string | null;
  firstTouch: string;
  lastTouch: string;
  sentCount: number;
  receivedCount: number;
  meetingCount: number;
}

/**
 * Someone is a relationship candidate when there is two-way contact or a
 * meeting: we wrote to them and they wrote back, or we met. One-way inbound
 * mail (newsletters, cold pitches) is not a relationship.
 */
export function isRelationshipCandidate(c: ContactAggregate): boolean {
  if (isAutomatedAddress(c.email)) return false;
  if (c.meetingCount > 0) return true;
  return c.sentCount >= 1 && c.receivedCount >= 1 && c.sentCount + c.receivedCount >= 2;
}

// ---------------------------------------------------------------------------
// Inbound messages

export type InboundClass = "supplier_confirmation" | "supplier_commitment" | "client_message" | "other";

export interface ParsedPerk {
  name: string;
  basis: "guaranteed" | "requested";
}

export interface ParsedConfirmation {
  supplier: string | null;
  confirmationNumber: string | null;
  startsOn: string | null;
  endsOn: string | null;
  service: string | null;
  priceMinor: number | null;
  currency: string | null;
  perks: ParsedPerk[];
  cancellationTerms: string | null;
}

export interface ParsedInbound {
  classification: InboundClass;
  confidence: number;
  summary: string;
  sender: { name: string | null; organization: string | null; title: string | null; email: string | null };
  confirmation: ParsedConfirmation | null;
  commitments: { promise: string; conditions: string | null; dueBy: string | null; consequential: boolean }[];
}

export interface CandidateItem {
  id: Id;
  tripId: Id;
  tripTitle: string;
  title: string;
  supplierName: string | null;
  state: ItemState;
  startsAt: string | null;
  confirmationRef: string | null;
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !["the", "hotel", "and", "resort", "casa", "via"].includes(w)),
  );

/** States where a supplier's written confirmation can be attached. */
export const CONFIRMABLE_STATES: readonly ItemState[] = ["booking", "outcome_unknown", "confirmed"];

/**
 * Rank trip items a confirmation might belong to: supplier-name overlap and
 * start date agreement. Only items in a confirmable state are offered.
 */
export function rankItemsForConfirmation(c: ParsedConfirmation, items: readonly CandidateItem[]): { itemId: Id; score: number; label: string }[] {
  const supplierWords = words(c.supplier ?? "");
  return items
    .filter((it) => CONFIRMABLE_STATES.includes(it.state))
    .map((it) => {
      let score = 0;
      const itemWords = words(`${it.supplierName ?? ""} ${it.title}`);
      for (const w of supplierWords) if (itemWords.has(w)) score += 2;
      if (c.startsOn && it.startsAt && it.startsAt.slice(0, 10) === c.startsOn.slice(0, 10)) score += 3;
      if (c.confirmationNumber && it.confirmationRef === c.confirmationNumber) score += 5;
      if (it.state === "outcome_unknown" || it.state === "booking") score += 1;
      return { itemId: it.id, score, label: `${it.tripTitle} · ${it.title} (${it.state.replace("_", " ")})` };
    })
    .filter((r) => r.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * Attach a supplier confirmation to an item. Booking and outcome-unknown move
 * to confirmed through the item state machine; a confirmed item just gains the
 * reference. Any other state is refused: a confirmation for something we never
 * sent needs a person to look at it.
 */
export function attachConfirmation(item: TripItem, confirmationNumber: string): TripItem {
  const ref = confirmationNumber.trim();
  if (!ref) throw new DomainError("bad_confirmation", "Confirmation number is empty");
  if (item.state === "booking" || item.state === "outcome_unknown") return { ...transitionItem(item, "confirmed"), confirmationRef: ref };
  if (item.state === "confirmed") {
    if (item.confirmationRef && item.confirmationRef !== ref) {
      throw new DomainError("confirmation_mismatch", `Item already confirmed as ${item.confirmationRef}; this email says ${ref}. Check with the supplier.`);
    }
    return { ...item, confirmationRef: ref };
  }
  throw new DomainError("not_confirmable", `Item is ${item.state.replace("_", " ")}; only items being booked or already confirmed can take a confirmation`);
}

/**
 * Compare what the supplier confirmed against the perks we promised. A perk we
 * hold as guaranteed that the supplier lists only as requested (or not at all)
 * is flagged, so nobody overstates it to the traveler.
 */
export function perkDiscrepancies(promised: readonly Perk[], confirmed: readonly ParsedPerk[]): string[] {
  const out: string[] = [];
  const key = (s: string) => [...words(s)].sort().join(" ");
  for (const p of promised) {
    if (p.basis !== "guaranteed") continue;
    const match = confirmed.find((c) => {
      const a = words(c.name);
      return [...words(p.name)].some((w) => a.has(w));
    });
    if (!match) out.push(`${p.name}: promised as guaranteed, not mentioned in the confirmation`);
    else if (match.basis === "requested") out.push(`${p.name}: promised as guaranteed, supplier lists it as requested`);
  }
  for (const c of confirmed) {
    if (c.basis === "guaranteed" && !promised.some((p) => key(p.name) === key(c.name) || [...words(p.name)].some((w) => words(c.name).has(w)))) {
      out.push(`${c.name}: confirmed by the supplier but not on our booking record`);
    }
  }
  return out;
}

/** Major units from the parser → integer minor units. Zero-decimal currencies stay whole. */
export function toMinorUnits(amount: number | null, currency: string | null): number | null {
  if (amount === null || !Number.isFinite(amount) || amount < 0) return null;
  const zeroDecimal = ["JPY", "KRW", "VND", "CLP", "ISK", "XOF", "XAF", "XPF"].includes((currency ?? "").toUpperCase());
  return Math.round(zeroDecimal ? amount : amount * 100);
}

export type SuggestionKind = "attach_confirmation" | "file_commitment" | "upsert_person" | "log_touch";

export interface SuggestionDraft {
  kind: SuggestionKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * What to suggest for an inbound message. Members' own addresses (someone
 * forwarding a message) are never turned into CRM people; the forwarded
 * sender is used when the parser found one.
 */
export function inboundSuggestions(input: {
  messageId: Id;
  sender: Address;
  receivedAt: string;
  subject: string;
  parsed: ParsedInbound | null;
  memberEmails: readonly string[];
  people: readonly KnownPerson[];
  items: readonly CandidateItem[];
}): SuggestionDraft[] {
  const out: SuggestionDraft[] = [];
  const { parsed } = input;
  const isMemberAddress = (e: string) => input.memberEmails.some((m) => normalizeAddress(m) === normalizeAddress(e));
  // A member forwarding a supplier's email: the supplier (found by the parser) is the sender that matters.
  const sender: Address =
    isMemberAddress(input.sender.email) && parsed?.sender.email ? { email: parsed.sender.email, name: parsed.sender.name } : input.sender;
  const cls = parsed?.classification ?? null;
  const conf = parsed?.confirmation ?? null;

  if (cls === "supplier_confirmation" && conf?.confirmationNumber) {
    out.push({
      kind: "attach_confirmation",
      dedupeKey: `in:${input.messageId}:confirmation`,
      payload: { confirmation: conf, candidates: rankItemsForConfirmation(conf, input.items) },
    });
  }
  if ((cls === "supplier_commitment" || cls === "supplier_confirmation") && parsed) {
    parsed.commitments.forEach((c, i) => {
      out.push({
        kind: "file_commitment",
        dedupeKey: `in:${input.messageId}:commitment:${i}`,
        payload: { ...c, promisor: parsed.sender.name ?? sender.name ?? sender.email, candidates: conf ? rankItemsForConfirmation(conf, input.items) : [] },
      });
    });
  }

  const isMember = isMemberAddress(sender.email);
  const isSupplierSide = cls === null || cls === "supplier_confirmation" || cls === "supplier_commitment";
  if (!isMember && !isAutomatedAddress(sender.email) && isSupplierSide) {
    const match = matchPerson(input.people, sender);
    if (!match || match.by === "name") {
      out.push({
        kind: "upsert_person",
        dedupeKey: `in:${input.messageId}:person`,
        payload: {
          email: sender.email,
          name: parsed?.sender.name ?? nameFromAddress(sender),
          organization: parsed?.sender.organization ?? organizationFromDomain(sender.email),
          title: parsed?.sender.title ?? null,
          mergeIntoPersonId: match?.person.id ?? null,
          mergeIntoName: match?.person.name ?? null,
        },
      });
    }
    out.push({
      kind: "log_touch",
      dedupeKey: `in:${input.messageId}:touch`,
      payload: {
        personId: match?.by === "email" ? match.person.id : null,
        email: sender.email,
        at: input.receivedAt,
        note: `Email: ${input.subject}`.slice(0, 200),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Moves

/** A recent move is a new door: nudge the owner to reach out. */
export function moveNudge(person: Person, now: Date, withinDays = 60): Nudge | null {
  const role = currentRole(person);
  const prev = person.roles.filter((r) => r.to !== null).sort((a, b) => (a.to! < b.to! ? 1 : -1))[0];
  if (!role || !prev) return null;
  if (now.getTime() - new Date(role.from).getTime() > withinDays * 86_400_000) return null;
  return {
    personId: person.id,
    kind: "moved_role",
    message: `${person.name} moved to ${role.title} at ${role.organization}: a new door. Send a note.`,
  };
}
