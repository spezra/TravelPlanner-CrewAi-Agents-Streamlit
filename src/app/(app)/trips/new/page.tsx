import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { listClients } from "@/modules/trips/repo";
import { createTripAction } from "../actions";
import { Notices, TripFields } from "../ui";

export const metadata = { title: "New trip" };
export const dynamic = "force-dynamic";

export default async function NewTrip({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const me = await requireMember(["owner", "advisor", "admin"]);
  const clients = await withTenant(await getDb(), me.tenant, (q) => listClients(q));
  return (
    <main className="narrow">
      <h1>New trip</h1>
      <p className="lede">You'll own it: the relationships, the taste decisions and every money decision on it.</p>
      <Notices error={error} />
      <form action={createTripAction} className="card">
        <TripFields clients={clients} />
        <div className="actions">
          <button className="btn primary" type="submit">
            Create trip
          </button>
          <Link className="btn" href="/trips">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
