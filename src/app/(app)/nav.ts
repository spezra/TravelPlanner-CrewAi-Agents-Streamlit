import type { Role } from "@/domain/common";

export interface NavEntry {
  href: string;
  label: string;
  /** Limits who sees the entry; pages enforce access themselves. */
  roles?: Role[];
}

/** The daily work, in the header. */
export const NAV: NavEntry[] = [
  { href: "/", label: "Today" },
  { href: "/inbox", label: "Inbox" },
  { href: "/trips", label: "Trips" },
  { href: "/clients", label: "Clients" },
  { href: "/people", label: "Relationships" },
  { href: "/calls", label: "Calls" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/network", label: "Network" },
  { href: "/money", label: "Money" },
];

/** Everything else, in a quieter second row. */
export const NAV_SECONDARY: NavEntry[] = [
  { href: "/commitments", label: "Commitments" },
  { href: "/collaborations", label: "Collaborations" },
  { href: "/judgment", label: "Taste model" },
  { href: "/integrations", label: "Integrations" },
  { href: "/settings", label: "Settings" },
  { href: "/admin", label: "Admin", roles: ["owner", "admin"] },
];
