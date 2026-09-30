-- Money: receivables ledger, statement reconciliation, split terms and
-- allocation, payout batches (owner-approved), settlement instructions,
-- Stripe Connect recipients and a token-only card vault.
--
-- Rules the schema enforces, not just the code:
--   * A confirmed trip item with commission terms gets exactly one expected
--     receivable (trigger below, idempotent on item_id).
--   * Adjustments (host deductions, short payments, FX, reversals, dispute
--     holds) are receipt events on the receivable, so the net that is split is
--     always the adjusted amount.
--   * Only a workspace owner can move a payout batch or line past "prepared"
--     (row-level security, in addition to the service check). Assistants can
--     prepare batches and read the ledger; they cannot record money facts.
--   * The card vault holds Stripe payment-method ids and display metadata
--     (brand, last4, expiry). There is no column that could hold a card number.
--
-- Join with the network slice: money_splits.collaboration_ref holds the id of
-- the collaboration whose fee lines produced the split (collaborations /
-- collaboration_fee_lines are owned by that slice). There is deliberately no
-- foreign key, so either slice can ship and migrate independently; the split
-- rows are a snapshot of the agreed terms for one booking line.

-- Commission terms captured on the booking line.
alter table trip_items add column commission_rate_bps int check (commission_rate_bps between 0 and 10000);
alter table trip_items add column commission_amount_minor bigint check (commission_amount_minor >= 0);
alter table trip_items add column commission_expected_by date;
alter table trip_items add column commission_host_agency text;

-- The member's role in the current workspace (null outside a tenant transaction).
create or replace function money_role() returns text language sql stable as
  $$ select role from members where id = app_member() and workspace_id = app_workspace() $$;
grant execute on function money_role() to app_user, app_system;

-- ---------------------------------------------------------------------------
-- Receivables

create table money_receivables (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  item_id uuid not null references trip_items(id) on delete cascade,
  line_no int not null default 1,
  -- Supplier and confirmation number are read live from trip_items (they often
  -- arrive or change after confirmation), so there is nothing here to go stale.
  -- Eventual settlement path, copied from the item's credentials at confirmation.
  commission_recipient text,
  host_agency text,
  basis text not null check (basis in ('rate', 'amount')),
  rate_bps int,
  expected_minor bigint not null check (expected_minor >= 0),
  currency text not null,
  expected_by date,
  created_at timestamptz not null default now(),
  unique (item_id, line_no)
);
create index on money_receivables (workspace_id);

create table money_receipt_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  receivable_id uuid not null references money_receivables(id) on delete cascade,
  kind text not null check (kind in ('received', 'host_deduction', 'short_payment', 'fx', 'reversal', 'dispute_hold')),
  -- Signed, in the receivable's currency. Positive for received; negative for deductions and reversals.
  amount_minor bigint not null,
  original_currency text,
  original_amount_minor bigint,
  fx_rate numeric(18, 8),
  -- Where received money actually landed. Only platform_balance funds automatic transfers.
  landed_in text check (landed_in in ('platform_balance', 'external_account')),
  at timestamptz not null,
  note text,
  source text not null default 'manual' check (source in ('manual', 'statement', 'stripe')),
  source_ref text,
  created_by uuid references members(id),
  created_at timestamptz not null default now(),
  check (kind <> 'received' or (amount_minor > 0 and landed_in is not null)),
  check (kind not in ('host_deduction', 'short_payment', 'reversal') or amount_minor < 0),
  check (kind <> 'fx' or (original_currency is not null and original_amount_minor is not null and fx_rate is not null)),
  check (amount_minor <> 0)
);
create index on money_receipt_events (receivable_id);
create unique index money_receipt_events_source on money_receipt_events (workspace_id, source, source_ref) where source_ref is not null;

