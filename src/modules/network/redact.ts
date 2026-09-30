/**
 * Deterministic redaction and source checking for the publication pipeline
 * and anonymized collaboration briefs.
 *
 * Detectors: emails, URLs, phone numbers, prices and commercial figures, room
 * numbers, and the names of every person, client and member in the
 * workspace. They are deliberately greedy (a false positive costs a word; a
 * false negative can cost a relationship), and they are not complete: an LLM
 * pass (src/agents/redactionReviewer.ts) and the owner's approval sit behind
 * them. Pure: no I/O.
 */
import type { Queryable } from "@/db/client";

export type FindingKind = "email" | "url" | "phone" | "price" | "figure" | "room" | "person" | "client" | "member" | "flagged";

export interface RedactionFinding {
  kind: FindingKind;
  /** The text removed. Shown only to the item's owner, who wrote it. */
  text: string;
  placeholder: string;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

export const PLACEHOLDER: Record<FindingKind, string> = {
  email: "[email]",
  url: "[link]",
  phone: "[phone]",
  price: "[amount]",
  figure: "[figure]",
  room: "[room]",
  person: "[person]",
  client: "[client]",
  member: "[advisor]",
  flagged: "[redacted]",
};

const PLACEHOLDER_WORDS = new Set(["email", "link", "phone", "amount", "figure", "room", "person", "client", "advisor", "redacted"]);

export interface NameEntry {
  name: string;
  kind: "person" | "client" | "member";
}

// Unicode-aware word edges (\b only understands ASCII).
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";

const CURRENCY_CODES = "USD|EUR|GBP|MXN|CAD|AUD|NZD|CHF|JPY|CNY|HKD|SGD|AED|ZAR|BRL|INR|THB|SEK|NOK|DKK";
const CURRENCY_WORDS = "dollars?|euros?|pesos?|pounds?|francs?|yen|bucks";

interface Detector {
  kind: FindingKind;
  re: RegExp;
  /** Reject a raw match (e.g. a date that looks like a phone number). */
  accept?: (m: string) => boolean;
  /** Trim trailing punctuation that belongs to the sentence. */
  trim?: RegExp;
}

const DETECTORS: Detector[] = [
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu },
  {
    kind: "url",
    re: /(?:https?:\/\/|www\.)[^\s<>"']+|(?<![\p{L}\p{N}@.])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|travel|hotel|mx|fr|it|es|uk|de|jp|com\.mx|co\.uk)(?:\/[^\s<>"']*)?(?![\p{L}\p{N}])/giu,
    trim: /[.,;:!?)\]]+$/u,
  },
  {
    kind: "price",
    re: new RegExp(
      [
        `[$€£¥₱]\\s?\\d[\\d,.' ]*\\d(?:\\s?(?:k|m|bn|million|thousand))?${R}`,
        `[$€£¥₱]\\s?\\d${R}`,
        `${L}(?:${CURRENCY_CODES}|US\\$|MX\\$)\\s?\\d[\\d,.]*(?:\\s?(?:k|m|million|thousand))?${R}`,
        `${L}\\d[\\d,.]*(?:\\s?(?:k|m|million|thousand))?\\s?(?:${CURRENCY_CODES}|${CURRENCY_WORDS})${R}`,
      ].join("|"),
      "giu",
    ),
  },
  { kind: "figure", re: new RegExp(`${L}\\d+(?:[.,]\\d+)?\\s?(?:%|percent${R}|per cent${R})`, "giu") },
  {
    kind: "room",
    re: new RegExp(
      `${L}(?:rooms?|rm\\.?|suites?|casitas?|villas?|bungalows?|cabins?|cabanas?|chalets?|apartments?|apt\\.?|bedrooms?|tents?|lodges?|cottages?|habitaci[oó]n|chambre)\\s*(?:no\\.?\\s*|number\\s*|n[°º]\\s*|#\\s*)?\\d{1,4}[a-z]?(?:\\s*(?:[–—-]|to|and|&|,)\\s*\\d{1,4}[a-z]?)*${R}`,
      "giu",
    ),
  },
  {
    kind: "phone",
    re: /(?<![\p{L}\p{N}])\+?\(?\d[\d\s().-]{5,}\d(?![\p{L}\p{N}])/gu,
    accept: (m) => {
      const digits = m.replace(/\D/g, "").length;
      if (digits < 7 || digits > 15) return false;
      const t = m.trim();
      // Dates and year ranges are not phone numbers.
      if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(t)) return false;
      if (/^\d{4}\s*[-–]\s*\d{4}$/.test(t)) return false;
      return true;
    },
  },
];

