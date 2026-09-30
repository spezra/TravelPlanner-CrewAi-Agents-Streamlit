/**
 * Workspace data protection rules: exports, data-subject requests, retention
 * and deletion. Purpose-limited storage, retention limits, and access and
 * deletion requests per workspace (spec: Compliance and risk, personal data).
 */
import { DomainError } from "./common";

export type BookPortability = "advisor_owns" | "agency_owns" | "shared";
export type SubjectType = "client" | "party_member" | "person";

/** Exports hold everything a member can see; they live briefly and download once. */
export const EXPORT_TTL_DAYS = 7;

export function exportExpiry(now: Date): Date {
  return new Date(now.getTime() + EXPORT_TTL_DAYS * 86_400_000);
}

export type ExportStatus = "queued" | "ready" | "downloaded" | "expired" | "failed";

/** Download is allowed once, by the requester, while unexpired. */
export function canDownload(exp: { status: ExportStatus; requestedBy: string; expiresAt: string }, memberId: string, now: Date): { ok: true } | { ok: false; reason: string } {
  if (exp.requestedBy !== memberId) return { ok: false, reason: "Only the member who requested this export can download it" };
  if (exp.status === "downloaded") return { ok: false, reason: "This export was already downloaded" };
  if (exp.status !== "ready") return { ok: false, reason: `This export is ${exp.status}` };
  if (new Date(exp.expiresAt) <= now) return { ok: false, reason: "This export has expired" };
  return { ok: true };
}

export interface RetentionSettings {
  /** Pasted notes, emails and decision conversations kept for extraction. */
  sourceTextDays: number;
  /** Raw call audio (enforced by call capture). */
  rawAudioDays: number;
}

export const DEFAULT_RETENTION: RetentionSettings = { sourceTextDays: 90, rawAudioDays: 30 };

export function validateRetention(r: RetentionSettings): RetentionSettings {
  for (const [k, v] of Object.entries(r)) {
    if (!Number.isInteger(v) || v < 1 || v > 3650) throw new DomainError("bad_retention", `${k} must be a whole number of days between 1 and 3650`);
  }
  return r;
}

export function retentionCutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * Irreversible deletion needs the exact workspace name typed back, so it
 * can't happen from a stray click or a stale tab.
 */
export function confirmWorkspaceDeletion(workspaceName: string, typed: string): void {
  if (typed.trim() !== workspaceName.trim()) throw new DomainError("confirmation_mismatch", "Type the workspace name exactly to confirm deletion");
}

/** Label kept on the request after erasure: identifies the record, not the person. */
export function subjectRef(type: SubjectType, id: string): string {
  return `${type.replace("_", " ")} ${id.slice(0, 8)}`;
}

/** Replacement shown where an erased name used to be. */
export const ERASED = "[erased]";