-- Creates the expected receivable for a confirmed item with commission terms.
-- Security invoker: runs with the caller's row-level security, so it can only
-- create receivables in the caller's own workspace.
create or replace function money_ensure_receivable() returns trigger language plpgsql as $$
begin
  if new.state = 'confirmed' and (new.commission_amount_minor is not null
      or (new.commission_rate_bps is not null and new.price_minor is not null)) then
    insert into money_receivables (workspace_id, trip_id, item_id, commission_recipient, host_agency,
                                   basis, rate_bps, expected_minor, currency, expected_by)
    values (new.workspace_id, new.trip_id, new.id,
            new.credentials ->> 'commissionRecipient', coalesce(new.commission_host_agency, new.credentials ->> 'bookingEntity'),
            case when new.commission_amount_minor is not null then 'amount' else 'rate' end,
            new.commission_rate_bps,
            coalesce(new.commission_amount_minor, round(new.price_minor::numeric * new.commission_rate_bps / 10000)::bigint),
            coalesce(new.currency, 'USD'),
            coalesce(new.commission_expected_by, (coalesce(new.ends_at, new.starts_at, now()) + interval '60 days')::date))
    on conflict (item_id, line_no) do nothing;
  end if;
  return new;
end $$;

create trigger money_receivable_on_confirm
  after insert or update of state, commission_rate_bps, commission_amount_minor on trip_items
  for each row execute function money_ensure_receivable();

-- ---------------------------------------------------------------------------
-- Commission statements from host agencies

create table money_statement_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  file_name text not null,
  file_hash text not null,
  host_agency text,
  row_count int not null,
  matched_count int not null,
  imported_by uuid not null references members(id),
  imported_at timestamptz not null default now(),
  unique (workspace_id, file_hash)
);

create table money_statement_rows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  import_id uuid not null references money_statement_imports(id) on delete cascade,
  row_no int not null,
  confirmation_ref text,
  supplier text,
  guest text,
  amount_minor bigint not null,
  deduction_minor bigint not null default 0,
  currency text not null,
  status text not null check (status in ('matched', 'unmatched', 'manual', 'ignored')),
  reason text,
  receivable_id uuid references money_receivables(id),
  matched_by uuid references members(id),
  unique (import_id, row_no)
);

-- ---------------------------------------------------------------------------
-- Payees and split terms

create table money_recipients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  kind text not null check (kind in ('workspace', 'member', 'external')),
  member_id uuid references members(id),
  name text not null,
  email text,
  stripe_account_id text,
  onboarding_status text not null default 'not_started' check (onboarding_status in ('not_started', 'pending', 'restricted', 'enabled')),
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  -- Encrypted payee bank/remittance details, used only on settlement instructions.
  settlement_details_enc text,
  last_payout_failure text,
  created_at timestamptz not null default now(),
  check (kind <> 'member' or member_id is not null)
);
create unique index money_recipients_workspace_self on money_recipients (workspace_id) where kind = 'workspace';
create unique index money_recipients_member on money_recipients (workspace_id, member_id) where member_id is not null;
create index on money_recipients (stripe_account_id);

create table money_splits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  item_id uuid not null references trip_items(id) on delete cascade unique,
  collaboration_ref text,
  -- Who bears a loss if commission is reversed after it was allocated.
  reversal_loss_bearer text not null default 'pro_rata' check (reversal_loss_bearer in ('pro_rata', 'owner_workspace')),
  -- Host agreements govern whether commission may be shared; both sides are checked before agreeing.
  host_rules_ours text not null default 'unknown' check (host_rules_ours in ('unknown', 'permitted', 'not_permitted')),
  host_rules_theirs text not null default 'unknown' check (host_rules_theirs in ('unknown', 'permitted', 'not_permitted')),
  status text not null default 'draft' check (status in ('draft', 'agreed')),
  agreed_by uuid references members(id),
  agreed_at timestamptz,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table money_split_shares (
  split_id uuid not null references money_splits(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  recipient_id uuid not null references money_recipients(id),
  bps int not null check (bps between 0 and 10000),
  primary key (split_id, recipient_id)
);

create table money_split_fees (
  id uuid primary key default gen_random_uuid(),
  split_id uuid not null references money_splits(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  recipient_id uuid not null references money_recipients(id),
  kind text not null check (kind in ('advisory', 'design', 'referral', 'execution')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null
);

-- ---------------------------------------------------------------------------
-- Payouts

create table money_payout_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  currency text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'processing', 'completed', 'canceled')),
  prepared_by uuid not null references members(id),
  prepared_at timestamptz not null default now(),
  approved_by uuid references members(id),
  approved_at timestamptz,
  completed_at timestamptz,
  check (status in ('draft', 'canceled') or approved_by is not null)
);

