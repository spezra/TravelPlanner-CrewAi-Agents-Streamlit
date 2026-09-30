import type { Queryable } from "@/db/client";

/**
 * Fixed-window counter in Postgres, so limits hold across instances.
 * Call inside withSystem. Returns false once the bucket is over its limit.
 */
export async function hit(q: Queryable, bucket: string, limit: number, windowSeconds: number, now = new Date()): Promise<boolean> {
  const start = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const { rows } = await q.query<{ hits: number }>(
    `insert into rate_limits (bucket, window_start, hits) values ($1, $2, 1)
     on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1 returning hits`,
    [bucket, start.toISOString()],
  );
  return (rows[0]?.hits ?? 0) <= limit;
}

/**
 * Throws when a member or workspace exceeds a limit on something that makes
 * the platform send email or create accounts (abuse and sender-reputation
 * protection). Runs in its own system transaction.
 */
export async function enforceLimit(
  db: import("@/db/client").Db,
  limits: readonly { bucket: string; limit: number; windowSeconds: number }[],
  message = "You've reached the limit for this for now. Try again later.",
  now = new Date(),
): Promise<void> {
  const { withSystem } = await import("@/db/tenant");
  const { DomainError } = await import("@/domain/common");
  const ok = await withSystem(db, async (q) => {
    let all = true;
    for (const l of limits) all = (await hit(q, l.bucket, l.limit, l.windowSeconds, now)) && all;
    return all;
  });
  if (!ok) throw new DomainError("rate_limited", message);
}
