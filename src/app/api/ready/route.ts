import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

/** Readiness: the database answers and migrations have been applied. */
export async function GET() {
  try {
    const db = await getDb();
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from schema_migrations");
    return Response.json({ ok: true, migrations: rows[0]?.n ?? 0 });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
