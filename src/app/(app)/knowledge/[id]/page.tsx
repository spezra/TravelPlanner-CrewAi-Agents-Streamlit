import Link from "next/link";
import { notFound } from "next/navigation";
import { listPeople } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { requestableScopes } from "@/domain/publication";
import { getDb, requireMember } from "@/lib/server";
import { CATEGORY_LABEL, getItem } from "@/modules/network/knowledge";
import { listObservations } from "@/modules/network/observations";
import { deleteItemAction, markReviewedAction, submitItemAction, updateItemAction, withdrawAction } from "../actions";
import { ItemForm } from "../itemForm";
import { ReviewCard } from "../reviewCard";
import { Flash, KnowledgeNav, statusChip } from "../subnav";

export const metadata = { title: "Knowledge item" };
export const dynamic = "force-dynamic";

export default async function KnowledgeItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const me = await requireMember();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const item = await getItem(q, id);
    if (!item) return null;
    const observations = (await listObservations(q)).filter((o) => o.ownerId === me.tenant.memberId || item.sourceObservationIds.includes(o.id));
    const people = (await listPeople(q)).filter((p) => p.ownerId === me.tenant.memberId || p.id === item.dependsOnPersonId);
    return { item, observations, people };
  });
  if (!data) notFound();
  const { item, observations, people } = data;
  const scopes = requestableScopes(item);
  const back = `/knowledge/${item.id}`;

  return (
    <main>
      <p className="small">
        <Link href="/knowledge">← Knowledge</Link>
      </p>
      <h1>{CATEGORY_LABEL[item.category]}</h1>
      <KnowledgeNav current="/knowledge" />
      <Flash error={error} ok={ok} />

      <div className="card">
        <div className="row">
          {statusChip(item)}
          <span className="small muted">
            Permission: {item.sharingPermission} · {item.confidentiality} · confidence {item.confidence}
          </span>
        </div>
        <p>{item.body}</p>
        {item.needsReview && (
          <form action={markReviewedAction} className="notice error">
            <input type="hidden" name="id" value={item.id} />
            Something this depends on changed (a relationship moved). It is held back from everyone until you confirm it still holds.{" "}
            <button className="btn small">It still holds</button>
          </form>
        )}
        {item.published && !item.published.withdrawnAt && (
          <form action={withdrawAction} className="row small">
            <input type="hidden" name="id" value={item.id} />
            <span className="grow">
              Published to {item.published.scope} on {item.published.publishedAt.slice(0, 10)}
              {item.published.held ? " (held back pending your review)" : ""}: “{item.candidateBody}”
            </span>
            <button className="btn">Withdraw</button>
          </form>
        )}
        {item.publicationStatus === "declined" && <p className="small muted">You kept this private{item.declineReason ? `: ${item.declineReason}` : "."}</p>}
        {item.publicationStatus === "processing" && <p className="small muted">The review agents are checking the redaction; it will come back to you or publish by your standing rule.</p>}
      </div>

      {item.publicationStatus === "awaiting_owner" && (
        <>
          <h2>Your approval</h2>
          <ReviewCard item={item} back={back} />
        </>
      )}

      {item.publicationStatus !== "processing" && item.publicationStatus !== "awaiting_owner" && (
        <>
          <h2>Publish</h2>
          {scopes.length === 0 ? (
            <p className="small muted">
              {item.confidentiality === "restricted" || item.sharingPermission === "private"
                ? "This item's permission keeps it private. Change the sharing permission below if you want to share it."
                : "Nothing to publish to."}
            </p>
          ) : (
            <form action={submitItemAction} className="card row">
              <input type="hidden" name="id" value={item.id} />
              <span className="grow small">
                Identifying details (names, contacts, room numbers, prices, links) are removed first; you see exactly what would be published before it goes,
                unless a standing rule covers it and every automated check comes back clean.
              </span>
              <select name="target" defaultValue={scopes.at(-1)} aria-label="Publish to">
                {scopes.map((s) => (
                  <option key={s} value={s}>
                    {s === "network" ? "Network" : "Workspace"}
                  </option>
                ))}
              </select>
              <button className="btn primary">Prepare to publish</button>
            </form>
          )}
        </>
      )}

      <h2>Edit</h2>
      <ItemForm
        item={item}
        action={updateItemAction}
        submitLabel="Save changes"
        observations={observations.map((o) => ({ id: o.id, label: `${o.supplierName}, ${o.observedAt}: ${o.statement.slice(0, 60)}` }))}
        people={people.map((p) => ({ id: p.id, name: p.name }))}
      />
      <form action={deleteItemAction} className="row small">
        <input type="hidden" name="id" value={item.id} />
        <span className="grow muted">Deleting also removes any published copy.</span>
        <button className="btn">Delete item</button>
      </form>
    </main>
  );
}
