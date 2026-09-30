/**
 * Call tasks around the core rules in ./calls and ./commitments: the pre-call
 * relationship brief, what each party's jurisdiction requires, the notes-mode
 * template, reminder timing and the recap framing. Pure: callers pass `now`.
 */
import { captureDecision, onPartiesChanged, type CallParty, type CallTask, type CaptureMode, type ConsentRule, type ConsentTable } from "./calls";
import { DomainError } from "./common";
import type { Commitment, EvidenceType } from "./commitments";
import { chipAdvice, currentRole, warmthEvidence, type ChipAdvice, type LedgerEntry, type Person } from "./crm";

// ---------------------------------------------------------------------------
// Consent

/** ISO 3166-1 alpha-2, optionally with a subdivision: "FR", "US-CA", "GB-SCT". */
const JURISDICTION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

export function normalizeJurisdiction(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toUpperCase();
  if (!v) return null;
  if (!JURISDICTION_RE.test(v)) throw new DomainError("bad_jurisdiction", `"${raw}" is not a jurisdiction code like FR or US-CA`);
  return v;
}

/** Validates an edited consent table. Codes are normalized; duplicates are rejected rather than silently merged. */
export function parseConsentTable(rows: readonly { jurisdiction: string; rule: string }[]): ConsentTable {
  const out: Record<string, ConsentRule> = {};
  for (const r of rows) {
    const j = normalizeJurisdiction(r.jurisdiction);
    if (!j) continue;
    if (r.rule !== "one_party" && r.rule !== "all_party") throw new DomainError("bad_rule", `Unknown consent rule for ${j}`);
    if (out[j]) throw new DomainError("duplicate_jurisdiction", `${j} is listed twice`);
    out[j] = r.rule;
  }
  return out;
}

export interface PartyRule {
  name: string;
  jurisdiction: string | null;
  rule: ConsentRule;
  /** False when the jurisdiction is missing or not in the table, so the stricter rule was applied. */
  known: boolean;
  consentLogged: boolean;
}

/** The recording rule shown for every party on the task. */
export function partyRules(parties: readonly CallParty[], table: ConsentTable): PartyRule[] {
  return parties.map((p) => {
    const configured = p.jurisdiction ? table[p.jurisdiction] : undefined;
    return { name: p.name, jurisdiction: p.jurisdiction, rule: configured ?? "all_party", known: Boolean(configured), consentLogged: Boolean(p.consentLoggedAt) };
  });
}

/**
 * The expert asks for recorded mode. Allowed only when captureDecision says
 * so; the system decides whether consent is required, never the caller.
 */
export function requestRecordedMode(parties: readonly CallParty[], table: ConsentTable): CaptureMode {
  if (parties.length === 0) throw new DomainError("no_parties", "Add the call's parties before recording");
  const d = captureDecision(parties, table);
  if (d.mode !== "recorded") {
    throw new DomainError("consent_required", `Recording needs consent logged for: ${d.missingConsent.join(", ")}. ${d.reason}.`);
  }
  return "recorded";
}

/** Someone joined, was transferred in, or withdrew consent: re-evaluate. This can only downgrade. */
export function modeAfterChange(current: CaptureMode, parties: readonly CallParty[], table: ConsentTable): CaptureMode {
  return onPartiesChanged(current, parties, table);
}

/** Checked again at upload time, in case parties or the workspace's table changed since the mode was set. */
export function assertMayStoreCallAudio(mode: CaptureMode, parties: readonly CallParty[], table: ConsentTable): void {
  if (mode !== "recorded") throw new DomainError("notes_mode", "This call is in notes mode: no call audio is processed. Switch to recorded mode after logging consent.");
  requestRecordedMode(parties, table);
}

// ---------------------------------------------------------------------------
// Pre-call relationship brief

export interface OpenFavor {
  entry: LedgerEntry;
  daysOpen: number;
}

/** Favors asked with no later grant or decline of the same kind of ask. */
export function openFavors(entries: readonly LedgerEntry[], now: Date): OpenFavor[] {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const open: LedgerEntry[] = [];
  for (const e of sorted) {
    if (e.kind === "favor_asked") open.push(e);
    else if (e.kind === "favor_granted" || e.kind === "favor_declined") {
      const i = open.findIndex((o) => o.askType === e.askType);
      if (i >= 0) open.splice(i, 1);
    }
  }
  return open.map((entry) => ({ entry, daysOpen: Math.floor((now.getTime() - new Date(entry.at).getTime()) / 86_400_000) }));
}

