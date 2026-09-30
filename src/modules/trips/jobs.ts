/**
 * Background jobs for trip execution. Every handler is idempotent: running a
 * job twice never books twice, because the item state machine and the
 * attempt's idempotency key decide what happens, not the job.
 *
 *  trips.book            book an approved item (or recover/reconcile one already sent)
 *  trips.cancel          cancel a booking held with a supplier, under an approval
 *  trips.reconcile       resolve outcome-unknown bookings and cancellations
 *  trips.reconcile_sweep (scheduled) queue reconciliation for API-rail attempts left
 *                        unknown or interrupted, and prune old webhook receipts
 */
import { DomainError } from "@/domain/common";
import { withSystem } from "@/db/tenant";
import { enqueue, PermanentJobError, type JobHandler } from "@/server/jobs/queue";
import type { Schedule } from "@/server/jobs/scheduler";
import { log } from "@/server/log";
import { runBooking, runCancellation, runReconcile, STALE_ATTEMPT_MINUTES, type TermsConfirmation } from "./execution";
import type { ProviderDeps } from "./providers";

export interface JobDeps {
  duffel?: ProviderDeps["duffel"];
  override?: ProviderDeps["override"];
  now?: () => Date;
}

function payloadOf(job: { payload: Record<string, unknown> }): { itemId: string; termsConfirmation: TermsConfirmation | null } {
  const itemId = job.payload.itemId;
  if (typeof itemId !== "string" || !/^[0-9a-f-]{36}$/i.test(itemId)) throw new PermanentJobError("payload.itemId must be a uuid");
  const tc = job.payload.termsConfirmation as TermsConfirmation | null | undefined;
  return { itemId, termsConfirmation: tc && typeof tc.by === "string" && typeof tc.at === "string" ? tc : null };
}

/** Domain refusals (not found, not allowed) won't change on retry. */
async function permanentOnDomainError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError) throw new PermanentJobError(err.message);
    throw err;
  }
}

export function makeHandlers(deps: JobDeps = {}): Record<string, JobHandler> {
  const now = () => (deps.now ?? (() => new Date()))();
  return {
    "trips.book": async ({ db, job, tenant }) => {
      if (!tenant) throw new PermanentJobError("trips.book needs a tenant");
      const p = payloadOf(job);
      const r = await permanentOnDomainError(() => runBooking(db, tenant, p, { db, tenant, duffel: deps.duffel, override: deps.override }, now()));
      log.info({ jobId: job.id, status: r.status }, "trips.book");
    },
    "trips.cancel": async ({ db, job, tenant }) => {
      if (!tenant) throw new PermanentJobError("trips.cancel needs a tenant");
      const p = payloadOf(job);
      const r = await permanentOnDomainError(() => runCancellation(db, tenant, p, { db, tenant, duffel: deps.duffel, override: deps.override }, now()));
      log.info({ jobId: job.id, status: r.status }, "trips.cancel");
    },
    "trips.reconcile": async ({ db, job, tenant }) => {
      if (!tenant) throw new PermanentJobError("trips.reconcile needs a tenant");
      const { itemId } = payloadOf(job);
      const r = await permanentOnDomainError(() => runReconcile(db, tenant, itemId, { db, tenant, duffel: deps.duffel, override: deps.override }, now()));
      log.info({ jobId: job.id, status: r.status }, "trips.reconcile");
    },
    "trips.reconcile_sweep": async ({ db }) => {
      const at = now();
      const stale = new Date(at.getTime() - STALE_ATTEMPT_MINUTES * 60_000).toISOString();
      const period = Math.floor(at.getTime() / (30 * 60_000));
      await withSystem(db, async (q) => {
        // Manual (no-API) attempts wait for a person; only API rails and interrupted workers are swept.
        const { rows } = await q.query<{ id: string; workspace_id: string; owner_id: string }>(
          `select distinct i.id, i.workspace_id, t.owner_id
             from trip_items i
             join trips t on t.id = i.trip_id
             join members m on m.id = t.owner_id and m.disabled_at is null
             join execution_attempts a on a.item_id = i.id
            where (i.state = 'outcome_unknown' and a.state = 'outcome_unknown' and a.provider <> 'manual')
               or (i.state = 'booking' and a.action = 'book' and a.state in ('prepared', 'sent') and a.updated_at < $1)
               or (i.state = 'cancel_requested' and a.action = 'cancel' and a.provider <> 'manual'
                   and (a.state = 'outcome_unknown' or (a.state in ('prepared', 'sent') and a.updated_at < $1)))`,
          [stale],
        );
        for (const r of rows) {
          await enqueue(q, {
            kind: "trips.reconcile",
            payload: { itemId: String(r.id) },
            tenant: { workspaceId: String(r.workspace_id), memberId: String(r.owner_id) },
            dedupeKey: `trips.reconcile:${r.id}:sweep:${period}`,
            maxAttempts: 3,
          });
        }
        await q.query("delete from provider_webhook_events where received_at < $1", [new Date(at.getTime() - 30 * 86_400_000).toISOString()]);
      });
    },
  };
}

export const handlers: Record<string, JobHandler> = makeHandlers();

export const schedules: Schedule[] = [{ kind: "trips.reconcile_sweep", everyMinutes: 30 }];
