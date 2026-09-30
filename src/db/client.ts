/**
 * Database access. Production uses node-postgres against DATABASE_URL. Local
 * development and tests use PGlite (Postgres compiled to WASM), so the same
 * SQL and the same row-level security run everywhere with no server to set up.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createPgliteDb(opts: { dataDir?: string; loadDataDir?: Blob | File } = {}): Promise<Db & { dump(): Promise<Blob> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(opts);
  await pg.waitReady;
  return {
    dump: () => pg.dumpDataDir("none"),
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pg.query<T>(sql, params)).rows }),
    transaction: (fn) => pg.transaction((tx) => fn({ query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await tx.query<T>(sql, params)).rows }) })),
    close: () => pg.close(),
  };
}

export async function createPgDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  // Return bigint and numeric as JS numbers; money is stored in minor units well within 2^53.
  pg.types.setTypeParser(20, (v) => Number(v));
  const pool = new pg.Pool({ connectionString });
  return {
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        // One connection runs one statement at a time; queue calls made concurrently (e.g. Promise.all) instead of overlapping them.
        let chain: Promise<unknown> = Promise.resolve();
        const query = <T>(sql: string, params?: unknown[]) => {
          const run = chain.then(async () => ({ rows: (await client.query(sql, params)).rows as T[] }));
          chain = run.catch(() => undefined);
          return run;
        };
        const out = await fn({ query });
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const MIGRATIONS_DIR = path.join(process.cwd(), "src", "db", "migrations");

/** Applies pending migrations in filename order, each in its own transaction. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), "utf8");
    await db.transaction(async (tx) => {
      for (const stmt of splitSql(sql)) await tx.query(stmt);
      await tx.query("insert into schema_migrations(name) values ($1)", [f]);
    });
    applied.push(f);
  }
  return applied;
}

/** Splits on semicolons outside dollar-quoted blocks and comments. Enough for our own migration files. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let dollar: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (!dollar && ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      buf += "\n";
      continue;
    }
    if (ch === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        if (dollar === null) dollar = m[0];
        else if (dollar === m[0]) dollar = null;
        buf += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === ";" && !dollar) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
