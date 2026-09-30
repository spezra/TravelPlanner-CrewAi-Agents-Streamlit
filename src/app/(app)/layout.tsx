import Link from "next/link";
import { requireMember } from "@/server/auth/session";
import { signOut, switchWorkspace } from "../(auth)/actions";
import { NAV } from "./nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, member } = await requireMember();
  return (
    <div className="shell">
      <header className="top">
        <Link className="brand" href="/">
          Travel Platform
        </Link>
        <nav className="nav">
          {NAV.filter((n) => !n.roles || n.roles.includes(member.role)).map((n) => (
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
              <button className="btn" type="submit">
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
            <button className="btn" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
