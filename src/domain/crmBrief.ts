/**
 * What the relationship holder sees before a call or an ask: recent
 * interactions, open favors, what to mention and what to avoid, and whether an
 * ask would come too soon. Also the plain-text note drafts behind nudges; the
 * human edits and sends them under their own name.
 */
import { chipAdvice, currentRole, warmthEvidence, type ChipAdvice, type LedgerEntry, type Nudge, type Person } from "./crm";

export type AskImportance = "routine" | "important" | "critical";

export interface OpenFavor {
  entry: LedgerEntry;
  ageDays: number;
}

const DAY = 86_400_000;

/**
 * A favor stays open until a later granted/declined entry of the same ask type
 * (or, when no type was given, any later answer) closes it. Oldest answer
 * closes oldest ask.
 */
export function openFavors(entries: readonly LedgerEntry[], now: Date): OpenFavor[] {
  const sorted = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const open: LedgerEntry[] = [];
  for (const e of sorted) {
    if (e.kind === "favor_asked") open.push(e);
    else if (e.kind === "favor_granted" || e.kind === "favor_declined") {
      const i = open.findIndex((o) => e.askType === null || o.askType === null || o.askType === e.askType);
      if (i >= 0) open.splice(i, 1);
    }
  }
  return open.map((entry) => ({ entry, ageDays: Math.floor((now.getTime() - new Date(entry.at).getTime()) / DAY) }));
}

export interface AskTiming {
  tooSoon: boolean;
  reasons: string[];
  advice: ChipAdvice;
}

/**
 * Whether another ask now would come too soon: a favor still unanswered, an
 * ask in the last two weeks, or a ledger that says to give first or save it.
 */
export function askTiming(entries: readonly LedgerEntry[], now: Date, importance: AskImportance = "routine"): AskTiming {
  const reasons: string[] = [];
  const open = openFavors(entries, now);
  if (open.length) reasons.push(`${open.length} favor${open.length > 1 ? "s" : ""} still unanswered (oldest ${Math.max(...open.map((o) => o.ageDays))} days)`);
  const lastAsk = entries.filter((e) => e.kind === "favor_asked").reduce<string | null>((acc, e) => (acc === null || e.at > acc ? e.at : acc), null);
  if (lastAsk) {
    const days = Math.floor((now.getTime() - new Date(lastAsk).getTime()) / DAY);
    if (days < 14) reasons.push(`Last ask was ${days} day${days === 1 ? "" : "s"} ago`);
  }
  const advice = chipAdvice(entries, now, { importance });
  if (advice.advice !== "ask") reasons.push(advice.reason);
  return { tooSoon: importance !== "critical" && reasons.length > 0, reasons, advice };
}

const AVOID = /\b(avoid|don't|dont|do not|never|hates?|dislikes?|sensitive|careful)\b/i;

export interface PreCallBrief {
  headline: string;
  approach: string[];
  measuredOn: string | null;
  recent: LedgerEntry[];
  openFavors: OpenFavor[];
  mention: string[];
  avoid: string[];
  askTiming: AskTiming;
  warmth: ReturnType<typeof warmthEvidence>;
}

/**
 * The owner's brief. `texture` is only passed when the viewer is the owner;
 * other members get the brief without it.
 */
export function preCallBrief(
  person: Person,
  entries: readonly LedgerEntry[],
  now: Date,
  opts: { texture: readonly string[] | null; clientNames: readonly string[]; importance?: AskImportance },
): PreCallBrief {
  const role = currentRole(person);
  const recent = [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 6);
  const mention: string[] = [];
  const avoid: string[] = [];
  for (const t of opts.texture ?? []) (AVOID.test(t) ? avoid : mention).push(t);
  const previous = person.roles.filter((r) => r.to !== null).sort((a, b) => (a.to! < b.to! ? 1 : -1))[0];
  if (role && previous && now.getTime() - new Date(role.from).getTime() < 180 * DAY) {
    mention.push(`Congratulate them on the move to ${role.organization} (from ${previous.organization})`);
  }
  const lastRecognition = entries.filter((e) => e.kind === "recognition_given").sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (lastRecognition) mention.push(`Recognition you gave on ${lastRecognition.at.slice(0, 10)}: ${lastRecognition.note || "noted"}`);
  const lastBusiness = entries.filter((e) => e.kind === "business_sent").sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (lastBusiness) mention.push(`Business you sent on ${lastBusiness.at.slice(0, 10)}${lastBusiness.roomNights ? ` (${lastBusiness.roomNights} nights)` : ""}: ${lastBusiness.note || "booking"}`);
  if (opts.clientNames.length) mention.push(`Knows ${opts.clientNames.join(", ")}: greet by name`);
  if (!person.approach.goingOverTheirHeadAcceptable) avoid.push(`Going over their head${person.approach.boss ? ` to ${person.approach.boss}` : ""}`);

  const approach = [
    person.approach.channel ? `Reach via ${person.approach.channel}` : null,
    person.approach.language ? `Language: ${person.approach.language}` : null,
    person.approach.timeZone ? `Time zone: ${person.approach.timeZone}` : null,
    person.approach.boss ? `Reports to ${person.approach.boss}` : null,
  ].filter((x): x is string => x !== null);

  return {
    headline: role ? `${person.name}, ${role.title} at ${role.organization}` : person.name,
    approach,
    measuredOn: role?.measuredOn ?? null,
    recent,
    openFavors: openFavors(entries, now),
    mention,
    avoid,
    askTiming: askTiming(entries, now, opts.importance ?? "routine"),
    warmth: warmthEvidence(entries, now),
  };
}

/**
 * A plain draft for a nudge, used when no agent is configured and as the
 * agent's starting point. Written in the owner's voice for them to edit; the
 * system never sends it.
 */
export function templateNoteDraft(person: Person, nudge: Pick<Nudge, "kind" | "message">, ownerName: string): { subject: string; body: string } {
  const first = person.name.split(/\s+/)[0] ?? person.name;
  const role = currentRole(person);
  const sign = `\n\nWarmly,\n${ownerName}`;
  switch (nudge.kind) {
    case "recognition_overdue":
      return {
        subject: "Thank you",
        body: `Dear ${first},\n\nI wanted to say thank you properly for everything you and the team have done for my clients recently. It makes a real difference, and I'd like to put that in writing for ${person.approach.boss ?? "your team"} as well.${sign}`,
      };
    case "moved_role":
      return {
        subject: role ? `Congratulations on ${role.organization}` : "Congratulations",
        body: `Dear ${first},\n\nCongratulations on the new role${role ? ` as ${role.title} at ${role.organization}` : ""}. I'd love to hear how you're settling in, and to think about which of my clients would be a good fit.${sign}`,
      };
    case "going_cold":
      return {
        subject: "Catching up",
        body: `Dear ${first},\n\nIt's been too long. I hope all is well with you${role ? ` and everyone at ${role.organization}` : ""}. I'd love to catch up on what's new when you have a moment.${sign}`,
      };
  }
}

/** A mailto: link the owner opens in their own mail client. */
export function mailtoLink(to: readonly string[], subject: string, body: string): string {
  return `mailto:${to.map(encodeURIComponent).join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
