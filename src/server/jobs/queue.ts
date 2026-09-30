/**
 * Postgres-backed job queue. Claims with FOR UPDATE SKIP LOCKED so any number
 * of workers can run; retries with exponential backoff; a job that exhausts
 * its attempts goes to 'dead' and shows up in the ops view. Handlers must be
 * idempotent, since a worker can die after doing the work but before marking
 * it done.
 */
import os from "node:os";
import type { Db, Queryable } from "@/db/client";
import { withSystem, type Tenant } from "@/db/tenant";
import { log } from "../log";

export interface JobRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  workspaceId: string | null;
  memberId: string | null;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueInput {
  kind: string;
  payload?: Record<string, unknown>;
  tenant?: Tenant | null;
  /** Same key => enqueued once. Use for "one per record" or "one per schedule period" work. */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/** Enqueue inside the caller's transaction, so the job exists iff the work that produced it committed. */
export async function enqueue(q: Queryable, job: EnqueueInput): Promise<void> {
  await q.query(
    `insert into jobs (kind, payload, workspace_id, member_id, dedupe_key, run_at, max_attempts)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (dedupe_key) do nothing`,
    [
      job.kind,
      JSON.stringify(job.payload ?? {}),
      job.tenant?.workspaceId ?? null,
      job.tenant?.memberId ?? null,
      job.dedupeKey ?? null,
      (job.runAt ?? new Date()).toISOString(),
      job.maxAttempts ?? 8,
    ],
  );
}

/**
 * Tenant tables allow app_user only through RLS, and jobs is platform-only, so
 * tenant code enqueues through this security-definer function.
 */
export async function enqueueAsTenant(q: Queryable, job: Omit<EnqueueInput, "tenant">): Promise<void> {
  await q.query("select enqueue_job($1, $2, $3, $4, $5)", [
    job.kind,
    JSON.stringify(job.payload ?? {}),
    job.dedupeKey ?? null,
    (job.runAt ?? new Date()).toISOString(),
    job.maxAttempts ?? 8,
  ]);
}

export type JobHandler = (ctx: { db: Db; job: JobRow; tenant: Tenant | null }) => Promise<void>;

export class PermanentJobError extends Error {}

const backoffSeconds = (attempt: number) => Math.min(3600, 2 ** attempt * 5);

export async function claim(db: Db, workerId: string, now = new Date()): Promise<JobRow | null> {
  return withSystem(db, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>(
      `update jobs set status = 'running', locked_at = $1, locked_by = $2, attempts = attempts + 1
        -- JS clocks have millisecond precision and Postgres microsecond: a job scheduled with now() in SQL during the
        -- same millisecond as $1 would otherwise look up to 999µs in the future.
        where id = (select id from jobs where status = 'queued' and run_at < $1::timestamptz + interval '1 millisecond' order by run_at, id for update skip locked limit 1)
        returning id, kind, payload, workspace_id, member_id, attempts, max_attempts`,
      [now.toISOString(), workerId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      kind: String(r.kind),
      payload: (r.payload ?? {}) as Record<string, unknown>,
      workspaceId: r.workspace_id ? String(r.workspace_id) : null,
      memberId: r.member_id ? String(r.member_id) : null,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
    };
  });
}

export async function complete(db: Db, id: number, now = new Date()): Promise<void> {
  await withSystem(db, (q) => q.query("update jobs set status = 'done', finished_at = $2, locked_at = null, last_error = null where id = $1", [id, now.toISOString()]));
}

export async function fail(db: Db, job: JobRow, err: unknown, now = new Date()): Promise<"retry" | "dead"> {
  const message = err instanceof Error ? err.message : String(err);
  const permanent = err instanceof PermanentJobError;
  const dead = permanent || job.attempts >= job.maxAttempts;
  await withSystem(db, (q) =>
    q.query("update jobs set status = $2, run_at = $3, locked_at = null, last_error = $4, finished_at = $5 where id = $1", [
      job.id,
      dead ? "dead" : "queued",
      new Date(now.getTime() + backoffSeconds(job.attempts) * 1000).toISOString(),
      message.slice(0, 2000),
      dead ? now.toISOString() : null,
    ]),
  );
  return dead ? "dead" : "retry";
}

/** Jobs stuck in 'running' past the lease (worker crashed) go back to the queue. */
export async function releaseStale(db: Db, leaseSeconds = 900, now = new Date()): Promise<number> {
  const { rows } = await withSystem(db, (q) =>
    q.query("update jobs set status = 'queued', locked_at = null where status = 'running' and locked_at < $1 returning id", [
      new Date(now.getTime() - leaseSeconds * 1000).toISOString(),
    ]),
  );
  return rows.length;
}

/** Run one job if one is ready. Returns false when the queue is empty. */
export async function runOnce(db: Db, handlers: Record<string, JobHandler>, workerId = `${os.hostname()}:${process.pid}`): Promise<boolean> {
  const job = await claim(db, workerId);
  if (!job) return false;
  const handler = handlers[job.kind];
  const started = Date.now();
  try {
    if (!handler) throw new PermanentJobError(`No handler for job kind ${job.kind}`);
    const tenant = job.workspaceId && job.memberId ? { workspaceId: job.workspaceId, memberId: job.memberId } : null;
    await handler({ db, job, tenant });
    await complete(db, job.id);
    log.info({ jobId: job.id, kind: job.kind, ms: Date.now() - started }, "job done");
  } catch (err) {
    const outcome = await fail(db, job, err);
    log.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, outcome, err: err instanceof Error ? err.message : String(err) }, "job failed");
  }
  return true;
}

/** Drain the queue (tests, cron-triggered runs). */
export async function drain(db: Db, handlers: Record<string, JobHandler>, max = 1000): Promise<number> {
  let n = 0;
  while (n < max && (await runOnce(db, handlers))) n++;
  return n;
}
