/**
 * Re-wrap all workspace data keys under a new master key.
 *   OLD_MASTER_KEY=<current> MASTER_KEY=<new> DATABASE_URL=... npm run keys:rotate-master
 * Deploy the new MASTER_KEY to every process immediately after this completes.
 */
import { createPgDb } from "../db/client";
import { withSystem } from "../db/tenant";
import { rewrapAllKeys } from "../server/crypto";

const { OLD_MASTER_KEY, MASTER_KEY, DATABASE_URL } = process.env;
if (!OLD_MASTER_KEY || !MASTER_KEY || !DATABASE_URL) {
  console.error("OLD_MASTER_KEY, MASTER_KEY and DATABASE_URL are required");
  process.exit(1);
}
const db = await createPgDb(DATABASE_URL);
const n = await withSystem(db, (q) => rewrapAllKeys(q, OLD_MASTER_KEY, MASTER_KEY));
console.log(`Re-wrapped ${n} data keys`);
await db.close();
