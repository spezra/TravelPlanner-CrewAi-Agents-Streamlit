-- Trips slice: trip management, executable approvals with client acceptance,
-- booking execution through provider adapters (Duffel, manual suppliers),
-- inbound Duffel webhooks and the token-authenticated client portal.

-- ---------------------------------------------------------------------------
-- Trip items: provider linkage and execution bookkeeping.

-- Which rail holds the reservation and its identifier there (Duffel order id,
-- manual task id). The traveler-facing confirmation number stays in confirmation_ref.
alter table trip_items add column provider text;
alter table trip_items add column provider_ref text;
-- Non-sensitive snapshot of the supplier offer the item will be booked from
-- (Duffel offer id, total, expiry, itinerary summary, fare conditions).
alter table trip_items add column booking_offer jsonb;
-- Traveler details the rail needs (names, dates of birth, contact). Encrypted with the workspace key.
alter table trip_items add column booking_request_enc text;
-- Internal notes for the expert and their team. Encrypted; never shown on the client portal.
alter table trip_items add column internal_notes_enc text;
-- Set when a booking or cancellation job is queued, cleared when it finishes; stops double-queueing.
alter table trip_items add column execution_requested_at timestamptz;
-- Last reason execution was blocked or failed, shown to the team.
alter table trip_items add column last_execution_note text;
alter table trip_items add column updated_at timestamptz not null default now();
create index trip_items_provider_ref on trip_items (provider, provider_ref) where provider_ref is not null;

create index execution_attempts_provider_ref on execution_attempts (provider, provider_ref) where provider_ref is not null;
create index execution_attempts_item on execution_attempts (item_id, updated_at desc);

-- Approvals: who asked (member), and when a re-quote replaced this one.
alter table approvals add column requested_by_member uuid references members(id);
alter table approvals add column superseded_by uuid references approvals(id);

-- ---------------------------------------------------------------------------
-- Manual confirmations: suppliers with no API (direct-to-property, DMCs by email).
-- Submitting creates a pending task; the booking stays outcome-unknown until a
-- person records the supplier's confirmation number or that no reservation exists.
create table manual_confirmations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  item_id uuid not null references trip_items(id) on delete cascade,
  action text not null check (action in ('book', 'cancel')),
  attempt_key text not null,
  status text not null check (status in ('pending', 'confirmed', 'not_found')),
  channel text not null,
  supplier_name text,
  confirmation_ref text,
  note text,
  rounds int not null default 1,
  recorded_by uuid references members(id),
  recorded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, attempt_key)
);
create index manual_confirmations_trip on manual_confirmations (trip_id, status);

-- ---------------------------------------------------------------------------
-- Client portal links: revocable, expiring, stored as a sha256 of the token.
create table trip_portal_links (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references members(id),
  label text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index trip_portal_links_trip on trip_portal_links (trip_id);

-- A client's acceptance of a proposal on the portal. Recorded against the exact
-- terms shown; it never authorizes spend (the expert's approval still does).
create table approval_client_acceptances (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  approval_id uuid not null references approvals(id) on delete cascade,
  trip_id uuid not null references trips(id) on delete cascade,
  portal_link_id uuid references trip_portal_links(id) on delete set null,
  accepted_name text not null,
  terms_fingerprint text not null,
  price_minor bigint not null,
  currency text not null,
  accepted_at timestamptz not null default now(),
  unique (approval_id)
);

-- ---------------------------------------------------------------------------
-- Inbound provider webhooks, deduplicated by the provider's event id. Platform
-- table: written only from webhook handlers running as app_system.
create table provider_webhook_events (
  provider text not null,
  event_id text not null,
  event_type text not null,
  workspace_id uuid references workspaces(id) on delete cascade,
  status text not null default 'processing' check (status in ('processing', 'processed', 'ignored')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- Row-level security.

do $$
declare t text;
begin
  foreach t in array array['manual_confirmations','trip_portal_links','approval_client_acceptances']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_user, app_system', t);
    -- Children of a trip are visible exactly when the trip is (the subquery is itself filtered by the trips policy).
    execute format('create policy tenant on %I to app_user using (workspace_id = app_workspace() and exists (select 1 from trips t where t.id = trip_id)) with check (workspace_id = app_workspace())', t);
    execute format('create policy system_all on %I to app_system using (true) with check (true)', t);
  end loop;
end $$;

alter table provider_webhook_events enable row level security;
alter table provider_webhook_events force row level security;
grant select, insert, update, delete on provider_webhook_events to app_system;
create policy system_all on provider_webhook_events to app_system using (true) with check (true);
