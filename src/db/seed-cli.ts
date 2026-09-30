/** `npm run db:seed`: loads the demo worked trip into a freshly migrated database. */
import { mkdir } from "node:fs/promises";
import { createPgDb, createPgliteDb, migrate } from "./client";
import { seed } from "./seed";

const db = process.env.DATABASE_URL
  ? await createPgDb(process.env.DATABASE_URL)
  : await mkdir(".data", { recursive: true }).then(() => createPgliteDb({ dataDir: ".data/pglite" }));
await migrate(db);
await seed(db);
console.log("Seeded demo workspace");
await db.close();
