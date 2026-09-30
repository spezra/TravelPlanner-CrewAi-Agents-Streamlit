/**
 * Discoverability: finding who can help with a destination or need. It says
 * that someone can help, never how to reach them or what they know in detail.
 */
import type { Id } from "./common";
import type { ContributionType } from "./collaboration";

export type ResponseCapacity = "available" | "limited" | "unavailable";

export interface NetworkProfile {
  memberId: Id;
  workspaceId: Id;
  displayName: string;
  headline: string | null;
  destinations: string[];
  capabilities: ContributionType[];
  languages: string[];
  responseCapacity: ResponseCapacity;
}

export interface NetworkQuery {
  destination?: string | null;
  capability?: ContributionType | null;
  language?: string | null;
}

/** Case- and accent-insensitive, so "Mexico" finds "México". */
export const normalize = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const overlaps = (a: string, b: string) => {
  const x = normalize(a);
  const y = normalize(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
};

export interface ProfileMatch extends NetworkProfile {
  score: number;
  matched: string[];
}

/**
 * Filters to profiles that satisfy every criterion given, ranked by capacity
 * (someone with room to help first) and then by name. Profiles with no
 * capacity stay visible, ranked last, so the requester knows they exist.
 */
export function matchProfiles(profiles: readonly NetworkProfile[], q: NetworkQuery): ProfileMatch[] {
  const out: ProfileMatch[] = [];
  for (const p of profiles) {
    const matched: string[] = [];
    if (q.destination?.trim()) {
      const hits = p.destinations.filter((d) => overlaps(d, q.destination!));
      if (!hits.length) continue;
      matched.push(...hits);
    }
    if (q.capability) {
      if (!p.capabilities.includes(q.capability)) continue;
      matched.push(q.capability);
    }
    if (q.language?.trim()) {
      const hits = p.languages.filter((l) => overlaps(l, q.language!));
      if (!hits.length) continue;
      matched.push(...hits);
    }
    const capacity = p.responseCapacity === "available" ? 2 : p.responseCapacity === "limited" ? 1 : 0;
    out.push({ ...p, matched, score: capacity * 10 + matched.length });
  }
  return out.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
}

/** Parses a comma- or newline-separated list, trimmed, de-duplicated (case-insensitively), capped. */
export function parseList(input: string, max = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const v = raw.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!v || seen.has(normalize(v))) continue;
    seen.add(normalize(v));
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
