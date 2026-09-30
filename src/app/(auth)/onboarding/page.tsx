import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { createWorkspaceAction } from "../actions";

export const metadata = { title: "Set up your workspace" };
export const dynamic = "force-dynamic";

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const s = await requireSession();
  if (s.member) redirect("/");
  return (
    <main>
      <h1>Set up your workspace</h1>
      <p className="lede">A solo expert is a workspace of one. You can invite your assistant or operations team later.</p>
      {error && <p className="notice error">{error}</p>}
      <form action={createWorkspaceAction}>
        <label htmlFor="memberName">Your name</label>
        <input id="memberName" type="text" name="memberName" required />
        <label htmlFor="workspaceName">Workspace (your practice or agency)</label>
        <input id="workspaceName" type="text" name="workspaceName" required />
        <label htmlFor="timeZone">Your time zone (IANA, e.g. America/Mexico_City)</label>
        <input id="timeZone" type="text" name="timeZone" defaultValue="UTC" required />
        <label htmlFor="portability">Book portability — agreed now, not at exit</label>
        <select id="portability" name="portability" className="field" defaultValue="advisor_owns">
          <option value="advisor_owns">Advisors own their client book</option>
          <option value="agency_owns">The agency owns the client book</option>
          <option value="shared">Shared, per the written agreement</option>
        </select>
        <div className="actions">
          <button className="btn primary" type="submit">
            Create workspace
          </button>
        </div>
      </form>
    </main>
  );
}
