/**
 * Server-action plumbing for the ops pages: parse form input with zod, run
 * the service, and redirect back with ?error= for anything the member can fix.
 */
import "server-only";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/common";

/** A local path to return to; anything else falls back. */
export function backPath(form: FormData, fallback: string): string {
  const b = String(form.get("back") ?? "");
  return b.startsWith("/") && !b.startsWith("//") && !b.includes("\\") ? b : fallback;
}

const withParam = (path: string, key: string, value: string) => `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

/**
 * Runs `fn`; DomainErrors and invalid input go back to the page as ?error=,
 * anything else is a real failure and propagates. On success, revalidates and
 * redirects to `to` (default: back) with an optional ?ok= message.
 */
export async function act<T>(back: string, fn: () => Promise<T>, opts: { ok?: string; to?: string | ((result: T) => string); revalidate?: string[] } = {}): Promise<never> {
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof DomainError) redirect(withParam(back, "error", err.message));
    if (err instanceof z.ZodError) redirect(withParam(back, "error", err.issues.map((i) => i.message).join("; ")));
    throw err;
  }
  for (const p of opts.revalidate ?? [back.split("?")[0]!]) revalidatePath(p);
  const to = typeof opts.to === "function" ? opts.to(result) : (opts.to ?? back);
  redirect(opts.ok ? withParam(to, "ok", opts.ok) : to);
}

/** Form values as a plain object for zod (checkbox groups as arrays). */
export function formObject(form: FormData, arrays: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(form.keys())) {
    out[key] = arrays.includes(key) ? form.getAll(key).map(String) : String(form.get(key) ?? "");
  }
  for (const key of arrays) out[key] ??= [];
  return out;
}

export const uuid = z.string().uuid("Invalid reference");
export const optionalText = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null));
export const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .pipe(z.string().uuid("Invalid reference").nullable());
