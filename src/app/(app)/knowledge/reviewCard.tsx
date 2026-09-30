import { CATEGORY_LABEL, type KnowledgeRow } from "@/modules/network/knowledge";
import { approveAction, declineAction } from "./actions";

/**
 * One item awaiting the owner: the private source next to exactly what would
 * be published, what the detectors and the review removed, and why it is
 * here. The owner may edit the redacted text; edits are held to the source.
 */
export function ReviewCard({ item, back }: { item: KnowledgeRow; back: string }) {
  const llm = item.sourceCheck?.llm ?? null;
  const det = item.sourceCheck?.deterministic ?? null;
  return (
    <section className="card">
      <div className="row">
        <b>{CATEGORY_LABEL[item.category]}</b>
        {item.destination && <span className="muted">{item.destination}</span>}
        <span className="grow" />
        <span className="chip warn">to {item.targetScope === "network" ? "the network" : "your workspace"}</span>
      </div>
      <div className="grid2" style={{ marginTop: 8 }}>
        <div>
          <div className="small muted">Your source (stays private)</div>
          <p className="small">{item.body}</p>
        </div>
        <div>
          <div className="small muted">What would be published</div>
          <p className="small">{item.candidateBody}</p>
        </div>
      </div>
      {item.holdReasons.length > 0 && (
        <ul className="small">
          {item.holdReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="small muted">
        {/* Counts only, and names counted together: listing matched words would tell the author which of them are a colleague's private contacts or clients. */}
        Removed: {item.redactionFindings.length ? summarizeFindings(item.redactionFindings) : "nothing"}
        {item.reviewFlags.length > 0 && <> · Review flagged: {item.reviewFlags.map((f) => `${f.kind.replace(/_/g, " ")} “${f.span}” (${f.reason})`).join("; ")}</>}
      </div>
      <div className="small muted">
        Source check: {det ? (det.ok ? "adds nothing, keeps every qualifier" : det.issues.join("; ")) : "not run"}
        {llm ? ` · review: ${llm.consistent ? "consistent with the source" : llm.issues.join("; ")}` : " · review: you confirm it still says what your source says"}
      </div>
      <form action={approveAction}>
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="back" value={back} />
        <label htmlFor={`text-${item.id}`}>Edit before publishing (optional: you may only remove or reorder, not add)</label>
        <textarea id={`text-${item.id}`} name="text" defaultValue={item.candidateBody ?? ""} style={{ minHeight: 80 }} />
        <div className="actions">
          <button className="btn primary">Approve and publish</button>
        </div>
      </form>
      <form action={declineAction} className="row" style={{ marginTop: 8 }}>
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="back" value={back} />
        <input type="text" name="reason" placeholder="Why keep it private? (optional, for you)" className="grow" style={{ width: "auto" }} />
        <button className="btn">Keep private</button>
      </form>
    </section>
  );
}

function summarizeFindings(findings: readonly { kind: string }[]): string {
  const label: Record<string, string> = { person: "name", client: "name", member: "name", email: "email", url: "link", phone: "phone number", price: "amount", figure: "figure", room: "room number", flagged: "flagged detail" };
  const counts = new Map<string, number>();
  for (const f of findings) {
    const l = label[f.kind] ?? "detail";
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts].map(([l, n]) => `${n} ${l}${n === 1 ? "" : "s"}`).join(", ");
}
