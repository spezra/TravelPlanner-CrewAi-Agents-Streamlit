import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { confirmableItems, getInbound, listSuggestions } from "@/modules/crm/inbound";
import { reparseAction } from "../actions";
import { SuggestionCard } from "../SuggestionCard";

export const metadata = { title: "Message" };
export const dynamic = "force-dynamic";

export default async function Message({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const me = await requireMember();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const msg = await getInbound(q, me.tenant, id);
    if (!msg) return null;
    return {
      msg,
      suggestions: await listSuggestions(q, { messageId: id }),
      items: await confirmableItems(q),
      people: (await q.query<{ id: string; name: string }>("select id, name from people order by name")).rows,
    };
  });
  if (!data) notFound();
  const { msg } = data;
  const back = `/inbox/${msg.id}`;

  return (
    <main>
      <p className="small muted">
        <Link href="/inbox">Inbox</Link> /
      </p>
      <h1>{msg.subject || "(no subject)"}</h1>
      <p className="lede">
        From {msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress} · {msg.receivedAt.slice(0, 16).replace("T", " ")} UTC ·{" "}
        {msg.classification ? msg.classification.replace(/_/g, " ") : msg.parseStatus}
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {msg.parseStatus === "failed" && <p className="notice error">The agent couldn&apos;t read this message{msg.parseError ? ` (${msg.parseError})` : ""}.</p>}
      {(msg.parseStatus === "failed" || msg.parseStatus === "manual") && (
        <form action={reparseAction} className="card row">
          <input type="hidden" name="messageId" value={msg.id} />
          <span className="grow small muted">Handle it yourself below, or ask the agent to read it again.</span>
          <button className="btn">Read again</button>
        </form>
      )}

      <h2>Suggestions</h2>
      {data.suggestions.length === 0 && <p className="empty">None for this message.</p>}
      {data.suggestions.map((s) => (
        <SuggestionCard key={s.id} s={s} ctx={{ back, items: data.items, people: data.people }} />
      ))}

      <h2>Message</h2>
      <pre className="card small" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
        {msg.body || "(empty)"}
      </pre>
      {msg.attachments.length > 0 && (
        <div className="card small">
          <b>Attachments</b>
          <ul className="plain">
            {msg.attachments.map((a, i) => (
              <li key={`${a.name}:${i}`}>
                {a.key ? <a href={`/inbox/${msg.id}/attachments/${i}`}>{a.name}</a> : a.name} <span className="muted">· {Math.ceil(a.size / 1024)} KB</span>
                {a.skipped && <span className="chip warn"> not stored: {a.skipped}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
