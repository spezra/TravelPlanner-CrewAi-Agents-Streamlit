import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { listAwaitingOwner } from "@/modules/network/knowledge";
import { ReviewCard } from "../reviewCard";
import { Flash, KnowledgeNav } from "../subnav";

export const metadata = { title: "Awaiting approval" };
export const dynamic = "force-dynamic";

export default async function ReviewQueue({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const items = await withTenant(await getDb(), me.tenant, (q) => listAwaitingOwner(q));
  return (
    <main>
      <h1>Awaiting your approval</h1>
      <p className="lede">
        Detectors and the review pass help, but neither guarantees completeness. Nothing leaves your private store until you approve it here, or a standing
        rule you set covers it and every automated check is clean.
      </p>
      <KnowledgeNav current="/knowledge/review" pending={items.length} />
      <Flash error={error} ok={ok} />
      {items.length === 0 ? <p className="empty">Nothing waiting.</p> : items.map((k) => <ReviewCard key={k.id} item={k} back="/knowledge/review" />)}
    </main>
  );
}
