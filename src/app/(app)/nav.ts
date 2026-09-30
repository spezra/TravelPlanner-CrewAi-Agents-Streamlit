import type { Role } from "@/domain/common";

/** Primary navigation. `roles` limits who sees an entry; the pages enforce access themselves. */
export const NAV: { href: string; label: string; roles?: Role[] }[] = [
  { href: "/", label: "Today" },
  { href: "/trips", label: "Trips" },
  { href: "/clients", label: "Clients" },
  { href: "/calls", label: "Calls" },
  { href: "/commitments", label: "Commitments" },
  { href: "/people", label: "Relationships" },
  { href: "/inbox", label: "Inbox" },
  { href: "/integrations", label: "Integrations", roles: ["owner", "advisor", "admin", "assistant"] },
  { href: "/judgment", label: "Taste" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/network", label: "Network" },
  { href: "/collaborations", label: "Collaborations" },
  { href: "/money", label: "Money" },
  { href: "/settings", label: "Settings" },
  { href: "/admin", label: "Admin", roles: ["owner", "admin"] },
];
