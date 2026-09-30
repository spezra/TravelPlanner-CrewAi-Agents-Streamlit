/** Small helpers shared by the network module's repositories. */
import type { Queryable } from "@/db/client";
import type { Role } from "@/domain/common";

export const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
export const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
export const str = (v: unknown): string | null => (v == null ? null : String(v));
export const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : typeof v === "string" ? (JSON.parse(v) as T[]) : []);

export async function memberRole(q: Queryable, memberId: string): Promise<Role | null> {
  const { rows } = await q.query<{ role: Role }>("select role from members where id = $1 and disabled_at is null", [memberId]);
  return rows[0]?.role ?? null;
}

/** `%term%` for ILIKE, with the user's own wildcards escaped. */
export const likePattern = (term: string): string => `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
