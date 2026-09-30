/**
 * Clients as part of an expert's book. Book portability is a workspace setting
 * agreed at signup, not settled at exit: independent advisors expect to take
 * their book when they leave, agencies often claim it. The setting decides
 * where a new client record lives and who may move it.
 */
import type { BookPortability } from "./privacy";
import { DomainError, type Id, type Role } from "./common";
import type { BriefDimension, BriefStatement } from "./brief";

export type ClientScope = "private" | "workspace";

export interface ScopeRules {
  defaultScope: ClientScope;
  allowed: readonly ClientScope[];
}

/**
 * advisor_owns: the advisor's book is theirs, so clients start private (the
 *   owner and named delegates), and the advisor may share them.
 * agency_owns: the agency's book, so every client record is workspace-visible.
 * shared: workspace by default; an advisor can keep a client private.
 */
export function clientScopeRules(portability: BookPortability): ScopeRules {
  switch (portability) {
    case "advisor_owns":
      return { defaultScope: "private", allowed: ["private", "workspace"] };
    case "agency_owns":
      return { defaultScope: "workspace", allowed: ["workspace"] };
    case "shared":
      return { defaultScope: "workspace", allowed: ["private", "workspace"] };
  }
}

export function assertScopeAllowed(portability: BookPortability, scope: ClientScope): void {
  if (!clientScopeRules(portability).allowed.includes(scope)) {
    throw new DomainError("scope_not_allowed", `This workspace's book belongs to the agency; clients can't be made ${scope}`);
  }
}

/**
 * Who may change a client's owner or scope. Under advisor ownership only the
 * advisor who holds the client decides; where the agency owns or shares the
 * book, workspace owners and admins can also reassign.
 */
export function canManageClient(portability: BookPortability, actor: { id: Id; role: Role }, clientOwnerId: Id): boolean {
  if (actor.id === clientOwnerId) return true;
  if (portability === "advisor_owns") return false;
  return actor.role === "owner" || actor.role === "admin";
}

/**
 * Promoting a trip need to an enduring preference changes assumptions for
 * every future trip, so it is the expert's call: owners and advisors, never
 * assistants or admins acting on their own.
 */
export function canPromote(role: Role): boolean {
  return role === "owner" || role === "advisor";
}

export const OUTCOME_KINDS = ["enjoyed", "regretted", "would_repeat"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  enjoyed: "Enjoyed",
  regretted: "Regretted",
  would_repeat: "Would repeat",
};

export const DIMENSION_LABEL: Record<BriefDimension, string> = {
  desired_experience: "Desired experience",
  practical_constraints: "Practical constraints",
  party_dynamics: "Party dynamics",
  outcomes: "Outcomes",
};

/**
 * Replace a statement with a corrected one. The original is kept for history
 * and points at its replacement; the replacement keeps the original's trip
 * binding unless the caller says otherwise.
 */
export function supersede(
  original: BriefStatement,
  replacement: Omit<BriefStatement, "id" | "clientId" | "supersededBy" | "recordedAt"> & { id: Id },
  now: Date,
): { original: BriefStatement; replacement: BriefStatement } {
  if (original.supersededBy) throw new DomainError("already_superseded", "That statement was already replaced");
  const next: BriefStatement = { ...replacement, clientId: original.clientId, supersededBy: null, recordedAt: now.toISOString() };
  return { original: { ...original, supersededBy: next.id }, replacement: next };
}
