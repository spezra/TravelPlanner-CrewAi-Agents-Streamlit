/**
 * Shared primitives for the domain core. Everything in src/domain is pure:
 * no I/O, no clock reads (callers pass `now`), no randomness.
 */

export type Id = string;

/** Money is always integer minor units (cents) plus an ISO 4217 currency. */
export interface Money {
  amountMinor: number;
  currency: string;
}

export const money = (amountMinor: number, currency = "USD"): Money => {
  if (!Number.isInteger(amountMinor)) throw new Error(`amountMinor must be an integer, got ${amountMinor}`);
  return { amountMinor, currency };
};

export const formatMoney = (m: Money): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(m.amountMinor / 100);

export type Role = "owner" | "advisor" | "assistant" | "admin";

/**
 * Where a record lives. Private: the expert and their named delegates.
 * Workspace: the agency (a solo expert is a workspace of one).
 * Network: curated members, only via deliberate publication.
 */
export type Scope = "private" | "workspace" | "network";

/** Deterministic JSON: object keys sorted, so equal values serialize identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** FNV-1a 64-bit, hex. Used for fingerprints and idempotency keys, not security. */
export function fingerprint(value: unknown): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function assertTransition<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
  entity: string,
): void {
  if (!table[from].includes(to)) {
    throw new DomainError("invalid_transition", `${entity}: cannot move from ${from} to ${to}`);
  }
}
