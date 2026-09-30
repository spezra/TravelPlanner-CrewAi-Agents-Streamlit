import { currentSession } from "@/server/auth/session";
import { acceptInviteAction } from "../actions";
import Link from "next/link";

export const metadata = { title: "Join workspace" };
export const dynamic = "force-dynamic";

export default async function Invite({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  const s = await currentSession();
  if (!token) return <p className="notice error">This invitation link is incomplete.</p>;
  const next = `/invite?token=${encodeURIComponent(token)}`;
  return (
    <main>
      <h1>Join workspace</h1>
      {error && <p className="notice error">{error}</p>}
      {!s ? (
        <p>
          <Link className="btn primary" href={`/login?next=${encodeURIComponent(next)}`}>
            Sign in with the invited email to continue
          </Link>
        </p>
      ) : (
        <form action={acceptInviteAction}>
          <input type="hidden" name="token" value={token} />
          <p className="muted">Signed in as {s.email}.</p>
          <label htmlFor="name">Your name</label>
          <input id="name" type="text" name="name" required />
          <label htmlFor="timeZone">Your time zone</label>
          <input id="timeZone" type="text" name="timeZone" defaultValue="UTC" required />
          <div className="actions">
            <button className="btn primary" type="submit">
              Accept invitation
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
