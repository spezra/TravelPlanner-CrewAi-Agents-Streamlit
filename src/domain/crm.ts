/**
 * Relationship CRM: memory and conscience for the people who hold
 * relationships. It helps humans relate better; it never relates on their
 * behalf. People, not properties: the core record is the person plus their
 * role history, so when a contact moves properties the relationship follows.
 */
import type { Id } from "./common";

export interface RoleStint {
  organization: string;
  propertyId: Id | null;
  title: string;
  /** What they're measured on, e.g. "occupancy and reviews". Good asks help them hit their number. */
  measuredOn: string | null;
  from: string;
  to: string | null;
}

export interface Person {
  id: Id;
  ownerId: Id; // which human holds the relationship; asks route through them
  name: string;
  roles: RoleStint[];
  approach: {
    channel: string | null;
    timeZone: string | null;
    language: string | null;
    boss: string | null;
    goingOverTheirHeadAcceptable: boolean;
  };
  /** The owner's own notes ("dry humor, hates being rushed"). */
  texture: string[];
  clientIds: Id[];
}

export const currentRole = (p: Person): RoleStint | null => p.roles.find((r) => r.to === null) ?? null;

export type LedgerEntryKind =
  | "favor_asked"
  | "favor_granted"
  | "favor_declined"
  | "business_sent"
  | "recognition_given" // named in a review, a note to their boss
  | "touch"; // a note, a call, a gift, no ask

export interface LedgerEntry {
  id: Id;
  personId: Id;
  kind: LedgerEntryKind;
  at: string;
  note: string;
  /** For favors: what kind of ask, e.g. "upgrade", "late_checkout", "sold_out_table". */
  askType: string | null;
  roomNights: number | null;
  revenueMinor: number | null;
}

/**
 * Warmth shows as evidence, not an opaque score.
 */
export function warmthEvidence(entries: readonly LedgerEntry[], now: Date, windowDays = 365) {
  const since = now.getTime() - windowDays * 86_400_000;
  const recent = entries.filter((e) => new Date(e.at).getTime() >= since);
  const count = (k: LedgerEntryKind) => recent.filter((e) => e.kind === k).length;
  const lastTouch = entries.reduce<string | null>((acc, e) => (acc === null || e.at > acc ? e.at : acc), null);
  const given = count("business_sent") + count("recognition_given");
  const asked = count("favor_asked");
  return {
    lastTouch,
    favorsAsked: asked,
    favorsGranted: count("favor_granted"),
    favorsDeclined: count("favor_declined"),
    businessSent: count("business_sent"),
    roomNights: recent.reduce((s, e) => s + (e.roomNights ?? 0), 0),
    recognitionGiven: count("recognition_given"),
    /** Positive = we have given more than we have asked for. */
    balance: given - asked,
  };
}

export type ChipAdvice = { advice: "ask" | "save" | "give_first"; reason: string };

/**
 * Before a favor is requested, check the ledger. Suggest saving it for a trip
 * where it matters more, or giving before asking again.
 */
export function chipAdvice(entries: readonly LedgerEntry[], now: Date, ask: { importance: "routine" | "important" | "critical" }): ChipAdvice {
  const w = warmthEvidence(entries, now, 90);
  if (ask.importance === "critical") return { advice: "ask", reason: "Critical to the trip; worth spending relationship capital" };
  if (w.favorsAsked >= 3 && w.recognitionGiven === 0) {
    return { advice: "give_first", reason: `${w.favorsAsked} asks in 90 days with no recognition given` };
  }
  if (ask.importance === "routine" && w.balance < 0) {
    return { advice: "save", reason: "Ledger is in deficit; save this favor for a trip where it matters more" };
  }
  return { advice: "ask", reason: "Ledger supports the ask" };
}

export interface Nudge {
  personId: Id;
  kind: "recognition_overdue" | "moved_role" | "going_cold";
  message: string;
}

/** Nudges to the owner. The AI drafts; the human sends under their own name. */
export function nudges(person: Person, entries: readonly LedgerEntry[], now: Date): Nudge[] {
  const out: Nudge[] = [];
  const quarter = warmthEvidence(entries, now, 90);
  const upgradeAsks = entries.filter(
    (e) => e.kind === "favor_asked" && e.askType === "upgrade" && now.getTime() - new Date(e.at).getTime() <= 90 * 86_400_000,
  ).length;
  if (upgradeAsks >= 3 && quarter.recognitionGiven === 0) {
    out.push({
      personId: person.id,
      kind: "recognition_overdue",
      message: `${upgradeAsks} upgrade asks to ${person.name} this quarter and no review or note sent.`,
    });
  }
  const year = warmthEvidence(entries, now, 365);
  if (year.lastTouch && now.getTime() - new Date(year.lastTouch).getTime() > 180 * 86_400_000) {
    out.push({ personId: person.id, kind: "going_cold", message: `No contact with ${person.name} in over six months.` });
  }
  return out;
}

/**
 * A contact moved. The relationship follows them, the agent flags the new door
 * it opens, and shared knowledge that depended on this person at the old
 * property is flagged for review.
 */
export function recordMove(
  person: Person,
  next: Omit<RoleStint, "to">,
  dependentKnowledgeIds: readonly Id[],
): { person: Person; newDoor: string; knowledgeToReview: Id[] } {
  const prev = currentRole(person);
  const roles = person.roles.map((r) => (r.to === null ? { ...r, to: next.from } : r));
  roles.push({ ...next, to: null });
  return {
    person: { ...person, roles },
    newDoor: `${person.name} is now ${next.title} at ${next.organization}${prev ? ` (previously ${prev.title} at ${prev.organization})` : ""}.`,
    knowledgeToReview: [...dependentKnowledgeIds],
  };
}
