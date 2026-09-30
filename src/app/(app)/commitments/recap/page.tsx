import Link from "next/link";
import { DomainError } from "@/domain/common";
import { evidenceLabel } from "@/domain/commitments";
import { getDb, requireMember } from "@/lib/server";
import { prepareRecap, type RecapDraft } from "@/modules/calls/commitments";
import { defaultDeps } from "@/modules/calls/deps";
import { sendRecapAction } from "../actions";

export const metadata = { title: "Recap" };
export const dynamic = "force-dynamic";

export default async function RecapPage({ searchParams }: { searchParams: Promise<{ ids?: string | string[]; error?: string }> }) {
  const sp = await searchParams;
  const ids = [...new Set((Array.isArray(sp.ids) ? sp.ids : sp.ids ? [sp.ids] : []).filter((i) => /^[0-9a-f-]{36}$/.test(i)))].slice(0, 50);
  const me = await requireMember();
  let draft: RecapDraft | null = null;
  let problem: string | null = null;
  try {
    draft = await prepareRecap(await getDb(), me.tenant, defaultDeps().llm, ids);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    problem = err.message;
  }

  return (
    <main className="narrow">
      <p className="small">
        <Link href="/commitments">← Commitments</Link>
      </p>
      <h1>Recap to the supplier</h1>
      <p className="lede">
        A written recap records our understanding, not the supplier&apos;s agreement. It goes out labeled as coming from the agency&apos;s system. Edit it before
        sending.
      </p>
      {sp.error && <p className="notice error">{sp.error}</p>}
      {problem && <p className="notice error">{problem}</p>}
      {draft && (
        <>
          {draft.agentError && <p className="notice">The agent couldn&apos;t draft this ({draft.agentError}); a plain template is below.</p>}
          {draft.drafted === "template" && !draft.agentError && <p className="small muted">Agents aren&apos;t configured; a plain template is below.</p>}
          <section className="card small">
            <b>Covers</b>
            <ul className="plain">
              {draft.context.commitments.map((c) => (
                <li key={c.id}>
                  {c.promisor}: {c.promise} <span className="muted">· {evidenceLabel(c)}</span>
                  {c.recapSentAt && <span className="chip">recap already sent {c.recapSentAt.slice(0, 10)}</span>}
                </li>
              ))}
            </ul>
          </section>
          <form action={sendRecapAction} className="card">
            {draft.ids.map((id) => (
              <input key={id} type="hidden" name="ids" value={id} />
            ))}
            <label htmlFor="to">To{draft.context.supplierName ? ` (${draft.context.supplierName})` : ""}</label>
            <input id="to" name="to" type="email" required maxLength={320} />
            <label htmlFor="subject">Subject</label>
            <input id="subject" name="subject" type="text" required maxLength={300} defaultValue={draft.subject} />
            <label>Added above your text, always</label>
            <p className="notice small" style={{ margin: 0 }}>
              {draft.header}
            </p>
            <label htmlFor="body">Message</label>
            <textarea id="body" name="body" required maxLength={20_000} defaultValue={draft.body} style={{ minHeight: 260 }} />
            <p className="small muted">A footer saying it was sent automatically by the agency&apos;s system is added below.</p>
            <div className="actions">
              <button className="btn primary">Send recap</button>
            </div>
          </form>
        </>
      )}
    </main>
  );
}
