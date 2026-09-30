/**
 * The only way to turn a user-supplied "next"/"back" value into a redirect
 * target. Accepts same-origin relative paths only: no scheme, no host, no
 * protocol-relative or backslash tricks (browsers treat "/\\evil" as
 * "//evil"), no control characters.
 */
export function safeLocalPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return fallback;
  if (!/^\/(?![/\\])/.test(value)) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  try {
    const base = "http://local.invalid";
    const u = new URL(value, base);
    if (u.origin !== base) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}
