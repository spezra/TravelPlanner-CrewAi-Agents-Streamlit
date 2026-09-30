import type { Db } from "@/db/client";
import { withSystem } from "@/db/tenant";
import { enqueue } from "./queue";

export interface Schedule {
  kind: string;
  everyMinutes: number;
}

/**
 * Enqueue each schedule once per period. The dedupe key makes this safe to
 * call from every worker and from the cron endpoint at the same time.
 */
export async function enqueueDue(db: Db, schedules: readonly Schedule[], now = new Date()): Promise<void> {
  await withSystem(db, async (q) => {
    for (const s of schedules) {
      const period = Math.floor(now.getTime() / (s.everyMinutes * 60_000));
      await enqueue(q, { kind: s.kind, dedupeKey: `sched:${s.kind}:${period}`, maxAttempts: 3 });
    }
  });
}
