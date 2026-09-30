import Link from "next/link";
import { notFound } from "next/navigation";
import { getTrip } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { getMember } from "@/modules/trips/repo";
import { addItemAction } from "../../../actions";
import { ItemFields, Notices } from "../../../ui";

export const metadata = { title: "Add item" };
export const dynamic = "force-dynamic";

export default async function NewItem({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const me = await requireMember();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const trip = await getTrip(q, id);
    return trip ? { trip, tz: (await getMember(q, me.member.id))?.timeZone ?? "UTC" } : null;
  });
  if (!data) notFound();
  return (
    <main className="narrow" style={{ maxWidth: 760 }}>
      <p className="small">
        <Link href={`/trips/${data.trip.id}`}>← {data.trip.title}</Link>
      </p>
      <h1>Add item</h1>
      <p className="lede">Items start in design. Flights booked through Duffel pick their offer after saving.</p>
      <Notices error={error} />
      <form action={addItemAction} className="card">
        <input type="hidden" name="tripId" value={data.trip.id} />
        <ItemFields tz={data.tz} />
        <div className="actions">
          <button className="btn primary" type="submit">
            Add item
          </button>
          <Link className="btn" href={`/trips/${data.trip.id}`}>
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
