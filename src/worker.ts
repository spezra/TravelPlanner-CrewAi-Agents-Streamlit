/**
 * Background worker: `npm run worker`. Run one or more alongside the web
 * process. Handles SIGTERM by finishing the current job and exiting.
 */
import { config } from "./server/config";
import { getDb } from "./server/db";
import { HANDLERS, SCHEDULES } from "./server/jobs/handlers";
import { releaseStale, runOnce } from "./server/jobs/queue";
import { enqueueDue } from "./server/jobs/scheduler";
import { log } from "./server/log";

config();
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = await getDb();
  log.info("worker started");
  let lastHousekeeping = 0;
  while (!stopping) {
    if (Date.now() - lastHousekeeping > 60_000) {
      lastHousekeeping = Date.now();
      await enqueueDue(db, SCHEDULES).catch((err) => log.error({ err: String(err) }, "scheduler failed"));
      const released = await releaseStale(db).catch(() => 0);
      if (released) log.warn({ released }, "released stale jobs");
    }
    const worked = await runOnce(db, HANDLERS).catch((err) => {
      log.error({ err: String(err) }, "worker loop error");
      return false;
    });
    if (!worked) await sleep(1000);
  }
  log.info("worker stopped");
  await db.close();
}

void main();
