import Link from "next/link";

const LINKS = [
  { href: "/admin", label: "Settings" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/jobs", label: "Failed jobs" },
  { href: "/admin/exports", label: "Data export" },
  { href: "/admin/privacy", label: "Data-subject requests" },
  { href: "/admin/delete", label: "Delete workspace" },
];

export function AdminNav({ current }: { current: string }) {
  return (
    <nav className="row small" style={{ marginBottom: 16 }} aria-label="Admin">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={l.href === current ? "" : "muted"} aria-current={l.href === current ? "page" : undefined}>
          {l.href === current ? <b>{l.label}</b> : l.label}
        </Link>
      ))}
    </nav>
  );
}
