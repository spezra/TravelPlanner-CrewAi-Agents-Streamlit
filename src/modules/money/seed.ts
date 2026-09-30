/**
 * Demo money data (fictional): commission terms on the two hotels, a received
 * commission with a host-agency deduction on the confirmed one, payees, and
 * agreed split terms (a 20% share to the named backup plus a referral fee to an
 * outside specialist). Runs as app_system inside the main seed transaction.
 */
import type { Queryable } from "@/db/client";
import { DEMO } from "@/db/seed";

export const MONEY_DEMO = {
  workspaceRecipient: "00000000-0000-4000-8000-000000000601",
  backupRecipient: "00000000-0000-4000-8000-000000000602",
  specialistRecipient: "00000000-0000-4000-8000-000000000603",
  splitCdmx: "00000000-0000-4000-8000-000000000611",
} as const;

export async function seedMoney(q: Queryable, now: Date): Promise<void> {
  const d = DEMO;
  const m = MONEY_DEMO;
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  // Confirming with terms in place makes the trigger create the receivable.
  await q.query(
    `update trip_items set commission_rate_bps = 1000, commission_host_agency = 'Example Travel Collective'
      where id = any($1::uuid[])`,
    [[d.hotelCdmx, d.hotelOaxaca]],
  );

  await q.query(
    `insert into money_recipients (id, workspace_id, kind, member_id, name, email) values
      ($1, $4, 'workspace', null, 'Marisol Vega Travel', null),
      ($2, $4, 'member', $5, 'Lena Brandt', 'lena@example.com'),
      ($3, $4, 'external', null, 'Ana Ruiz (Oaxaca specialist)', 'ana.ruiz@example.org')`,
    [m.workspaceRecipient, m.backupRecipient, m.specialistRecipient, d.workspace, d.backup],
  );

  await q.query(
    `insert into money_splits (id, workspace_id, trip_id, item_id, reversal_loss_bearer, host_rules_ours, host_rules_theirs, status, agreed_by, agreed_at, created_by)
     values ($1, $2, $3, $4, 'pro_rata', 'permitted', 'permitted', 'agreed', $5, $6, $5)`,
    [m.splitCdmx, d.workspace, d.trip, d.hotelCdmx, d.expert, daysAgo(20)],
  );
  await q.query(
    `insert into money_split_shares (split_id, workspace_id, recipient_id, bps) values ($1, $2, $3, 8000), ($1, $2, $4, 2000)`,
    [m.splitCdmx, d.workspace, m.workspaceRecipient, m.backupRecipient],
  );
  await q.query(
    `insert into money_split_fees (split_id, workspace_id, recipient_id, kind, amount_minor, currency) values ($1, $2, $3, 'referral', 25000, 'USD')`,
    [m.splitCdmx, d.workspace, m.specialistRecipient],
  );

  const { rows } = await q.query<{ id: string }>("select id from money_receivables where item_id = $1", [d.hotelCdmx]);
  const receivable = rows[0]?.id;
  if (!receivable) return;
  await q.query(
    `insert into money_receipt_events (workspace_id, receivable_id, kind, amount_minor, landed_in, at, note, source) values
      ($1, $2, 'received', 112000, 'external_account', $3, 'Host statement, September', 'manual'),
      ($1, $2, 'host_deduction', -11200, null, $3, 'Host agency fee (10%)', 'manual')`,
    [d.workspace, receivable, daysAgo(3)],
  );
}