export interface PreCallBrief {
  personName: string;
  role: string | null;
  measuredOn: string | null;
  approach: Person["approach"];
  texture: string[];
  recent: LedgerEntry[];
  openFavors: OpenFavor[];
  warmth: ReturnType<typeof warmthEvidence>;
  /** Only for asks that spend relationship capital: does the ask come too soon? */
  chip: ChipAdvice | null;
}

export function preCallBrief(
  person: Person,
  entries: readonly LedgerEntry[],
  task: Pick<CallTask, "spendsRelationshipCapital"> & { importance: "routine" | "important" | "critical" },
  now: Date,
): PreCallBrief {
  const mine = entries.filter((e) => e.personId === person.id);
  const role = currentRole(person);
  return {
    personName: person.name,
    role: role ? `${role.title}, ${role.organization}` : null,
    measuredOn: role?.measuredOn ?? null,
    approach: person.approach,
    texture: person.texture,
    recent: [...mine].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5),
    openFavors: openFavors(mine, now),
    warmth: warmthEvidence(mine, now),
    chip: task.spendsRelationshipCapital ? chipAdvice(mine, now, { importance: task.importance }) : null,
  };
}

// ---------------------------------------------------------------------------
// Notes mode and extraction

export function noteTemplate(task: Pick<CallTask, "purpose" | "ask" | "fallback" | "doneWhen">, personName: string | null): string {
  return [
    `Call${personName ? ` with ${personName}` : ""}: ${task.purpose}`,
    "",
    `Our ask: ${task.ask}`,
    `Fallback: ${task.fallback ?? "—"}`,
    `Done when: ${task.doneWhen}`,
    "",
    "Outcome (was it done?):",
    "",
    "What they promised (who, what, conditions, by when):",
    "- ",
    "",
    "What we promised:",
    "- ",
    "",
    "Names, amounts and dates to double-check:",
    "- ",
    "",
    "Anything for the relationship record (tone, personal context they chose to share):",
    "",
  ].join("\n");
}

export type CaptureSource = "call_audio" | "voice_debrief" | "notes";

/**
 * How we know. A call transcript is a machine transcript of both sides; a
 * voice debrief and written notes are the expert's own account.
 */
export function evidenceForSource(source: CaptureSource): EvidenceType {
  return source === "call_audio" ? "machine_transcript" : "expert_notes";
}

// ---------------------------------------------------------------------------
// Follow-through

export type ReminderKind = "due_soon" | "overdue";

/** A pending commitment due within the window, or already past due. */
export function reminderKind(c: Pick<Commitment, "state" | "dueBy">, now: Date, windowHours = 24): ReminderKind | null {
  if (c.state !== "pending" || !c.dueBy) return null;
  const due = new Date(c.dueBy).getTime();
  if (due <= now.getTime()) return "overdue";
  if (due - now.getTime() <= windowHours * 3_600_000) return "due_soon";
  return null;
}

export type CommitmentFilter = "all" | "needs_review" | "overdue" | "pending" | "disputed";

export function matchesFilter(c: Pick<Commitment, "state" | "dueBy" | "reviewStatus">, filter: CommitmentFilter, now: Date): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs_review":
      return c.reviewStatus === "needs_review";
    case "overdue":
      return reminderKind(c, now) === "overdue";
    case "pending":
      return c.state === "pending";
    case "disputed":
      return c.state === "disputed";
  }
}

/**
 * Deterministic framing around any recap, drafted or edited: it is sent by the
 * agency's system and records our understanding, not the supplier's agreement.
 */
export function frameRecap(body: string, ctx: { agencyName: string; expertName: string }): string {
  const header =
    `This recap is sent by ${ctx.agencyName}'s booking system on behalf of ${ctx.expertName}. ` +
    "It records our understanding of what was discussed; it is not a confirmation of your agreement. " +
    "If anything below differs from your understanding, please reply so we can correct it.";
  return `${header}\n\n${body.trim()}`;
}

export function recapFallbackDraft(commitments: readonly Pick<Commitment, "promisor" | "promise" | "conditions" | "dueBy">[], supplierName: string | null): { subject: string; body: string } {
  const lines = commitments.map((c) => {
    const due = c.dueBy ? ` (by ${c.dueBy.slice(0, 10)})` : "";
    const cond = c.conditions ? ` — ${c.conditions}` : "";
    return `- ${c.promisor}: ${c.promise}${cond}${due}`;
  });
  return {
    subject: "Recap of our conversation",
    body: [`${supplierName ? `Dear ${supplierName},` : "Hello,"}`, "", "Thank you for your time. As we understand it:", "", ...lines, "", "With thanks."].join("\n"),
  };
}
