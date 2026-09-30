/**
 * The client address as seen by our own edge. X-Forwarded-For is a list the
 * client can prepend to, so only the entry added by the nearest trusted proxy
 * counts: with TRUSTED_PROXY_HOPS proxies in front of the app (default 1),
 * that is the hops-th entry from the right.
 */
export function clientIp(h: { get(name: string): string | null }, hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1)): string | null {
  const fwd = h.get("x-forwarded-for");
  if (fwd && hops > 0) {
    const list = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    const ip = list[list.length - hops];
    if (ip) return ip.slice(0, 64);
  }
  return h.get("x-real-ip")?.slice(0, 64) ?? null;
}
