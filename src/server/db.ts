/** Process-wide database handle for the web server and the worker. */
import { mkdir } from "node:fs/promises";
import { createPgDb, createPgliteDb, migrate, type Db } from "@/db/client";
import { seed } from "@/db/seed";
import { config } from "./config";
import { log } from "./log";

const g = globalThis as unknown as { __db?: Promise<Db> };

async function open(): Promise<Db> {
  const c = config();
  if (c.DATABASE_URL) {
    const db = await createPgDb(c.DATABASE_URL);
    // Production runs migrations as a release step (npm run db:migrate); dev/test migrate on boot.
    if (c.NODE_ENV !== "production") await migrate(db);
    return db;
  }
  if (c.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
  await mkdir(".data", { recursive: true });
  const db = await createPgliteDb({ dataDir: ".data/pglite" });
  const applied = await migrate(db);
  if (applied.includes("001_init.sql")) {
    await seed(db);
    log.info("seeded demo workspace");
  }
  return db;
}

export function getDb(): Promise<Db> {
  g.__db ??= open().catch((err) => {
    g.__db = undefined;
    throw err;
  });
  return g.__db;
}
