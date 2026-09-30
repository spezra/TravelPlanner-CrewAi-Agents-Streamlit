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
