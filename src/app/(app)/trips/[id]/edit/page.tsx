import Link from "next/link";
import { notFound } from "next/navigation";
import { getTrip } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { listClients } from "@/modules/trips/repo";
import { updateTripAction } from "../../actions";
import { Notices, TripFields } from "../../ui";

export const metadata = { title: "Edit trip" };
export const dynamic = "force-dynamic";

export default async function EditTrip({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const me = await requireMember();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const trip = await getTrip(q, id);
    return trip ? { trip, clients: await listClients(q) } : null;
  });
  if (!data) notFound();
  const { trip, clients } = data;
  const canEdit = trip.ownerId === me.member.id || me.member.role === "owner" || me.member.role === "admin";

  return (
    <main className="narrow">
      <h1>Edit trip</h1>
      <Notices error={error} />
      {!canEdit ? (
        <p className="notice">Only {trip.ownerName} (the trip owner) or a workspace owner can edit this trip.</p>
      ) : (
        <form action={updateTripAction} className="card">
          <input type="hidden" name="tripId" value={trip.id} />
          <TripFields trip={trip} clients={clients} />
          {trip.ownerId !== me.member.id && <p className="small muted">Only {trip.ownerName} can change who sees this trip.</p>}
          <div className="actions">
            <button className="btn primary" type="submit">
              Save
            </button>
            <Link className="btn" href={`/trips/${trip.id}`}>
              Cancel
            </Link>
          </div>
        </form>
      )}
    </main>
  );
}
