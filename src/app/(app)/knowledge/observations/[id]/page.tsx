import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { getObservation } from "@/modules/network/observations";
import { deleteObservationAction, updateObservationAction } from "../../actions";
import { ObservationForm } from "../../observationForm";
import { Flash, KnowledgeNav } from "../../subnav";

export const metadata = { title: "Observation" };
export const dynamic = "force-dynamic";

export default async function ObservationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const me = await requireMember();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const obs = await withTenant(await getDb(), me.tenant, (q) => getObservation(q, id));
  if (!obs) notFound();
  const mine = obs.ownerId === me.tenant.memberId;
  return (
    <main>
      <p className="small">
        <Link href={`/knowledge/suppliers?s=${encodeURIComponent(obs.supplierName)}`}>← {obs.supplierName}</Link>
      </p>
      <h1>Observation</h1>
      <KnowledgeNav current="/knowledge/suppliers" />
      <Flash error={error} ok={ok} />
      {obs.hasPhoto && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/knowledge/photos/${obs.id}`} alt="Observation photo" style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 6 }} />
      )}
      {mine ? (
        <>
          <ObservationForm obs={obs} action={updateObservationAction} submitLabel="Save changes" back={`/knowledge/observations/${obs.id}`} today={new Date().toISOString().slice(0, 10)} />
          <form action={deleteObservationAction} className="row small">
            <input type="hidden" name="id" value={obs.id} />
            <span className="grow muted">Deleting removes the observation and its photo.</span>
            <button className="btn">Delete observation</button>
          </form>
        </>
      ) : (
        <div className="card">
          <p>{obs.statement}</p>
          <p className="small muted">Recorded by {obs.ownerName}. Only they can change it.</p>
        </div>
      )}
    </main>
  );
}
