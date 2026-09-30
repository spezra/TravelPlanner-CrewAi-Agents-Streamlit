import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";
import { requireMember } from "@/server/auth/session";
import { signOut, switchWorkspace } from "../(auth)/actions";
import { NAV, NAV_SECONDARY } from "./nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, member } = await requireMember();
  const visible = <T extends { roles?: string[] }>(n: T) => !n.roles || n.roles.includes(member.role);
  return (
    <div className="shell">
      <div className="utility">
        <nav className="subnav" aria-label="More">
          {NAV_SECONDARY.filter(visible).map((n) => (
            <Link key={n.href} href={n.href}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="who">
          {session.memberships.length > 1 ? (
            <form action={switchWorkspace} className="who" style={{ margin: 0 }}>
              <select name="memberId" defaultValue={member.id} aria-label="Workspace">
                {session.memberships.map((m) => (
                  <option key={m.memberId} value={m.memberId}>
                    {m.workspaceName}
                  </option>
                ))}
              </select>
              <button className="linklike" type="submit">
                Switch
              </button>
            </form>
          ) : (
            <span>{member.workspaceName}</span>
          )}
          <span>
            {member.name} · {member.role}
          </span>
          <form action={signOut}>
            <button className="linklike" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>
      <header className="top">
        <Link className="brand" href="/">
          {BRAND_NAME}
        </Link>
        <nav className="nav" aria-label="Primary">
          {NAV.filter(visible).map((n) => (
            <Link key={n.href} href={n.href}>
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
