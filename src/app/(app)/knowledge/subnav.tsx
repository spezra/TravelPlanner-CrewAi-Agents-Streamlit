import Link from "next/link";
import type { KnowledgeRow } from "@/modules/network/knowledge";

const LINKS = [
  { href: "/knowledge", label: "My knowledge" },
  { href: "/knowledge/review", label: "Awaiting approval" },
  { href: "/knowledge/suppliers", label: "Suppliers" },
  { href: "/knowledge/rules", label: "Standing rules" },
] as const;

export function KnowledgeNav({ current, pending }: { current: (typeof LINKS)[number]["href"]; pending?: number }) {
  return (
    <p className="row small">
      {LINKS.map((l) =>
        l.href === current ? (
          <b key={l.href}>{l.label}</b>
        ) : (
          <Link key={l.href} href={l.href}>
            {l.label}
            {l.href === "/knowledge/review" && pending ? ` (${pending})` : ""}
          </Link>
        ),
      )}
    </p>
  );
}

export function Flash({ error, ok }: { error?: string; ok?: string }) {
  return (
    <>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
    </>
  );
}

export function statusChip(k: KnowledgeRow) {
  if (k.needsReview) return <span className="chip alert">needs review</span>;
  switch (k.publicationStatus) {
    case "published":
      return <span className="chip ok">published · {k.publishedScope}</span>;
    case "awaiting_owner":
      return <span className="chip warn">awaiting your approval</span>;
    case "processing":
      return <span className="chip warn">being reviewed</span>;
    case "declined":
      return <span className="chip">kept private</span>;
    default:
      return <span className="chip">private draft</span>;
  }
}
