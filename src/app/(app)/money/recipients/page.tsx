import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { moneyDeps } from "@/modules/money/deps";
import * as repo from "@/modules/money/repo";
import { addRecipientAction, onboardAction, refreshRecipientAction, settlementDetailsAction } from "../actions";
import { Flash, label, MoneyNav } from "../ui";

export const metadata = { title: "Money · Payees" };
export const dynamic = "force-dynamic";

const TONE = { not_started: "", pending: "warn", restricted: "alert", enabled: "ok" } as const;

export default async function Recipients({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { member, tenant } = await requireMember();
  const canWrite = member.role !== "assistant";
  const stripeReady = moneyDeps().stripe !== null;
  const { recipients, members } = await withTenant(await getDb(), tenant, async (q) => ({
    recipients: await repo.listRecipients(q),
    members: (await q.query<{ id: string; name: string }>("select id, name from members where disabled_at is null order by name")).rows,
  }));
  const available = members.filter((m) => !recipients.some((r) => r.memberId === m.id));

  return (
    <main>
      <h1>Payees</h1>
      <MoneyNav current="/money/recipients" />
      <p className="lede">
        Who gets paid: members and outside collaborators. Payees onboarded with Stripe can receive transfers when commission is collected into the platform
        balance; everyone else is paid by settlement instruction to the details on file (stored encrypted).
      </p>
      <Flash error={error} ok={ok} />
      {!stripeReady && <p className="notice">Stripe isn&apos;t configured, so every payout is made by settlement instruction.</p>}

      {recipients.length === 0 && <p className="empty">No payees yet.</p>}
      {recipients.map((r) => (
        <section key={r.id} className="card">
          <div className="row">
            <h3 className="grow">
              {r.name} <span className="small muted">· {r.kind === "workspace" ? "this workspace (retained share)" : label(r.kind)}</span>
            </h3>
            {r.kind !== "workspace" && <span className={`chip ${TONE[r.onboardingStatus]}`}>Stripe: {label(r.onboardingStatus)}</span>}
          </div>
          <div className="small muted">
            {r.email ?? "no email"} · payment details {r.hasSettlementDetails ? "on file" : "not on file"}
            {r.lastPayoutFailure && <span className="chip alert"> last bank payout failed: {r.lastPayoutFailure}</span>}
          </div>
          {canWrite && r.kind !== "workspace" && (
            <>
              <div className="actions">
                {stripeReady && r.onboardingStatus !== "enabled" && (
                  <form action={onboardAction}>
                    <input type="hidden" name="recipientId" value={r.id} />
                    <button className="btn">{r.stripeAccountId ? "Send a fresh onboarding link" : "Invite to Stripe payouts"}</button>
                  </form>
                )}
                {stripeReady && r.stripeAccountId && (
                  <form action={refreshRecipientAction}>
                    <input type="hidden" name="recipientId" value={r.id} />
                    <button className="btn">Refresh status</button>
                  </form>
                )}
              </div>
              <details>
                <summary className="small">Payment details for settlement instructions</summary>
                <form action={settlementDetailsAction}>
                  <input type="hidden" name="recipientId" value={r.id} />
                  <label htmlFor={`details-${r.id}`}>Bank / remittance details as the payer should use them (replaces what is on file; leave empty to remove)</label>
                  <textarea id={`details-${r.id}`} name="details" placeholder="Account name, IBAN / account and routing number, bank, SWIFT" />
                  <div className="actions">
                    <button className="btn">Save details</button>
                  </div>
                </form>
              </details>
            </>
          )}
        </section>
      ))}

      {canWrite && (
        <>
          <h2>Add a payee</h2>
          <form action={addRecipientAction} className="card">
            <label htmlFor="memberId">A member of this workspace</label>
            <select id="memberId" name="memberId" className="field" defaultValue="">
              <option value="">— someone outside the workspace —</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <div className="grid2">
              <div>
                <label htmlFor="name">Name (for outside collaborators)</label>
                <input id="name" name="name" type="text" />
              </div>
              <div>
                <label htmlFor="email">Email</label>
                <input id="email" name="email" type="email" />
              </div>
            </div>
            <div className="actions">
              <button className="btn primary">Add payee</button>
            </div>
          </form>
        </>
      )}
    </main>
  );
}
