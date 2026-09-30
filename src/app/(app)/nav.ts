import type { Role } from "@/domain/common";

/** Primary navigation. `roles` limits who sees an entry; the pages enforce access themselves. */
export const NAV: { href: string; label: string; roles?: Role[] }[] = [
  { href: "/", label: "Today" },
  { href: "/trips", label: "Trips" },
  { href: "/calls", label: "Calls" },
  { href: "/commitments", label: "Commitments" },
  { href: "/people", label: "Relationships" },
  { href: "/settings", label: "Settings" },
];
