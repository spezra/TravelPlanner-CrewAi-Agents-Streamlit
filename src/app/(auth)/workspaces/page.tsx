import { requireSession } from "@/server/auth/session";
import { switchWorkspace } from "../actions";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Workspaces() {
  const s = await requireSession();
  if (s.memberships.length === 0) redirect("/onboarding");
  return (
    <main>
      <h1>Choose a workspace</h1>
      {s.memberships.map((m) => (
        <form key={m.memberId} action={switchWorkspace} className="card row">
          <input type="hidden" name="memberId" value={m.memberId} />
          <span className="grow">
            {m.workspaceName} <span className="chip">{m.role}</span>
          </span>
          <button className="btn primary" type="submit">
            Open
          </button>
        </form>
      ))}
    </main>
  );
}
