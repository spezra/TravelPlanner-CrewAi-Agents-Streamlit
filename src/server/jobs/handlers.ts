/**
 * Registry of job handlers. Each feature module exports its handlers and
 * schedules; they're combined here so the worker and tests see one list.
 */
import type { JobHandler } from "./queue";
import type { Schedule } from "./scheduler";

export const HANDLERS: Record<string, JobHandler> = {
  "platform.purge_expired": async ({ db }) => {
    const { withSystem } = await import("@/db/tenant");
    await withSystem(db, async (q) => {
      await q.query("delete from login_tokens where expires_at < now() - interval '1 day'");
      await q.query("delete from sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'");
      await q.query("delete from rate_limits where window_start < now() - interval '1 day'");
      await q.query("delete from jobs where status = 'done' and finished_at < now() - interval '14 days'");
    });
  },
};

export const SCHEDULES: Schedule[] = [{ kind: "platform.purge_expired", everyMinutes: 60 }];
