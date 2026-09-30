import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { confirmableItems, listInbound, listSuggestions } from "@/modules/crm/inbound";
import { SuggestionCard } from "./SuggestionCard";

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

const CLASS_LABEL: Record<string, [string, "ok" | "warn" | ""]> = {
  supplier_confirmation: ["Supplier confirmation", "ok"],
  supplier_commitment: ["Supplier commitment", "warn"],
  client_message: ["Client", ""],
  other: ["Other", ""],
};

export default async function Inbox({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const data = await withTenant(await getDb(), me.tenant, async (q) => ({
    messages: await listInbound(q, me.tenant, 50),
    pending: await listSuggestions(q, { source: "inbound_email", status: "pending" }),
    items: await confirmableItems(q),
    people: (await q.query<{ id: string; name: string }>("select id, name from people order by name")).rows,
  }));
  const bySubject = new Map(data.messages.map((m) => [m.id, m]));

  return (
    <main>
      <h1>Inbox</h1>
      <p className="lede">
        Mail forwarded to your workspace address, read by the agent. Suggestions change nothing until you accept them. Your address is on the{" "}
        <Link href="/integrations">Integrations</Link> page.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <h2>To confirm</h2>
      {data.pending.length === 0 && <p className="empty">Nothing waiting.</p>}
      {data.pending.map((s) => {
        const m = s.messageId ? bySubject.get(s.messageId) : undefined;
        return (
          <div key={s.id}>
            {m && (
              <div className="small muted" style={{ margin: "8px 0 4px" }}>
                <Link href={`/inbox/${m.id}`}>{m.subject || "(no subject)"}</Link> · {m.fromName ?? m.fromAddress} · {m.receivedAt.slice(0, 10)}
              </div>
            )}
            <SuggestionCard s={s} ctx={{ back: "/inbox", items: data.items, people: data.people }} />
          </div>
        );
      })}

      <h2>Messages</h2>
      {data.messages.length === 0 && <p className="empty">No mail yet. Forward a supplier confirmation to your inbound address to try it.</p>}
      {data.messages.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>From</th>
                <th>Subject</th>
                <th>Read as</th>
              </tr>
            </thead>
            <tbody>
              {data.messages.map((m) => {
                const [label, tone] = m.classification ? CLASS_LABEL[m.classification]! : [m.parseStatus === "queued" ? "Reading…" : m.parseStatus === "manual" ? "Needs you" : "Couldn't read", "warn" as const];
                return (
                  <tr key={m.id}>
                    <td>{m.receivedAt.slice(0, 16).replace("T", " ")}</td>
                    <td>{m.fromName ?? m.fromAddress}</td>
                    <td>
                      <Link href={`/inbox/${m.id}`}>{m.subject || "(no subject)"}</Link>
                      {m.attachments.length > 0 && <span className="muted small"> · {m.attachments.length} attachment{m.attachments.length > 1 ? "s" : ""}</span>}
                    </td>
                    <td>
                      <span className={`chip ${tone}`}>{label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
