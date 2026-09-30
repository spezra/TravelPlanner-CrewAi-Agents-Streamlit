/**
 * Money background work. Every handler is idempotent: batch execution skips
 * lines already paid and reconciles in-flight transfers before retrying;
 * Stripe events are processed once.
 */
import { withSystem } from "@/db/tenant";
import { PermanentJobError, enqueue, type JobHandler } from "@/server/jobs/queue";
import type { Schedule } from "@/server/jobs/scheduler";
import { moneyDeps, type MoneyDeps } from "./deps";
import { executeBatch } from "./payouts";
import { processStripeEvent } from "./webhook";

export function makeHandlers(deps: () => MoneyDeps, clock: () => Date = () => new Date()): Record<string, JobHandler> {
  return {
    "money.execute_batch": async ({ db, job, tenant }) => {
      const batchId = job.payload.batchId;
      if (typeof batchId !== "string") throw new PermanentJobError("money.execute_batch needs a batchId");
      // Runs as the owner who approved the batch; never with more access than that person.
      if (!tenant) throw new PermanentJobError("money.execute_batch must run as the approving owner");
      await executeBatch(db, tenant, batchId, deps(), clock());
    },
    "money.stripe_event": async ({ db, job }) => {
      const eventId = job.payload.eventId;
      if (typeof eventId !== "string") throw new PermanentJobError("money.stripe_event needs an eventId");
      await processStripeEvent(db, eventId, deps(), clock());
    },
    /** Re-drives approved batches whose execution job died (e.g. Stripe was down for longer than the retries). */
    "money.resume_batches": async ({ db }) => {
      const now = clock();
      await withSystem(db, async (q) => {
        const { rows } = await q.query<{ id: string; workspace_id: string; approved_by: string }>(
          `select b.id, b.workspace_id, b.approved_by from money_payout_batches b
            where b.status in ('approved', 'processing') and b.approved_at < $1
              and exists (select 1 from money_payout_lines l where l.batch_id = b.id and l.status in ('approved', 'sending'))`,
          [new Date(now.getTime() - 15 * 60_000).toISOString()],
        );
        const period = Math.floor(now.getTime() / 3_600_000);
        for (const b of rows) {
          await enqueue(q, {
            kind: "money.execute_batch",
            payload: { batchId: b.id },
            tenant: { workspaceId: b.workspace_id, memberId: b.approved_by },
            dedupeKey: `money.execute_batch:${b.id}:resume:${period}`,
          });
        }
      });
    },
    /** Raw Stripe payloads are only needed until processed; keep 90 days for support, then drop them. */
    "money.purge_stripe_events": async ({ db }) => {
      await withSystem(db, (q) =>
        q.query("delete from money_stripe_events where processed_at is not null and processed_at < $1", [new Date(clock().getTime() - 90 * 86_400_000).toISOString()]),
      );
    },
  };
}

export const handlers: Record<string, JobHandler> = makeHandlers(moneyDeps);

export const schedules: Schedule[] = [
  { kind: "money.resume_batches", everyMinutes: 60 },
  { kind: "money.purge_stripe_events", everyMinutes: 1440 },
];
