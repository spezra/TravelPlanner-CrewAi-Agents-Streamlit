import Link from "next/link";
import { listItems, listTrips } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { summarizeTrip } from "@/domain/bookings";
import { getDb, requireMember } from "@/lib/server";
import { Notices } from "./ui";

export const metadata = { title: "Trips" };
export const dynamic = "force-dynamic";

export default async function Trips({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const trips = await withTenant(await getDb(), me.tenant, async (q) => {
    const list = await listTrips(q);
    return Promise.all(list.map(async (t) => ({ ...t, summary: summarizeTrip(await listItems(q, t.id)) })));
  });
  const canCreate = me.member.role !== "assistant";

  return (
    <main>
      <div className="row">
        <h1 className="grow">Trips</h1>
        {canCreate && (
          <Link className="btn primary" href="/trips/new">
            New trip
          </Link>
        )}
      </div>
      <p className="lede">Each booking keeps its own state; the stage is only an overview.</p>
      <Notices error={error} ok={ok} />
      {trips.length === 0 && <p className="empty">No trips visible to you.</p>}
      {trips.map((t) => (
        <Link key={t.id} href={`/trips/${t.id}`} style={{ textDecoration: "none" }}>
          <section className="card">
            <div className="row">
              <h3 className="grow">{t.title}</h3>
              <span className={`chip ${t.summary.stage === "attention" ? "alert" : t.summary.stage === "approvals" ? "warn" : t.summary.stage === "booked" ? "ok" : ""}`}>
                {t.summary.stage}
              </span>
              {t.scope === "private" && <span className="chip">private</span>}
              {t.ownerId !== me.member.id && t.scope === "private" && <span className="chip warn">delegated to you</span>}
            </div>
            <div className="small muted">
              {t.clientName ?? "No client"} · {t.startsOn ?? "dates open"}
              {t.endsOn ? ` → ${t.endsOn}` : ""} · owner {t.ownerName} ·{" "}
              {Object.entries(t.summary.counts)
                .map(([s, n]) => `${n} ${s.replace(/_/g, " ")}`)
                .join(", ") || "no items"}
            </div>
          </section>
        </Link>
      ))}
    </main>
  );
}