create table money_payout_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  batch_id uuid references money_payout_batches(id),
  receivable_id uuid references money_receivables(id),
  split_id uuid references money_splits(id),
  fee_id uuid references money_split_fees(id),
  recipient_id uuid not null references money_recipients(id),
  kind text not null check (kind in ('commission_share', 'commission_adjustment', 'advisory', 'design', 'referral', 'execution')),
  -- Signed: a negative adjustment is owed back by the recipient.
  amount_minor bigint not null,
  currency text not null,
  status text not null default 'pending'
    check (status in ('retained', 'pending', 'approved', 'sending', 'settled', 'instructed', 'failed', 'reversed', 'canceled')),
  method text check (method in ('platform_transfer', 'settlement_instruction')),
  stripe_transfer_id text unique,
  reversed_minor bigint not null default 0,
  failure text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create unique index money_payout_lines_share on money_payout_lines (receivable_id, recipient_id) where kind = 'commission_share';
create unique index money_payout_lines_fee on money_payout_lines (fee_id) where fee_id is not null;
create index on money_payout_lines (batch_id);

create table money_settlement_instructions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  payout_line_id uuid not null unique references money_payout_lines(id),
  payer_name text not null,
  payer_email text,
  payee_name text not null,
  payee_email text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  reference text not null,
  purpose text not null,
  status text not null default 'issued' check (status in ('issued', 'settled', 'canceled')),
  issued_at timestamptz not null default now(),
  emailed_at timestamptz,
  settled_at timestamptz,
  settled_by uuid references members(id)
);

-- Loss and reversal records: who bore what, and why.
create table money_adjustments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  kind text not null check (kind in ('transfer_reversal', 'commission_reallocation')),
  receivable_id uuid references money_receivables(id),
  payout_line_id uuid references money_payout_lines(id),
  recipient_id uuid references money_recipients(id),
  amount_minor bigint not null,
  currency text not null,
  borne_by text not null check (borne_by in ('pro_rata', 'owner_workspace', 'recipient')),
  source_ref text,
  note text,
  at timestamptz not null default now()
);
create unique index money_adjustments_source on money_adjustments (workspace_id, source_ref) where source_ref is not null;

-- ---------------------------------------------------------------------------
-- Card vault (tokens and display metadata only)

