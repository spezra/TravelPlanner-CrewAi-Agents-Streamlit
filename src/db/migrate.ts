/** `npm run db:migrate`: applies migrations to DATABASE_URL, or to the local PGlite store. */
import { mkdir } from "node:fs/promises";
import { createPgDb, createPgliteDb, migrate } from "./client";

const db = process.env.DATABASE_URL
  ? await createPgDb(process.env.DATABASE_URL)
  : await mkdir(".data", { recursive: true }).then(() => createPgliteDb({ dataDir: ".data/pglite" }));
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date");
await db.close();
