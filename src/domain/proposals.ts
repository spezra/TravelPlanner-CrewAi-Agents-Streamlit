/**
 * Proposals: the editorial document a client sees. Agents draft in the
 * expert's style from the brief, the expert's taste model and their own
 * dated observations; the expert edits and sends. Every recommendation
 * carries its evidence, and nothing availability-dependent is promised.
 */
import { fingerprint, type Id } from "./common";
import type { Perk } from "./bookings";
import type { TrustTier } from "./knowledge";

export type ProposalStatus = "draft" | "ready" | "sent" | "accepted" | "superseded";

export interface ProposalSection {
  key: string;
  heading: string;
  /** Editorial narrative in the expert's voice. */
  body: string;
  /** Trip items this section presents. */
  itemIds: Id[];
  recommendations: Recommendation[];
}

export interface Recommendation {
  subject: string;
  why: string;
  /** Where the recommendation comes from, shown to the expert (not necessarily the client). */
  evidence: { observationId: Id | null; provenance: string; tier: TrustTier } | null;
  alternatives: { subject: string; whyNot: string }[];
}

export interface Proposal {
  id: Id;
  tripId: Id;
  version: number;
  status: ProposalStatus;
  title: string;
  intro: string;
  sections: ProposalSection[];
  closing: string;
  createdBy: string; // member id or "agent:proposals"
  editedByExpert: boolean;
}

export const proposalFingerprint = (p: Pick<Proposal, "title" | "intro" | "sections" | "closing">) =>
  fingerprint({ title: p.title, intro: p.intro, closing: p.closing, sections: p.sections.map((s) => ({ h: s.heading, b: s.body, r: s.recommendations.map((r) => r.subject) })) });

export interface ProposalIssue {
  section: string;
  severity: "block" | "warn";
  message: string;
}

const PROMISE_WORDS = /\b(guaranteed?|will (?:be|receive|get|have)|you(?:'ll| will) (?:enjoy|get|have|receive)|confirmed|assured|promise[sd]?)\b/i;

/**
 * Checks a draft before the expert can send it:
 * - availability-dependent perks must not be worded as promises;
 * - recommendations backed only by retained (unverified) evidence are flagged;
 * - sections must reference items that exist.
 */
export function reviewProposal(
  p: Pick<Proposal, "intro" | "sections" | "closing">,
  ctx: { itemIds: ReadonlySet<Id>; perksByItem: ReadonlyMap<Id, readonly Perk[]> },
): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  const availabilityPerks = [...ctx.perksByItem.values()].flat().filter((pk) => pk.basis === "availability_dependent");
  const texts: { section: string; text: string }[] = [
    { section: "intro", text: p.intro },
    { section: "closing", text: p.closing },
    ...p.sections.map((s) => ({ section: s.heading, text: `${s.body}\n${s.recommendations.map((r) => r.why).join("\n")}` })),
  ];
  for (const { section, text } of texts) {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      for (const perk of availabilityPerks) {
        const name = perk.name.toLowerCase().replace(/^(room|a|an|the)\s+/, "");
        if (sentence.toLowerCase().includes(name) && PROMISE_WORDS.test(sentence) && !/request|subject to availability|if available|we(?:'ll| will) ask/i.test(sentence)) {
          issues.push({ section, severity: "block", message: `"${perk.name}" depends on availability but reads as promised: "${sentence.trim()}"` });
        }
      }
    }
  }
  for (const s of p.sections) {
    for (const id of s.itemIds) if (!ctx.itemIds.has(id)) issues.push({ section: s.heading, severity: "block", message: `References an item that isn't on this trip` });
    for (const r of s.recommendations) {
      if (!r.evidence) issues.push({ section: s.heading, severity: "warn", message: `"${r.subject}" has no recorded evidence; confirm it's from your own knowledge` });
      else if (r.evidence.tier === "retain") issues.push({ section: s.heading, severity: "warn", message: `"${r.subject}" rests on ${r.evidence.provenance.toLowerCase()} — not reliable enough to recommend without checking` });
    }
  }
  return issues;
}

export const canSend = (issues: readonly ProposalIssue[]) => !issues.some((i) => i.severity === "block");
