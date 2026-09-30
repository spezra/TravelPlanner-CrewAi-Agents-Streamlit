/**
 * Validation for per-trip response plans, and the scoped access the named
 * backup holds so an always-on agent never waits on a sleeping solo expert.
 */
import { DomainError, type Id } from "./common";
import type { CoverageWindow, ResponsePlan } from "./responsePlan";

/** The backup's pre-authorized access outlives the trip by a week, for follow-up and recovery. */
export const BACKUP_GRACE_DAYS = 7;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function checkWindows(label: string, windows: readonly CoverageWindow[]): void {
  if (windows.length === 0) throw new DomainError("bad_plan", `${label} needs at least one coverage window`);
  for (const w of windows) {
    if (w.days.length === 0 || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new DomainError("bad_plan", `${label}: choose coverage days`);
    if (!Number.isInteger(w.startHour) || !Number.isInteger(w.endHour) || w.startHour < 0 || w.endHour > 24 || w.startHour >= w.endHour) {
      throw new DomainError("bad_plan", `${label}: coverage hours must run forward within 0–24`);
    }
  }
}

/** Throws a DomainError describing the first problem; returns the plan with a de-duplicated escalation chain. */
export function validateResponsePlan(plan: ResponsePlan, activeMemberIds: readonly Id[]): ResponsePlan {
  const known = (id: Id) => activeMemberIds.includes(id);
  if (!known(plan.primary.memberId)) throw new DomainError("bad_plan", "Primary must be an active member of this workspace");
  if (!isValidTimeZone(plan.primary.timeZone)) throw new DomainError("bad_plan", `Unknown time zone: ${plan.primary.timeZone}`);
  checkWindows("Primary", plan.primary.coverage);
  if (plan.backup) {
    if (!known(plan.backup.memberId)) throw new DomainError("bad_plan", "Backup must be an active member of this workspace");
    if (plan.backup.memberId === plan.primary.memberId) throw new DomainError("bad_plan", "The backup must be someone other than the primary");
    if (!isValidTimeZone(plan.backup.timeZone)) throw new DomainError("bad_plan", `Unknown time zone: ${plan.backup.timeZone}`);
    checkWindows("Backup", plan.backup.coverage);
  }
  if (!Number.isInteger(plan.ackDeadlineMinutes) || plan.ackDeadlineMinutes < 5 || plan.ackDeadlineMinutes > 24 * 60) {
    throw new DomainError("bad_plan", "Acknowledgement deadline must be between 5 minutes and 24 hours");
  }
  const seen = new Set<Id>([plan.primary.memberId, ...(plan.backup ? [plan.backup.memberId] : [])]);
  const escalation: Id[] = [];
  for (const id of plan.escalation) {
    if (!known(id)) throw new DomainError("bad_plan", "Everyone in the escalation chain must be an active member");
    if (!seen.has(id)) escalation.push(id);
    seen.add(id);
  }
  if (plan.clientContactPolicy.trim().length < 3) throw new DomainError("bad_plan", "State who may contact the client, and when");
  return { ...plan, escalation };
}

/** Delegation expiry for the named backup: the trip's last day plus the grace period, end of day UTC. */
export function backupAccessExpiry(tripEndsOn: string | null): Date {
  if (!tripEndsOn) throw new DomainError("no_end_date", "Set the trip's end date before naming a backup; their access expires after the trip");
  const end = new Date(`${tripEndsOn.slice(0, 10)}T23:59:59Z`);
  return new Date(end.getTime() + BACKUP_GRACE_DAYS * 86_400_000);
}
