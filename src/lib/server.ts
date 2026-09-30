import "server-only";
import { mkdir } from "node:fs/promises";
import { cookies } from "next/headers";
import { createPgDb, createPgliteDb, migrate, type Db } from "@/db/client";
import { DEMO, seed } from "@/db/seed";
import type { Tenant } from "@/db/tenant";

const globalForDb = globalThis as unknown as { __db?: Promise<Db> };

async function open(): Promise<Db> {
  if (process.env.DATABASE_URL) {
    const db = await createPgDb(process.env.DATABASE_URL);
    await migrate(db);
    return db;
  }
  // Local development: embedded Postgres, seeded with the demo trip on first run.
  await mkdir(".data", { recursive: true });
  const db = await createPgliteDb({ dataDir: ".data/pglite" });
  const fresh = (await migrate(db)).length > 0;
  if (fresh) await seed(db);
  return db;
}

export function getDb(): Promise<Db> {
  globalForDb.__db ??= open();
  return globalForDb.__db;
}

/**
 * Development sign-in: pick a demo member to see what row-level security shows
 * them. Replace with real authentication before any non-demo use.
 */
export const DEV_MEMBERS: { label: string; tenant: Tenant }[] = [
  { label: "Marisol Vega — expert (owner)", tenant: { workspaceId: DEMO.workspace, memberId: DEMO.expert } },
  { label: "Diego Ortiz — assistant", tenant: { workspaceId: DEMO.workspace, memberId: DEMO.assistant } },
  { label: "Lena Brandt — named backup", tenant: { workspaceId: DEMO.workspace, memberId: DEMO.backup } },
  { label: "Camille Roux — another workspace", tenant: { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert } },
];

export async function currentTenant(): Promise<{ label: string; tenant: Tenant }> {
  const id = (await cookies()).get("member")?.value;
  return DEV_MEMBERS.find((m) => m.tenant.memberId === id) ?? DEV_MEMBERS[0]!;
}
