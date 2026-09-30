/**
 * Shared helpers for the CRM server actions: form parsing and turning expected
 * failures (domain rules, validation) into a message for the redirect back.
 */
import { safeLocalPath } from "@/lib/safePath";
import { ZodError } from "zod";
import { DomainError } from "@/domain/common";

export const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

export const optionalField = (form: FormData, name: string): string | null => field(form, name).trim() || null;

/** One per line (or comma-separated for emails). */
export const lines = (text: string, separators = /\r?\n/): string[] =>
  text
    .split(separators)
    .map((l) => l.trim())
    .filter(Boolean);

/** Only same-site relative paths, so a crafted form can't bounce the user elsewhere. */
export const safeBack = (v: string, fallback: string): string => safeLocalPath(v, fallback);

export function withParam(path: string, key: string, value: string): string {
  const [base, hash] = path.split("#");
  const sep = base!.includes("?") ? "&" : "?";
  return `${base}${sep}${key}=${encodeURIComponent(value)}${hash ? `#${hash}` : ""}`;
}

/** Expected failures become a message; anything else is a bug and propagates. */
export function expectedError(err: unknown): string {
  if (err instanceof DomainError) return err.message;
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Check the form and try again";
  throw err;
}
