/**
 * Registry of job handlers. Each feature module exports its handlers and
 * schedules; they're combined here so the worker and tests see one list.
 */
import * as calls from "@/modules/calls/jobs";
import * as crm from "@/modules/crm/jobs";
import * as money from "@/modules/money/jobs";
import * as network from "@/modules/network/jobs";
import * as ops from "@/modules/ops/jobs";
import * as proposals from "@/modules/proposals/jobs";
import type { JobHandler } from "./queue";
import type { Schedule } from "./scheduler";

const platform: Record<string, JobHandler> = {
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

export const HANDLERS: Record<string, JobHandler> = { ...platform, ...proposals.handlers, ...calls.handlers, ...crm.handlers, ...money.handlers, ...ops.handlers, ...network.handlers };

export const SCHEDULES: Schedule[] = [{ kind: "platform.purge_expired", everyMinutes: 60 }, ...proposals.schedules, ...calls.schedules, ...crm.schedules, ...money.schedules, ...ops.schedules, ...network.schedules];
