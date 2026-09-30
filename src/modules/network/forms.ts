/**
 * Form parsing and error redirects shared by the knowledge, network and
 * collaboration server actions.
 */
import "server-only";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/common";

/** Only same-site relative paths; anything else falls back. */
export function safeBack(value: FormDataEntryValue | null, fallback: string): string {
  const v = typeof value === "string" ? value : "";
  return v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : fallback;
}

export function withParam(path: string, key: string, value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

/** Expected failures go back to the page as ?error=; anything else is a real error. */
export function fail(back: string, err: unknown): never {
  if (err instanceof DomainError) redirect(withParam(back, "error", err.message));
  if (err instanceof z.ZodError) redirect(withParam(back, "error", err.issues.map((i) => i.message).join("; ")));
  throw err;
}

export const text = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};
export const optional = (form: FormData, key: string): string | null => text(form, key).trim() || null;
export const checked = (form: FormData, key: string): boolean => form.get(key) === "on" || form.get(key) === "true";
export const lines = (form: FormData, key: string): string[] =>
  text(form, key)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 50);

export const uuid = z.string().uuid("Invalid reference");

/** Fee lines offered on the collaboration terms form. */
export const FEE_ROWS = 4;

/** Minor-unit precision of a currency (2 for USD, 0 for JPY). */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