const NAME_STOPWORDS = new Set([
  "the", "and", "of", "de", "del", "la", "le", "les", "los", "las", "van", "von", "der", "den", "da", "di", "du", "y", "e",
  "mr", "mrs", "ms", "dr", "sir", "family", "familia", "jr", "sr",
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface NamePattern {
  re: RegExp;
  kind: "person" | "client" | "member";
  /** Full names outrank single tokens when they overlap. */
  weight: number;
}

/**
 * Full names match case-insensitively. Individual name tokens match when
 * capitalized, so "Rafael" is caught but the word "vega" in a sentence is
 * judged by context-free rules only if written as a proper noun. Family-style
 * client names ("The Whitfields") also match their singular ("Whitfield").
 */
export function namePatterns(names: readonly NameEntry[]): NamePattern[] {
  const out: NamePattern[] = [];
  const seen = new Set<string>();
  const add = (source: string, flags: string, kind: NameEntry["kind"], weight: number) => {
    const key = `${source}/${flags}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ re: new RegExp(`${L}${source}${R}`, flags), kind, weight });
  };
  for (const { name, kind } of names) {
    const clean = name.replace(/\s+/g, " ").trim();
    if (clean.length < 2) continue;
    add(clean.split(" ").map(escapeRe).join("\\s+"), "giu", kind, 3);
    const tokens = clean.split(/[\s-]+/).filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t.toLowerCase()) && /^\p{Lu}/u.test(t));
    for (const t of tokens) {
      const base = escapeRe(t.replace(/[’']s$/u, ""));
      add(`${base}(?:[’']s)?`, "gu", kind, 2);
      if (kind === "client") {
        // "The Whitfields" -> also "Whitfield", "Whitfield's".
        const singular = t.replace(/(?:es|s)$/u, "");
        if (singular.length >= 3 && singular !== t) add(`${escapeRe(singular)}(?:s|es|[’']s)?`, "gu", kind, 2);
      }
    }
  }
  return out;
}

interface Span {
  start: number;
  end: number;
  kind: FindingKind;
  weight: number;
}

function collect(text: string, patterns: NamePattern[], extraSpans: readonly string[]): Span[] {
  const spans: Span[] = [];
  const push = (start: number, raw: string, kind: FindingKind, weight: number, trim?: RegExp) => {
    let m = raw;
    if (trim) m = m.replace(trim, "");
    // Leading/trailing whitespace is sentence, not detection.
    const lead = m.length - m.trimStart().length;
    m = m.trim();
    if (m) spans.push({ start: start + lead, end: start + lead + m.length, kind, weight });
  };
  DETECTORS.forEach((d, i) => {
    for (const m of text.matchAll(d.re)) {
      if (d.accept && !d.accept(m[0])) continue;
      // Earlier detectors win ties (an email's domain is not a separate URL).
      push(m.index!, m[0], d.kind, 10 - i, d.trim);
    }
  });
  for (const p of patterns) for (const m of text.matchAll(p.re)) push(m.index!, m[0], p.kind, p.weight);
  for (const s of extraSpans) {
    const needle = s.trim();
    if (needle.length < 2) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      push(at, needle, "flagged", 1);
      from = at + needle.length;
    }
  }
  return spans;
}

/** Longest-first, then strongest; overlapping spans are dropped. */
function resolve(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || b.weight - a.weight || a.start - b.start);
  const kept: Span[] = [];
  for (const s of sorted) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}

export interface Redactor {
  /** `extraSpans`: exact substrings flagged by the LLM review or the owner. */
  redact(text: string, extraSpans?: readonly string[]): RedactionResult;
}

export function createRedactor(names: readonly NameEntry[] = []): Redactor {
  const patterns = namePatterns(names);
  return {
    redact(text, extraSpans = []) {
      const spans = resolve(collect(text, patterns, extraSpans));
      let out = "";
      let at = 0;
      const findings: RedactionFinding[] = [];
      for (const s of spans) {
        out += text.slice(at, s.start) + PLACEHOLDER[s.kind];
        findings.push({ kind: s.kind, text: text.slice(s.start, s.end), placeholder: PLACEHOLDER[s.kind] });
        at = s.end;
      }
      out += text.slice(at);
      return { text: out, findings };
    },
  };
}

/** Contact details anywhere in a discoverability profile are refused, not redacted. */
export function contactDetailsIn(text: string): RedactionFinding[] {
  return createRedactor()
    .redact(text)
    .findings.filter((f) => f.kind === "email" || f.kind === "url" || f.kind === "phone");
}

/** Every person, client and member name in the caller's workspace (see redaction_names() in 040). */
export async function loadWorkspaceNames(q: Queryable): Promise<NameEntry[]> {
  const { rows } = await q.query<{ name: string; kind: NameEntry["kind"] }>("select name, kind from redaction_names()");
  return rows;
}

// ---------------------------------------------------------------------------
// Source check

/** Words whose loss would overstate the source: negations, hedges, conditions. */
const QUALIFIERS = new Set([
  "not", "never", "no", "none", "only", "sometimes", "usually", "often", "occasionally", "rarely", "seldom",
  "may", "might", "except", "unless", "if", "but", "depending", "depends", "subject", "seasonal", "until", "without",
]);

const tokenize = (s: string): string[] =>
  s
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}’']+/u)
    .map((w) => w.replace(/^['’]+|['’]+$/g, ""))
    .filter(Boolean)
    .map((w) => (/n[’']t$/.test(w) ? "not" : w));

/**
 * Deterministic check that a redacted item still says what its source says:
 * it may only remove words, never add them, and it may not drop a qualifier
 * ("usually", "not", "only if") that makes the source less absolute. Owner
 * edits are held to the same test. It cannot judge meaning; the LLM check or
 * the owner does that.
 */
export function deterministicSourceCheck(source: string, redacted: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const src = tokenize(source);
  const red = tokenize(redacted);
  if (red.filter((w) => !PLACEHOLDER_WORDS.has(w)).length === 0) issues.push("nothing of substance is left after redaction");
  const srcSet = new Set(src);
  const added = [...new Set(red.filter((w) => !srcSet.has(w) && !PLACEHOLDER_WORDS.has(w)))];
  if (added.length) issues.push(`adds wording not in the source: ${added.slice(0, 8).join(", ")}`);
  const count = (ws: string[]) => ws.reduce((m, w) => (QUALIFIERS.has(w) ? m.set(w, (m.get(w) ?? 0) + 1) : m), new Map<string, number>());
  const before = count(src);
  const after = count(red);
  const dropped = [...before].filter(([w, n]) => (after.get(w) ?? 0) < n).map(([w]) => w);
  if (dropped.length) issues.push(`drops qualifiers from the source: ${dropped.join(", ")}`);
  return { ok: issues.length === 0, issues };
}