create table money_stripe_customers (
  client_id uuid primary key references clients(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  stripe_customer_id text not null unique
);

create table money_card_setups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  client_id uuid not null references clients(id) on delete cascade,
  checkout_session_id text unique,
  url text,
  status text not null default 'open' check (status in ('open', 'completed', 'expired')),
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table money_payment_methods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  client_id uuid not null references clients(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_payment_method_id text not null unique,
  brand text not null,
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  exp_month int not null check (exp_month between 1 and 12),
  exp_year int not null,
  created_at timestamptz not null default now(),
  removed_at timestamptz
);

-- Platform-level: inbound Stripe events, deduplicated by event id.
create table money_stripe_events (
  id text primary key,
  type text not null,
  account text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text
);

-- ---------------------------------------------------------------------------
-- Row-level security

do $$
declare t text;
begin
  foreach t in array array['money_receivables','money_receipt_events','money_statement_imports','money_statement_rows','money_recipients',
    'money_splits','money_split_shares','money_split_fees','money_payout_batches','money_payout_lines','money_settlement_instructions',
    'money_adjustments','money_stripe_customers','money_card_setups','money_payment_methods']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_user, app_system', t);
    execute format('create policy system_all on %I to app_system using (true) with check (true)', t);
  end loop;
end $$;

alter table money_stripe_events enable row level security;
alter table money_stripe_events force row level security;
grant select, insert, update, delete on money_stripe_events to app_system;
create policy system_all on money_stripe_events to app_system using (true) with check (true);

-- Receivables inherit trip visibility. Any member with the trip may create one
-- (the confirmation trigger runs as whoever confirmed); only owners, advisors
-- and admins may change one. Nobody deletes ledger rows.
create policy tenant_read on money_receivables for select to app_user
  using (workspace_id = app_workspace() and exists (select 1 from trips t where t.id = trip_id));
create policy tenant_insert on money_receivables for insert to app_user
  with check (workspace_id = app_workspace() and exists (select 1 from trips t where t.id = trip_id));
create policy tenant_update on money_receivables for update to app_user
  using (workspace_id = app_workspace() and exists (select 1 from trips t where t.id = trip_id) and money_role() in ('owner', 'advisor', 'admin'))
  with check (workspace_id = app_workspace());

-- Money facts (receipts, statements, splits, adjustments): read by the workspace, written by owners/advisors/admins.
do $$
declare t text;
begin
  foreach t in array array['money_receipt_events','money_statement_rows']
  loop
    execute format('create policy tenant_read on %I for select to app_user using (workspace_id = app_workspace() and (receivable_id is null or exists (select 1 from money_receivables r where r.id = receivable_id)))', t);
  end loop;
  foreach t in array array['money_statement_imports','money_recipients','money_splits','money_split_shares','money_split_fees',
    'money_payout_batches','money_payout_lines','money_settlement_instructions','money_adjustments']
  loop
    execute format('create policy tenant_read on %I for select to app_user using (workspace_id = app_workspace())', t);
  end loop;
  foreach t in array array['money_receipt_events','money_statement_imports','money_statement_rows','money_recipients','money_splits',
    'money_split_shares','money_split_fees','money_settlement_instructions','money_adjustments']
  loop
    execute format('create policy tenant_insert on %I for insert to app_user with check (workspace_id = app_workspace() and money_role() in (''owner'', ''advisor'', ''admin''))', t);
    execute format('create policy tenant_update on %I for update to app_user using (workspace_id = app_workspace() and money_role() in (''owner'', ''advisor'', ''admin'')) with check (workspace_id = app_workspace())', t);
  end loop;
  foreach t in array array['money_split_shares','money_split_fees']
  loop
    execute format('create policy tenant_delete on %I for delete to app_user using (workspace_id = app_workspace() and money_role() in (''owner'', ''advisor'', ''admin''))', t);
  end loop;
end $$;

-- Payout batches and lines: anyone in the workspace may prepare (draft/pending);
-- only an owner may write anything past that. Money is a human gate.
create policy tenant_insert on money_payout_batches for insert to app_user
  with check (workspace_id = app_workspace() and (status = 'draft' or money_role() = 'owner'));
create policy tenant_update on money_payout_batches for update to app_user
  using (workspace_id = app_workspace() and (status = 'draft' or money_role() = 'owner'))
  with check (workspace_id = app_workspace() and (status in ('draft', 'canceled') or money_role() = 'owner'));
create policy tenant_insert on money_payout_lines for insert to app_user
  with check (workspace_id = app_workspace() and (status in ('pending', 'retained') or money_role() = 'owner'));
create policy tenant_update on money_payout_lines for update to app_user
  using (workspace_id = app_workspace() and (status in ('pending', 'retained') or money_role() = 'owner'))
  with check (workspace_id = app_workspace() and (status in ('pending', 'retained') or money_role() = 'owner'));

-- Card vault: visible exactly when the client is. Card rows are written only by
-- the Stripe webhook (app_system); members may mark one removed.
create policy tenant_read on money_payment_methods for select to app_user
  using (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id));
create policy tenant_update on money_payment_methods for update to app_user
  using (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id) and money_role() in ('owner', 'advisor', 'admin'))
  with check (workspace_id = app_workspace());
do $$
declare t text;
begin
  foreach t in array array['money_stripe_customers','money_card_setups']
  loop
    execute format('create policy tenant_read on %I for select to app_user using (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id))', t);
    execute format('create policy tenant_insert on %I for insert to app_user with check (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id))', t);
    execute format('create policy tenant_update on %I for update to app_user using (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id)) with check (workspace_id = app_workspace())', t);
  end loop;
end $$;
