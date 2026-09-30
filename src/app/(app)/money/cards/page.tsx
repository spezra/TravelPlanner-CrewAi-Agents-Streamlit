import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { moneyDeps } from "@/modules/money/deps";
import * as repo from "@/modules/money/repo";
import { createCardLinkAction, removeCardAction } from "../actions";
import { Flash, fmtDate, MoneyNav } from "../ui";

export const metadata = { title: "Money · Client cards" };
export const dynamic = "force-dynamic";

const brandName = (b: string) => ({ visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", jcb: "JCB", diners: "Diners Club", unionpay: "UnionPay" })[b] ?? b;

export default async function Cards({ searchParams }: { searchParams: Promise<{ client?: string; error?: string; ok?: string }> }) {
  const { client, error, ok } = await searchParams;
  const { member, tenant } = await requireMember();
  const stripeReady = moneyDeps().stripe !== null;
  const { clients, cards, setups } = await withTenant(await getDb(), tenant, async (q) => {
    const clients = (await q.query<{ id: string; name: string }>("select id, name from clients order by name")).rows;
    const selected = clients.find((c) => c.id === client);
    return {
      clients,
      cards: selected ? await repo.listPaymentMethods(q, selected.id) : [],
      setups: selected
        ? (await q.query<{ id: string; status: string; created_at: string }>("select id, status, created_at from money_card_setups where client_id = $1 order by created_at desc limit 5", [selected.id])).rows
        : [],
    };
  });
  const selected = clients.find((c) => c.id === client);
  const now = new Date();

  return (
    <main>
      <h1>Client cards</h1>
      <MoneyNav current="/money/cards" />
      <p className="lede">
        Cards are saved with Stripe, a PCI-certified provider. Clients enter them on Stripe&apos;s own page; this platform only ever holds the brand, last four
        digits and expiry.
      </p>
      <Flash error={error} ok={ok} />

      <form className="card row" method="get">
        <label htmlFor="client" className="grow" style={{ margin: 0 }}>
          Client
          <select id="client" name="client" className="field" defaultValue={selected?.id ?? ""}>
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn">Show</button>
      </form>

      {selected && (
        <>
          <h2>{selected.name}</h2>
          {cards.length === 0 ? (
            <p className="empty">No saved cards.</p>
          ) : (
            <div className="card">
              <ul className="plain">
                {cards.map((c) => {
                  const expired = new Date(Date.UTC(c.expYear, c.expMonth, 1)) <= now;
                  return (
                    <li key={c.id} className="row">
                      <span className="grow">
                        {brandName(c.brand)} •••• {c.last4}{" "}
                        <span className="small muted">
                          exp {String(c.expMonth).padStart(2, "0")}/{c.expYear} · saved {fmtDate(c.createdAt)}
                        </span>{" "}
                        {expired && <span className="chip alert">expired</span>}
                      </span>
                      {member.role !== "assistant" && (
                        <form action={removeCardAction}>
                          <input type="hidden" name="paymentMethodId" value={c.id} />
                          <input type="hidden" name="back" value={`/money/cards?client=${selected.id}`} />
                          <button className="btn small">Remove</button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {stripeReady ? (
            <form action={createCardLinkAction} className="card">
              <input type="hidden" name="clientId" value={selected.id} />
              <label htmlFor="email">Client&apos;s email (optional: we send the secure link; otherwise copy it from the confirmation)</label>
              <input id="email" name="email" type="email" />
              <div className="actions">
                <button className="btn primary">Create a secure card link</button>
              </div>
            </form>
          ) : (
            <p className="notice">Stripe isn&apos;t configured, so cards can&apos;t be collected yet.</p>
          )}
          {setups.length > 0 && (
            <p className="small muted">
              Recent links: {setups.map((s) => `${fmtDate(String(s.created_at))} (${s.status})`).join(", ")}
            </p>
          )}
        </>
      )}
    </main>
  );
}
