import { safeEqual } from "@/server/crypto";
import { config } from "@/server/config";
import { getDb } from "@/server/db";
import { HANDLERS, SCHEDULES } from "@/server/jobs/handlers";
import { releaseStale, runOnce } from "@/server/jobs/queue";
import { enqueueDue } from "@/server/jobs/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * For platforms without a long-running worker: a scheduler calls this with
 * `Authorization: Bearer $CRON_SECRET`. Runs due schedules and works the queue
 * for up to ~50 seconds.
 */
export async function POST(req: Request) {
  const secret = config().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return new Response("Unauthorized", { status: 401 });
  const db = await getDb();
  await enqueueDue(db, SCHEDULES);
  await releaseStale(db);
  const deadline = Date.now() + 50_000;
  let ran = 0;
  while (Date.now() < deadline && (await runOnce(db, HANDLERS))) ran++;
  return Response.json({ ran });
}
