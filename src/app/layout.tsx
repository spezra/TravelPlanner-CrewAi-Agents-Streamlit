import type { Metadata } from "next";
import Link from "next/link";
import { currentTenant, DEV_MEMBERS } from "@/lib/server";
import { switchMember } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Travel Platform",
  description: "Operating environment for luxury travel experts: agents do the work, experts keep the judgment.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const me = await currentTenant();
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="top">
            <Link className="brand" href="/">
              Travel Platform
            </Link>
            <nav className="nav">
              <Link href="/">Today</Link>
              <Link href="/trips">Trips</Link>
              <Link href="/people">Relationships</Link>
            </nav>
            <form className="who" action={switchMember}>
              <span>Dev sign-in</span>
              <select name="member" defaultValue={me.tenant.memberId}>
                {DEV_MEMBERS.map((m) => (
                  <option key={m.tenant.memberId} value={m.tenant.memberId}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button className="btn" type="submit">
                Switch
              </button>
            </form>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
