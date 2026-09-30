import Link from "next/link";
import { withTenant } from "@/db/tenant";
import type { CollaborationState } from "@/domain/collaboration";
import { STATE_LABEL } from "./labels";
import { CONTRIBUTION_LABEL } from "@/domain/collaborationTerms";
import { getDb, requireMember } from "@/lib/server";
import { listCollaborations, sideOf, type CollabRow } from "@/modules/network/collaborations";

export const metadata = { title: "Collaborations" };
export const dynamic = "force-dynamic";

const TONE: Partial<Record<CollaborationState, string>> = { requested: "chip warn", brief_shared: "chip warn", terms_agreed: "chip ok", active: "chip ok" };

function Table({ rows, other }: { rows: CollabRow[]; other: (c: CollabRow) => string }) {
  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>With</th>
            <th>Contribution</th>
            <th>Destination</th>
            <th>State</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/collaborations/${c.id}`}>{other(c)}</Link>
              </td>
              <td>{CONTRIBUTION_LABEL[c.contribution]}</td>
              <td>{c.destination ?? "—"}</td>
              <td>
                <span className={TONE[c.state] ?? "chip"}>{STATE_LABEL[c.state]}</span>
              </td>
              <td className="small">{c.updatedAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function Collaborations({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const rows = await withTenant(await getDb(), me.tenant, (q) => listCollaborations(q));
  const incoming = rows.filter((c) => sideOf(c, me.tenant) === "specialist");
  const outgoing = rows.filter((c) => sideOf(c, me.tenant) === "requester");
  const colleagues = rows.filter((c) => sideOf(c, me.tenant) === null);

  return (
    <main>
      <h1>Collaborations</h1>
      <p className="lede">
        Contribute at whatever level your time allows. Specialists see an anonymized brief; client details open only after both sides accept the same
        terms, and close when access expires or the work ends.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      <p className="small">
        <Link href="/network">Find a specialist in the network →</Link>
      </p>

      <h2>Asked of you</h2>
      {incoming.length === 0 ? <p className="empty">No requests.</p> : <Table rows={incoming} other={(c) => c.requesterName} />}

      <h2>You asked</h2>
      {outgoing.length === 0 ? <p className="empty">None yet.</p> : <Table rows={outgoing} other={(c) => c.specialistName} />}

      {colleagues.length > 0 && (
        <>
          <h2>On trips you can see</h2>
          <Table rows={colleagues} other={(c) => `${c.requesterName} → ${c.specialistName}`} />
        </>
      )}
    </main>
  );
}
