import Link from "next/link";
import type { AttentionItem } from "@/domain/attention";
import { getDb, requireMember } from "@/lib/server";
import { attentionQueue } from "@/services/operations";
import { confirmCommitment, decideApproval } from "./actions";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<AttentionItem["kind"], [string, "alert" | "warn" | "ok" | ""]> = {
  reconcile: ["Reconcile", "alert"],
  disruption: ["Disruption", "alert"],
  approval: ["Approval", "warn"],
  commitment_review: ["Check commitment", "warn"],
  commitment_overdue: ["Overdue", "alert"],
  relationship_nudge: ["Relationship", ""],
  publication: ["Share knowledge", ""],
};

function due(mins: number): string {
  if (mins <= 0) return "now";
  if (mins < 120) return `in ${mins} min`;
  if (mins < 48 * 60) return `in ${Math.round(mins / 60)} h`;
  return `in ${Math.round(mins / 1440)} days`;
}

export default async function Today({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const me = await requireMember();
  const queue = await attentionQueue(await getDb(), me.tenant, new Date());

  return (
    <main>
      <div className="eyebrow">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: me.member.timeZone })}</div>
      <h1>Today</h1>
      <p className="lede">
        {queue.length === 0 ? "Nothing needs you. Everything else is in hand." : `${queue.length} ${queue.length === 1 ? "decision needs" : "decisions need"} you. Everything else is in hand.`}
      </p>
      {error && <div className="card chip alert">{error}</div>}
      {queue.length === 0 && <p className="empty">Nothing needs you right now.</p>}
      {queue.map((it) => {
        const [label, tone] = KIND_LABEL[it.kind];
        const id = it.key.split(":")[1]!;
        return (
          <section key={it.key} className="card">
            <div className="row">
              <span className={`chip ${tone}`}>{label}</span>
              <h3 className="grow">{it.title}</h3>
              <span className="small muted">{due(it.urgencyMinutes)}</span>
            </div>
            <div className="small muted">{it.context}</div>
            <div className="rec">
              <b>Recommended:</b> {it.recommendedAction}
            </div>
            <div className="actions">
              {it.kind === "approval" && (
                <form action={decideApproval} className="actions" style={{ marginTop: 0 }}>
                  <input type="hidden" name="approvalId" value={id} />
                  <input type="hidden" name="back" value="/" />
                  <button className="btn primary" name="decision" value="approved">
                    Approve
                  </button>
                  <button className="btn" name="decision" value="rejected">
                    Reject
                  </button>
                </form>
              )}
              {it.kind === "commitment_review" && (
                <form action={confirmCommitment}>
                  <input type="hidden" name="commitmentId" value={id} />
                  <input type="hidden" name="back" value="/" />
                  <button className="btn primary">Confirm as checked</button>
                </form>
              )}
              {it.tripId && (
                <Link className="btn" href={`/trips/${it.tripId}`}>
                  Open trip
                </Link>
              )}
            </div>
          </section>
        );
      })}
    </main>
  );
}
