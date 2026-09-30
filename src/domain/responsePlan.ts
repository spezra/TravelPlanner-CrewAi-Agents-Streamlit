/**
 * Per-trip response plan: primary owner, backup, coverage hours,
 * acknowledgement deadline, escalation route and client-contact policy. The
 * backup holds pre-authorized, scoped access to that trip, so an always-on
 * agent never waits on a sleeping solo expert. An unhappy client is answered
 * by the advisor or the named backup, never by the system alone.
 */
import type { Id } from "./common";

export interface CoverageWindow {
  /** 0 = Sunday. */
  days: number[];
  startHour: number; // local, inclusive
  endHour: number; // local, exclusive
}

export interface Responder {
  memberId: Id;
  timeZone: string;
  coverage: CoverageWindow[];
}

export interface ResponsePlan {
  tripId: Id;
  primary: Responder;
  backup: Responder | null;
  ackDeadlineMinutes: number;
  escalation: Id[]; // after backup, in order
  clientContactPolicy: string;
}

function localParts(now: Date, timeZone: string): { day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd), hour };
}

export function isOnDuty(r: Responder, now: Date): boolean {
  const { day, hour } = localParts(now, r.timeZone);
  return r.coverage.some((w) => w.days.includes(day) && hour >= w.startHour && hour < w.endHour);
}

/** Who a new event goes to right now. If nobody on the plan is on duty, the primary is paged anyway. */
export function currentResponder(plan: ResponsePlan, now: Date): { memberId: Id; role: "primary" | "backup" | "escalation" } {
  if (isOnDuty(plan.primary, now)) return { memberId: plan.primary.memberId, role: "primary" };
  if (plan.backup && isOnDuty(plan.backup, now)) return { memberId: plan.backup.memberId, role: "backup" };
  return { memberId: plan.primary.memberId, role: "primary" };
}

/** Next responder in line once the acknowledgement deadline passes unacknowledged. */
export function escalationTarget(plan: ResponsePlan, raisedAt: Date, now: Date, alreadyTried: readonly Id[]): Id | null {
  if (now.getTime() - raisedAt.getTime() < plan.ackDeadlineMinutes * 60_000) return null;
  const chain = [plan.primary.memberId, ...(plan.backup ? [plan.backup.memberId] : []), ...plan.escalation];
  return chain.find((m) => !alreadyTried.includes(m)) ?? null;
}
