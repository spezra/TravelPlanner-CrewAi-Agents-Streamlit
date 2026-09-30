import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import * as repo from "@/modules/money/repo";
import { agreeSplitAction, reopenSplitAction, saveCommissionTerms, saveSplitAction } from "../actions";
import { Flash, label, money, MoneyNav, plainAmount } from "../ui";

export const metadata = { title: "Money · Commission & splits" };
export const dynamic = "force-dynamic";

interface ItemRow {
  id: string;
  title: string;
  state: string;
  trip_title: string;
  price_minor: number | null;
  currency: string | null;
  commission_rate_bps: number | null;
  commission_amount_minor: number | null;
  commission_expected_by: string | Date | null;
  commission_host_agency: string | null;
}

const day = (v: string | Date | null) => (v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export default async function Terms({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { member, tenant } = await requireMember();
  const canWrite = member.role !== "assistant";
  const { items, splits, recipients } = await withTenant(await getDb(), tenant, async (q) => ({
    items: (
      await q.query<ItemRow>(
        `select i.id, i.title, i.state, t.title as trip_title, i.price_minor, i.currency, i.commission_rate_bps, i.commission_amount_minor,
                i.commission_expected_by, i.commission_host_agency
           from trip_items i join trips t on t.id = i.trip_id
          where i.state <> 'canceled' order by t.starts_on nulls last, t.title, i.position`,
      )
    ).rows,
    splits: await repo.listSplits(q),
    recipients: await repo.listRecipients(q),
  }));
  const payees = recipients.filter((r) => r.kind !== "workspace");
  const name = (id: string) => recipients.find((r) => r.id === id)?.name ?? "—";
  const back = "/money/terms";

  return (
    <main>
      <h1>Commission &amp; splits</h1>
      <MoneyNav current="/money/terms" />
      <p className="lede">
        Commission terms on each booking line, and how its commission is shared. Shares and fees are what the experts agreed; the platform never suggests a
        &ldquo;fair&rdquo; split. Fixed advisory, design, referral and execution fees are paid as their own lines, not carved out of commission.
      </p>
      <Flash error={error} ok={ok} />
      {items.length === 0 && <p className="empty">No booking lines visible to you.</p>}

      {items.map((it) => {
        const split = splits.find((s) => s.itemId === it.id);
        const cur = it.currency ?? "USD";
        const others = split?.shares.filter((s) => payees.some((p) => p.id === s.recipientId)) ?? [];
        return (
          <section key={it.id} className="card">
            <div className="row">
              <span className="chip">{label(it.state)}</span>
              <h3 className="grow">
                {it.title}
                <span className="small muted"> · {it.trip_title}</span>
              </h3>
              <span className="small">{it.price_minor != null ? money(it.price_minor, cur) : "no price"}</span>
            </div>
            <div className="small muted">
              Commission:{" "}
              {it.commission_amount_minor != null
                ? money(it.commission_amount_minor, cur)
                : it.commission_rate_bps != null
                  ? `${(it.commission_rate_bps / 100).toFixed(2)}%`
                  : "not set"}
              {it.commission_host_agency ? ` · host ${it.commission_host_agency}` : ""}
              {split && (
                <>
                  {" · "}
                  split{" "}
                  <span className={`chip ${split.status === "agreed" ? "ok" : "warn"}`}>{split.status}</span>{" "}
                  {split.shares.map((s) => `${name(s.recipientId)} ${(s.bps / 100).toFixed(2)}%`).join(", ")}
                  {split.fees.map((f) => ` · ${label(f.kind)} fee ${money(f.amountMinor, f.currency)} to ${name(f.recipientId)}`).join("")}
                  {` · reversal loss: ${split.reversalLossBearer === "pro_rata" ? "shared pro rata" : "owning workspace"}`}
                  {split.collaborationRef ? ` · collaboration ${split.collaborationRef}` : ""}
                </>
              )}
            </div>

            {canWrite && (
              <details>
                <summary className="small">Commission terms</summary>
                <form action={saveCommissionTerms} className="grid2">
                  <input type="hidden" name="itemId" value={it.id} />
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="currency" value={cur} />
                  <div>
                    <label htmlFor={`basis-${it.id}`}>Basis</label>
                    <select id={`basis-${it.id}`} name="basis" className="field" defaultValue={it.commission_amount_minor != null ? "amount" : "rate"}>
                      <option value="rate">Percent of price</option>
                      <option value="amount">Fixed amount ({cur})</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`value-${it.id}`}>Percent or amount</label>
                    <input
                      id={`value-${it.id}`}
                      name="value"
                      type="text"
                      inputMode="decimal"
                      required
                      defaultValue={
                        it.commission_amount_minor != null
                          ? plainAmount(it.commission_amount_minor, cur)
                          : it.commission_rate_bps != null
                            ? String(it.commission_rate_bps / 100)
                            : ""
                      }
                    />
                  </div>
                  <div>
                    <label htmlFor={`host-${it.id}`}>Host agency (paying party)</label>
                    <input id={`host-${it.id}`} name="hostAgency" type="text" defaultValue={it.commission_host_agency ?? ""} />
                  </div>
                  <div>
                    <label htmlFor={`by-${it.id}`}>Expected by (default: 60 days after travel)</label>
                    <input id={`by-${it.id}`} name="expectedBy" type="date" defaultValue={day(it.commission_expected_by)} />
                  </div>
                  <div className="actions">
                    <button className="btn">Save terms</button>
                  </div>
                </form>
              </details>
            )}

            {canWrite && split?.status !== "agreed" && (
              <details>
                <summary className="small">{split ? "Edit split terms (draft)" : "Share this commission"}</summary>
                {payees.length === 0 ? (
                  <p className="small muted">Add payees first (Money → Payees).</p>
                ) : (
                  <form action={saveSplitAction}>
                    <input type="hidden" name="itemId" value={it.id} />
                    <input type="hidden" name="back" value={back} />
                    <p className="small muted">Shares to others, in percent. The workspace keeps the remainder.</p>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="row">
                        <select name={`shareRecipient${i}`} className="field grow" defaultValue={others[i]?.recipientId ?? ""} aria-label="Payee">
                          <option value="">—</option>
                          {payees.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <input name={`sharePct${i}`} type="text" inputMode="decimal" placeholder="%" aria-label="Share percent" defaultValue={others[i] ? String(others[i]!.bps / 100) : ""} style={{ maxWidth: 90 }} />
                      </div>
                    ))}
                    <p className="small muted">Fixed fees, paid separately from commission.</p>
                    {[0, 1].map((i) => (
                      <div key={i} className="row">
                        <select name={`feeRecipient${i}`} className="field grow" defaultValue={split?.fees[i]?.recipientId ?? ""} aria-label="Fee payee">
                          <option value="">—</option>
                          {payees.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <select name={`feeKind${i}`} className="field" defaultValue={split?.fees[i]?.kind ?? "advisory"} aria-label="Fee kind" style={{ maxWidth: 140 }}>
                          <option value="advisory">Advisory</option>
                          <option value="design">Design</option>
                          <option value="referral">Referral</option>
                          <option value="execution">Execution</option>
                        </select>
                        <input name={`feeAmount${i}`} type="text" inputMode="decimal" placeholder="Amount" aria-label="Fee amount" defaultValue={split?.fees[i] ? plainAmount(split.fees[i]!.amountMinor, split.fees[i]!.currency) : ""} style={{ maxWidth: 120 }} />
                        <input name={`feeCurrency${i}`} type="text" defaultValue={split?.fees[i]?.currency ?? cur} aria-label="Fee currency" maxLength={3} style={{ maxWidth: 70 }} />
                      </div>
                    ))}
                    <div className="grid2">
                      <div>
                        <label htmlFor={`bearer-${it.id}`}>If commission is reversed after it was shared</label>
                        <select id={`bearer-${it.id}`} name="reversalLossBearer" className="field" defaultValue={split?.reversalLossBearer ?? "pro_rata"}>
                          <option value="pro_rata">Everyone bears it in proportion to their share</option>
                          <option value="owner_workspace">Our workspace bears it</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`collab-${it.id}`}>Collaboration reference (optional)</label>
                        <input id={`collab-${it.id}`} name="collaborationRef" type="text" defaultValue={split?.collaborationRef ?? ""} />
                      </div>
                      <div>
                        <label htmlFor={`ours-${it.id}`}>Our host agreement allows sharing commission</label>
                        <select id={`ours-${it.id}`} name="hostRulesOurs" className="field" defaultValue={split?.hostRulesOurs ?? "unknown"}>
                          <option value="unknown">Not yet checked</option>
                          <option value="permitted">Checked: permitted</option>
                          <option value="not_permitted">Checked: not permitted</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`theirs-${it.id}`}>Their host agreement allows it</label>
                        <select id={`theirs-${it.id}`} name="hostRulesTheirs" className="field" defaultValue={split?.hostRulesTheirs ?? "unknown"}>
                          <option value="unknown">Not yet checked</option>
                          <option value="permitted">Checked: permitted</option>
                          <option value="not_permitted">Checked: not permitted</option>
                        </select>
                      </div>
                    </div>
                    <div className="actions">
                      <button className="btn">Save draft</button>
                    </div>
                  </form>
                )}
              </details>
            )}

            {canWrite && split && (
              <form action={split.status === "agreed" ? reopenSplitAction : agreeSplitAction} className="actions">
                <input type="hidden" name="splitId" value={split.id} />
                <input type="hidden" name="back" value={back} />
                {split.status === "agreed" ? (
                  <button className="btn">Reopen terms</button>
                ) : (
                  <button className="btn primary">Agree these terms</button>
                )}
              </form>
            )}
          </section>
        );
      })}
    </main>
  );
}
