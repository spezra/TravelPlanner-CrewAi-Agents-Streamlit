/**
 * Test databases. By default each test gets a copy of a migrated, seeded
 * PGlite data directory. With TEST_DATABASE_URL set, tests run against a real
 * Postgres as a non-superuser owner, which is how production connects, so
 * forced row-level security applies to the owner too.
 */
import { afterEach, beforeEach } from "vitest";
import { createPgDb, createPgliteDb, migrate, type Db } from "@/db/client";
import { seed } from "@/db/seed";

export const NOW = new Date("2026-10-01T12:00:00Z");

let snapshot: Blob | undefined;
let pgMigrated = false;

async function freshPglite(): Promise<Db> {
  if (!snapshot) {
    const fresh = await createPgliteDb();
    await migrate(fresh);
    await seed(fresh, NOW);
    snapshot = await fresh.dump();
    await fresh.close();
  }
  return createPgliteDb({ loadDataDir: snapshot });
}

async function freshPg(url: string): Promise<Db> {
  const db = await createPgDb(url);
  if (!pgMigrated) {
    await db.query("drop schema if exists public cascade");
    await db.query("create schema public");
    await migrate(db);
    pgMigrated = true;
  } else {
    const { rows } = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'");
    await db.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`);
  }
  await seed(db, NOW);
  return db;
}

export function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  return url ? freshPg(url) : freshPglite();
}

/** Registers beforeEach/afterEach and returns an accessor for the current test's database. */
export function useDb(): () => Db {
  let db: Db | undefined;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });
  return () => {
    if (!db) throw new Error("useDb() accessor used outside a test");
    return db;
  };
}
